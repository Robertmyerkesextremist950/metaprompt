# Metaprompt

> **Don't generate messages. Shape thoughts in clean context.**

A local interface for editing AI conversations as structured context.
Reorganize, summarize, and branch into focused threads.

![Demo](./docs/metaprompt.png)

---

## Why

Chat is the wrong abstraction for serious thinking.

What you say first is rarely what you mean. 
Meaning emerges through iteration. A feedback loop between you and the model. 
Chat breaks that loop: context degrades, ideas mix, structure is lost.

With Metaprompt, you don't scroll back and copy-paste. You reshape the conversation. Move messages, branch topics, summarize threads—then ask your next question against clean context.

Prompt to explore. Metaprompt to uncover better questions.

---

## How It Works

All messages live in **Main**—your complete conversation history.

**Threads** branch off to isolate specific topics with clean, focused context.

```
┌─────────────────────────────────────────────────┐
│                     MAIN                        │
│  (all messages live here)                       │
└───────┬─────────────────┬─────────────────┬─────┘
        │                 │                 │
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │ Thread A│       │ Thread B│       │ Thread C│
   │(Museums)│       │(Philosophy)     │(Summary)│
   └─────────┘       └─────────┘       └─────────┘
```

### Three Modes

| Mode | Purpose |
|------|---------|
| **Normal** | Standard chat in Main or any thread |
| **`/meta`** | Restructure conversations using natural language |
| **`/aicontext`** | Automatically pulls relevant context from Main and all threads for your next prompt |

---

## Examples

```
/meta put all discussion about museums into a new thread

/meta summarize this thread into "Key Points"

/meta group everything about philosophy into a new thread

/aicontext what themes connect all threads?
```

Combine both in a single command:

```
/meta /aicontext make a summary of all my enquiries, focusing on the museums I mentioned
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- An [OpenRouter](https://openrouter.ai/) API key

### Install

```bash
git clone https://github.com/OpenSpurCom/metaprompt
cd metaprompt
npm install
```

### Configure

Create a `.env` file in the project root:

```
OPENROUTER_API_KEY=your_key_here
PORT=3000
```

### Run

```bash
node index.js
```

Open [http://localhost:3000](http://localhost:3000)

---

## Tech Stack

- Node.js / Express
- Vanilla JS frontend
- OpenRouter API (swap in any OpenAI-compatible provider)

---

## Status

⚠️ **Experimental prototype**

- Single-user only
- In-memory (no persistence between sessions)
- Not production-ready

This is a working exploration of a different interaction model for AI.

**Do not expose this directly to the public internet.**

---

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.

---

## License

[MIT](./LICENSE)