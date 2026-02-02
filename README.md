<div align="center">
  <img src="/.github/header.png" title="Happier Dev" alt="Happier Dev"/>

  ### Open-source mobile, web, and desktop companion for AI coding agents  
  **Secure • Collaborative • Self-hostable**
  
  Run Claude Code, Codex, Gemini, OpenCode (and more) on your computer<br />and continue seamlessly from your phone, browser, or desktop app.
  
  **End-to-end encrypted. Zero-knowledge. Built by developers, for developers.**
</div>

## Happier is not released, yet!

Make sure to star the repo and [subscribe to the announcements channel](https://github.com/happier-dev/happier/discussions/categories/announcements) to be informed as soon as it's out.

You can also [join the Discord](https://discord.gg/y7KwpakY) channel to ask any questions or report any issues that you might have.

This project exists because we needed it ourselves - and we want it to evolve through real feedback. We aim to keep the community welcoming, and contributor-friendly, whether you’re signaling an issue or proposing a larger idea.

If something feels broken, missing, or awkward — **we really want to hear about it**.
Happier grows through shared experience and collaboration.

## What is Happier?

**Happier** is an open-source, end-to-end encrypted companion app for AI coding agents.

It lets you run AI coding sessions **locally on your computer**, then **continue and control them remotely** — from your phone, web UI, or desktop app — without losing context.

Typical use cases include:
- checking long-running refactors while away from your desk,
- approving permissions or responding to agent questions from your phone,
- resuming sessions after restarts,
- collaborating with teammates in the same AI session.

Whether you’re stepping away for a coffee or switching devices mid-task, Happier keeps your AI coding sessions alive and accessible.


## Why “Happier”?

Happier started as a **fork of [Happy](https://github.com/slopus/happy)**.

We were using Happy daily for work and genuinely loved the concept.  
Over time, though, we needed:

- faster iteration,
- stronger reliability,
- better session lifecycle handling,
- and features that weren’t available yet.

So we started building them for ourselves.

After weeks of refining, fixing, and extending the foundation, we decided to share Happier so others could try it, use it, and help shape what comes next.

> Happier is not about replacing Happy.  
> We originally started as contributors to Happy, submitting fixes, improvements, and new features upstream. Over time, we realized that our own needs required faster iteration and a more collaborative model than we could comfortably explore within the main project.
> 
> Happier is about exploring a faster-moving, more collaborative direction — in the open — while remaining deeply grateful for the foundation Happy provided. 


## Key Features

- **Collaborative sessions**  
  Share a live session with teammates or friends (private or public links).

- **Broad provider support**  
  Works with **Claude Code, Codex, Gemini, OpenCode**, and more (configurable).

- **Persistent sessions**  
  Resume sessions even after restarts; archive them and return later as if they never ended.

- **Seamless switching**  
  Move between terminal, web UI, and mobile while keeping full context.

- **Subscriptions or API keys**  
  Use existing provider subscriptions where supported, or configure API keys directly.

- **Infinite history**  
  Scroll back through older messages in long-running sessions.

- **Pending message queue**  
  Edit, reorder, or remove queued messages before the agent processes them.

- **tmux support**  
  Resume remote-started sessions locally (Claude).


## Security & Privacy

Happier is designed with privacy as a foundation, not an afterthought.

- **End-to-end encryption**  
  Built using modern cryptography (TweetNaCl).

- **Zero-knowledge architecture**  
  Your code is encrypted on your devices before it ever hits the wire.  
  Servers cannot read your data. Encryption keys never leave your devices.

- **Built in Switzerland**  
  Developed in Switzerland, with a strong focus on data protection and developer transparency.


## How It Works

### Step 1: Download App

<a href="https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758537388"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=dev.happier.app"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>

### Step 2: Install the CLI on your computer

```bash
npm install -g @happier-dev/cli
```

### Step 3: Start using `happier` instead of `claude`, `codex` or `opencode`

```bash

# Instead of: claude
# Use: happier

happier

# Instead of: codex
# Use: happier codex

happier codex

# Instead of: opencode
# Use: happier opencode

happier opencode

```

### Step 4: Be a Happier developer

Code solo, or invite a friend to jump into the session with you.
Happier acts as a secure bridge between your local development environment and your other devices.

## Community-Driven

**Happier** is completely open-source. We built this because we wanted a more powerful, more social way to interact with AI agents - and we want to build it in the open, shaped by the people who actually use it.

This project exists because we needed it ourselves - and we want it to evolve through real feedback. We aim to keep the community welcoming, and contributor-friendly, whether you’re signaling an issue or proposing a larger idea. You are always welcome, whether you’re reporting a small bug or proposing a larger idea.

What that means in practice:
* **Open development** and transparent discussions
* **Fast feedback loops** on issues and pull requests
* A focus on **solving real developer pain**, not chasing hype

If something feels broken, missing, or awkward — we want to hear about it.
Happier grows through shared experience and collaboration.

## Project Structure
* apps/ui/ – mobile, web, and desktop clients
* apps/cli/ – Happier CLI wrapper for AI coding agents
* apps/server/ – encrypted relay / self-hosted backend

## Contributing

Contributions are welcome.

Whether it’s:
- a bug fix,
- a small UX improvement,
- or a larger architectural idea,

please feel free to open an issue or pull request.
We try to keep discussions constructive, respectful, and focused on real usage.

See CONTRIBUTING.md for development setup and guidelines.

## License

MIT License — see LICENSE￼ for details.

⸻

Not affiliated with or endorsed by Anthropic, OpenAI, or Google.

Code faster. Code together. Be Happier.
