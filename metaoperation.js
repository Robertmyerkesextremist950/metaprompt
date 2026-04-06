require('dotenv').config();
const OpenAI = require('openai');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
function log(...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}

const MODEL = 'anthropic/claude-opus-4-5';

let _client;
function getClient() {
  if (!_client) _client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  return _client;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ClassifySchema = z.object({
  reasoning: z.string(),
  operationType: z.enum(['metaprompt', 'normal', 'rewrite']),
  confidence: z.enum(['high', 'medium', 'low'])
});

const ExtractContextSchema = z.object({
  reasoning: z.string(),
  relevantMessageIds: z.array(z.number()),
  relevantThreadIds: z.array(z.number()),
  newThreadName: z.string().nullable(),
});

const ExtractTargetRewriteSchema = z.object({
  reasoning: z.string(),
  targetMessageId: z.number(),
  newContent: z.string(),
  rewriteIntent: z.string(),
});

const ExtractTargetMetapromptSchema = z.object({
  reasoning: z.string(),
  mutationPlan: z.string(),
  affectedThreadIds: z.array(z.number()),
  affectedMessageIds: z.array(z.number()),
  createsNewThread: z.boolean(),
  createsNewMessages: z.boolean()
});

const GenerateMutationMetapromptSchema = z.object({
  reasoning: z.string(),
  script: z.string()
});

function enforceStrict(schema) {
  if (schema && typeof schema === 'object') {
    if (schema.type === 'object' && schema.properties) {
      schema.additionalProperties = false;
      if (!schema.required) schema.required = Object.keys(schema.properties);
      for (const v of Object.values(schema.properties)) enforceStrict(v);
    }
    if (schema.anyOf) schema.anyOf.forEach(enforceStrict);
    if (schema.allOf) schema.allOf.forEach(enforceStrict);
  }
  return schema;
}

function buildResponseFormat(schema) {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  enforceStrict(jsonSchema);
  return { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: jsonSchema } };
}

function parseResponse(schema, raw) {
  log('[raw llm output]', raw);
  return schema.parse(JSON.parse(raw));
}

// ─── Step 1: Classify ─────────────────────────────────────────────────────────

async function stepClassify(chats, threads, userRequest) {
  log('[step-1 classify input]', { userRequest });

  const threadIndex = threads.map(({ th_id, name }) => ({ th_id, name }));
  const systemPrompt = `You are classifying a user request into one of three operation types.

State summary:
- Total messages: ${chats.length}
- Threads: ${JSON.stringify(threadIndex)}

Operation types:
- metaprompt: structural/organizational mutations — creating threads, moving messages, reorganizing. Use this if the request mentions "new thread", "create a thread", "put this in a thread", or any explicit thread/organizational action.
- normal: user is asking a question or continuing a conversation and expects an assistant reply. No thread creation or structural change.
- rewrite: user wants to rewrite, expand, summarize, or rephrase part of an existing message (may reference it by description or by pasting the text).

When in doubt between metaprompt and normal: if the request mentions a thread by name or says to put something "in a thread", it is metaprompt.`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: buildResponseFormat(ClassifySchema),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userRequest }
    ]
  });

  const result = parseResponse(ClassifySchema, res.choices[0].message.content);
  log('[step-1 classify result]', result);
  return result;
}

// ─── Step 2: Extract Context ──────────────────────────────────────────────────

async function stepExtractContext(chats, threads, userRequest) {
  log('[step-2 extract-context input]');

  const threadIndex = threads.map(({ th_id, name, context }) => ({ th_id, name, context }));
  const systemPrompt = `You are identifying which messages and threads are relevant to a user request, and deciding whether the response should go into a new thread.

Full state:
${JSON.stringify({ chats, threads: threadIndex }, null, 2)}

Return the message IDs and thread IDs that are relevant to the user's request. Include IDs that are directly referenced or clearly needed to fulfill the request.

Also decide whether the response warrants a new thread. Set newThreadName to a short descriptive name if:
- The request introduces a distinct new topic not covered by existing threads
- The expected response will be long or structured (a list, a breakdown, a reference document)
- The response would feel out of place appended to the current conversation flow

Set newThreadName to null if:
- The request is a direct follow-up to the current conversation
- The answer is short or conversational
- An existing thread already covers this topic`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 512,
    response_format: buildResponseFormat(ExtractContextSchema),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userRequest }
    ]
  });

  const result = parseResponse(ExtractContextSchema, res.choices[0].message.content);
  log('[step-2 extract-context result]', result);
  return result;
}

// ─── Step 3: Extract Target ───────────────────────────────────────────────────

async function stepExtractTargetRewrite(chats, step2Result, userRequest) {
  const scopedChats = chats.filter(m => step2Result.relevantMessageIds.includes(m.id));

  const systemPrompt = `You are identifying which message to rewrite and producing the replacement content.

Relevant messages:
${JSON.stringify(scopedChats, null, 2)}

The user wants to rewrite or transform part of one of these messages. Identify which message (by id) is the target, and produce the complete new content for that message. Fulfill the user's instruction while preserving any parts of the message not being changed.`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 16000,
    response_format: buildResponseFormat(ExtractTargetRewriteSchema),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userRequest }
    ]
  });

  const result = parseResponse(ExtractTargetRewriteSchema, res.choices[0].message.content);
  log('[step-3 extract-target-rewrite result]', result);
  return result;
}

async function stepExtractTargetMetaprompt(chats, threads, step2Result, userRequest) {
  const scopedChats = chats.filter(m => step2Result.relevantMessageIds.includes(m.id));
  const threadIndex = threads.map(({ th_id, name, context }) => ({ th_id, name, context }));

  const systemPrompt = `You are determining the precise targets of a structural state mutation.

Relevant messages:
${JSON.stringify(scopedChats, null, 2)}

Relevant thread IDs: ${JSON.stringify(step2Result.relevantThreadIds)}
Thread index: ${JSON.stringify(threadIndex)}

Describe the exact mutation plan: which threads/messages will be created, modified, or deleted.`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    response_format: buildResponseFormat(ExtractTargetMetapromptSchema),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userRequest }
    ]
  });

  const result = parseResponse(ExtractTargetMetapromptSchema, res.choices[0].message.content);
  log('[step-3 extract-target-metaprompt result]', result);
  return result;
}

async function stepExtractTarget(operationType, chats, threads, step2Result, userRequest) {
  log('[step-3 extract-target input]', { operationType });

  if (operationType === 'metaprompt') {
    return await stepExtractTargetMetaprompt(chats, threads, step2Result, userRequest);
  } else if (operationType === 'rewrite') {
    return await stepExtractTargetRewrite(chats, step2Result, userRequest);
  } else {
    return { targetType: 'chat_append' };
  }
}

// ─── Step 4: Generate Mutation ────────────────────────────────────────────────

async function stepGenerateMutationMetaprompt(chats, threads, step3Result) {
  const nextMsgId = arr => Math.max(...arr.map(m => m.id), 0) + 1;
  const nextThId  = arr => Math.max(...arr.map(t => t.th_id), 0) + 1;

  const systemPrompt = `You are writing a JavaScript function body that mutates chat state in place.

Mutation plan: ${step3Result.mutationPlan}

State shape:
- chats: { id: number, role: "user"|"assistant", content: string }[]
- threads: { th_id: number, name: string, context: number[] }[]

Rules:
- Args are: chats, threads, nextMsgId, nextThId
- Mutate them in place (push, splice, assignment, etc.)
- ALWAYS call nextMsgId(chats) for new message IDs — never hardcode
- ALWAYS call nextThId(threads) for new thread IDs — never hardcode
- ALWAYS find threads by th_id: threads.find(t => t.th_id === X) — never by array index
- ALWAYS deduplicate before appending IDs to an existing context: only push IDs not already present
- No imports, no globals, no return statement needed

Current state snapshot:
${JSON.stringify({ chats, threads }, null, 2)}`;

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    response_format: buildResponseFormat(GenerateMutationMetapromptSchema),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: step3Result.mutationPlan }
    ]
  });

  const result = parseResponse(GenerateMutationMetapromptSchema, res.choices[0].message.content);
  log('[step-4 script]', result.script);

  new Function('chats', 'threads', 'nextMsgId', 'nextThId', result.script)
    (chats, threads, nextMsgId, nextThId);

  return result;
}

async function stepGenerateMutationNormal(chats, threads, step2Result, userRequest, activeThreadId) {
  const nextMsgId = arr => Math.max(...arr.map(m => m.id), 0) + 1;

  const history = chats
    .filter(m => step2Result.relevantMessageIds.includes(m.id))
    .map(m => ({ role: m.role, content: m.content }));

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [
      ...history,
      { role: 'user', content: userRequest }
    ]
  });

  if (res.choices[0].message.refusal) {
    throw new Error(`Model refused: ${res.choices[0].message.refusal}`);
  }

  const userMsg = { id: nextMsgId(chats), role: 'user', content: userRequest };
  chats.push(userMsg);
  const assistantMsg = { id: nextMsgId(chats), role: 'assistant', content: res.choices[0].message.content };
  chats.push(assistantMsg);

  const newIds = [userMsg.id, assistantMsg.id];

  if (step2Result.newThreadName) {
    const nextThId = arr => Math.max(...arr.map(t => t.th_id), 0) + 1;
    threads.push({ th_id: nextThId(threads), name: step2Result.newThreadName, context: newIds });
    log('[step-4 new thread created]', step2Result.newThreadName);
  } else if (activeThreadId != null) {
    const thread = threads.find(t => t.th_id === activeThreadId);
    if (thread) {
      for (const id of newIds) {
        if (!thread.context.includes(id)) thread.context.push(id);
      }
    }
  }

  log('[step-4 normal response]', assistantMsg.content);
  return { content: assistantMsg.content };
}

function stepGenerateMutationRewrite(chats, step3Result) {
  const msg = chats.find(m => m.id === step3Result.targetMessageId);
  if (!msg) throw new Error(`targetMessageId ${step3Result.targetMessageId} not found in chats`);
  msg.content = step3Result.newContent;
  log('[step-4 rewrite applied]', { targetMessageId: step3Result.targetMessageId });
}

async function stepGenerateMutation(operationType, chats, threads, step2Result, step3Result, userRequest, activeThreadId) {
  log('[step-4 generate-mutation input]', { operationType });

  if (operationType === 'metaprompt') {
    return await stepGenerateMutationMetaprompt(chats, threads, step3Result);
  } else if (operationType === 'normal') {
    return await stepGenerateMutationNormal(chats, threads, step2Result, userRequest, activeThreadId);
  } else {
    return stepGenerateMutationRewrite(chats, step3Result);
  }
}

// ─── Context resolution ───────────────────────────────────────────────────────

async function resolveContext(chats, threads, userRequest, activeThreadId, useAiContext) {
  if (useAiContext) {
    log('[context] using AI-extracted context from full conversation');
    return await stepExtractContext(chats, threads, userRequest);
  }
  const thread = threads.find(t => t.th_id === activeThreadId);
  const ids = thread ? thread.context : chats.map(m => m.id);
  log('[context] using active thread context', ids);
  return {
    relevantMessageIds: ids,
    relevantThreadIds: thread ? [thread.th_id] : [],
    newThreadName: null,
  };
}

// ─── Normal mode (direct, no pipeline) ───────────────────────────────────────

async function runNormal(chats, threads, userRequest, activeThreadId, useAiContext) {
  log('=== normal start ===');
  log('[request]', userRequest);

  const nextMsgId = arr => Math.max(...arr.map(m => m.id), 0) + 1;
  const nextThId  = arr => Math.max(...arr.map(t => t.th_id), 0) + 1;

  const step2 = await resolveContext(chats, threads, userRequest, activeThreadId, useAiContext);
  const history = chats
    .filter(m => step2.relevantMessageIds.includes(m.id))
    .map(m => ({ role: m.role, content: m.content }));

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 16000,
    messages: [...history, { role: 'user', content: userRequest }]
  });

  if (res.choices[0].message.refusal) throw new Error(`Model refused: ${res.choices[0].message.refusal}`);

  const userMsg = { id: nextMsgId(chats), role: 'user', content: userRequest };
  chats.push(userMsg);
  const assistantMsg = { id: nextMsgId(chats), role: 'assistant', content: res.choices[0].message.content };
  chats.push(assistantMsg);

  const newIds = [userMsg.id, assistantMsg.id];

  if (step2.newThreadName) {
    threads.push({ th_id: nextThId(threads), name: step2.newThreadName, context: newIds });
    log('[normal] new thread created', step2.newThreadName);
  } else {
    const thread = threads.find(t => t.th_id === activeThreadId);
    if (thread) {
      for (const id of newIds) {
        if (!thread.context.includes(id)) thread.context.push(id);
      }
    }
  }

  log('[normal response]', assistantMsg.content);
  log('=== normal end ===');
  return { operationType: 'normal', chats, threads };
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function runPipeline(chats, threads, userRequest, activeThreadId, useAiContext) {
  log('=== pipeline start ===');
  log('[request]', userRequest);
  log('[state before]', { chats, threads });

  const step1 = await stepClassify(chats, threads, userRequest);
  const { operationType } = step1;

  const step2 = await resolveContext(chats, threads, userRequest, activeThreadId, useAiContext);
  const step3 = await stepExtractTarget(operationType, chats, threads, step2, userRequest);
  await stepGenerateMutation(operationType, chats, threads, step2, step3, userRequest, activeThreadId);

  log('[state after]', { chats, threads });
  log('=== pipeline end ===');

  return { operationType, chats, threads };
}

async function metaoperate(chats, threads, userRequest, activeThreadId, isMeta, useAiContext) {
  if (isMeta) return runPipeline(chats, threads, userRequest, activeThreadId, useAiContext);
  return runNormal(chats, threads, userRequest, activeThreadId, useAiContext);
}

module.exports = { metaoperate, log };

// ─── Demos ────────────────────────────────────────────────────────────────────

if (require.main === module) {
const { chats, threads } = require('./metapromptdata');

log(`[log file] ${logFile}`);

// Demo 1: metaprompt — create a new thread with cultural content
/*
metaoperate(chats, threads,
  "open a new thread with all cultural content about Paris")
  .then(r => { log('[demo1 done]', r); })
  .catch(err => { log('[demo1 error]', err); console.error(err); });
*/

// Demo 2: metaprompt — summarize into a new thread
/*
metaoperate(chats, threads,
  "summarise the museum messages into a single new message and put it in a new thread called 'Museums Summary'")
  .then(r => { log('[demo2 done]', r); })
  .catch(err => { log('[demo2 error]', err); console.error(err); });
*/

// Demo 3: metaprompt — add relevant IDs to an existing thread
metaoperate(chats, threads,
  "what would thread 122 need from the population messages to better answer population questions? append the relevant IDs to thread 122")
  .then(r => { log('[demo3 done]', r); })
  .catch(err => { log('[demo3 error]', err); console.error(err); });

// Demo 4: normal — continue conversation
/*
metaoperate(chats, threads,
  "which of the sightseeing spots is best for families with kids?")
  .then(r => { log('[demo4 done]', r); })
  .catch(err => { log('[demo4 error]', err); console.error(err); });
*/

// Demo 5: rewrite — natural language target
/*
metaoperate(chats, threads,
  "rewrite the part about museums to focus on modern art")
  .then(r => { log('[demo5 done]', r); })
  .catch(err => { log('[demo5 error]', err); console.error(err); });
*/

// Demo 6: rewrite — pasted content
/*
metaoperate(chats, threads,
  "expand this: 'The Louvre for classical art, Musée d'Orsay for Impressionism, and Centre Pompidou for modern art.'")
  .then(r => { log('[demo6 done]', r); })
  .catch(err => { log('[demo6 error]', err); console.error(err); });
*/
}
