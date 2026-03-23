<div align="center">
  <img src="/.github/header.png" title="Happier Dev" alt="Happier Dev"/>

  ### Open-source mobile, web, and desktop companion for AI coding agents  
  **Secure • Collaborative • Self-hostable**
  
  Run Claude Code, Codex, Gemini, OpenCode (and more) on your computer<br />and continue seamlessly from your phone, browser, or desktop app.
  
  **End-to-end encrypted. Zero-knowledge. Built by developers, for developers.**
</div>

## Happier is in alpha preview stage: https://discord.gg/W6Pb8KuHfg

**It means that it is not fully stable yet.** We are iterating fast and adding new features, improvements and bug fixes constantly.

Make sure to star the repo and [subscribe to the announcements channel](https://github.com/happier-dev/happier/discussions/categories/announcements) to be informed of all the latest changes.

You can also [join the Discord](https://discord.gg/W6Pb8KuHfg) channel to ask any questions or report any issues that you might have.

### We want to hear your feedback!

This project exists because we needed it ourselves, and **we want it to evolve through real feedback**. We aim to keep the community welcoming, and contributor-friendly, whether you’re signaling an issue or proposing a larger idea.

If something feels broken, missing, or awkward, **we really want to hear about it**.
Happier grows through shared experience and collaboration.

Learn more about the best ways to contribute in [CONTRIBUTING.md](CONTRIBUTING.md).

## What is Happier?

**Happier** is an open-source, end-to-end encrypted companion app for AI coding agents.

It lets you run AI coding sessions **locally on your computer**, then **continue and control them remotely** — from your phone, web UI, or desktop app, without losing context.

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

> **Happier is not about replacing Happy**
> We originally started as contributors to Happy, submitting fixes, improvements, and new features upstream. Over time, we realized that our own needs required faster iteration that we could not comfortably explore within the main project. Happier is about exploring a faster-moving, more collaborative direction, while remaining deeply grateful for the foundation Happy provided. 


## Key Features

- **Collaborative sessions**  
  Share a live session with teammates or friends (private or public links).

- **Broad provider support**  
  Works with **Claude Code, Codex, Gemini, OpenCode, Kilo, Kimi, Qwen, Augment** (and more over time).

- **Multi-server support**  
  Use personal/work/self-hosted servers side-by-side, switch quickly, and keep auth scoped per server.

- **Git-aware file browser + operations**  
  Review changed files and diffs in-session, with optional experimental Git write actions (stage/unstage/commit/pull/push/revert).

- **Persistent sessions**  
  Resume sessions even after restarts; archive them and return later as if they never ended.

- **Seamless switching**  
  Move between terminal, web UI, and mobile while keeping full context.

- **Steering + pending queue controls**  
  Steer compatible sessions while they are running, or queue/edit/reorder messages before processing.

- **Mode/model/permission controls**  
  Pick model and mode per session (provider-capability dependent), and choose explicit permission behavior.

- **Server feature toggles**  
  Server owners can disable selected capabilities (for example social/voice/bug reports) so users only see what is enabled in their environment.

- **Voice options (cloud, BYO, local)**  
  Use Happier Voice, your own ElevenLabs account, or local OpenAI-compatible STT/TTS (including device STT/TTS where available).

- **Smart notification routing**  
  Notification taps open the correct session and server context automatically.

- **In-app bug reports**  
  Submit bug reports from settings, optionally attach diagnostics, and let teams disable report upload flows when required.

- **tmux support**  
  Resume remote-started sessions locally (Claude).


## Security & Privacy

Happier is designed with privacy as a foundation, not an afterthought.

- **End-to-end encryption**  
  Built using modern cryptography (TweetNaCl).

- **Zero-knowledge architecture**  
  Your code is encrypted on your devices before it ever hits the wire.  
  Servers cannot read your data. Encryption keys never leave your devices.

- **Built with love from Switzerland**  
  Developed in Switzerland, with a strong focus on data protection and developer transparency.


## How It Works

### Step 1: Download App

<a href="https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758554297"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/apps/testing/dev.happier.app"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>

#### Android APK

[Download the APK](https://github.com/happier-dev/happier/releases/download/ui-mobile-preview/happier-preview.apk) from the releases page.

### Step 2: Install the CLI on your computer

```bash
npm install -g @happier-dev/cli@next
```

### Step 3: Authenticate (recommended: mobile-first)

```bash
happier auth login
```

Recommended first run:
- Prefer **mobile** when asked about it, so your account and secret key are then securely stored on your mobile device.
- If you already use Happier on another device, sign in with that same account.
- If you open the terminal-connect link while logged out, Happier will send you through sign in/create account and then return you to terminal approval.

### Step 4: Start using `happier` instead of `claude`, `codex` or `opencode`

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

# More providers:
happier gemini
happier kilo
happier kimi
happier qwen

```

### Step 5: Be a Happier developer

Code solo, or invite a friend to jump into the session with you.
Happier acts as a secure bridge between your local development environment and your other devices.

## Architecture & Components

- Relay Server: 
  - store the sessions, message and settings
  - allows to communicate between the UI/app and the machines daemons
  - can be [self-hosted](https://docs.happier.dev/deployment) or you can use the Happier Cloud relay server at `api.happier.dev` and the hosted web UI at https://app.happier.dev
- Machine Daemon: 
  - manage the sessions and LLM processes on a machine
  - this is the long-running background process that allows you to start new sessios and manage sessions remotely
  - it communicates with the UI/app through the relay server
- UI/app: 
  - native mobile app
  - web UI (self-hosted or app.happier.dev)
  - desktop app
  - it communicates with the daemon through the relay server
  - it receive daemon updates (sessions updates, messages, etc) through the relay server

## Self-Hosting the Server Relay

Happier is 100% self-hostable. It's even the most recommended way to run it, even if we also offer an end-to-end encrypted cloud server (app.happier.dev / api.happier.dev).

Think of the relay server as the long-running process which allows your mobile device/UI to connect to your machines. It stores all your sessions, messages and settings.

### On your computer - self-install

It is lightweight, and can run as a simple service on your computer. You can then access it from your mobile devices using Tailscale Serve (as long as your computer is running).

Simply run the [self-host guided setup](https://docs.happier.dev/deployment/self-host-runtime) on your computer:
```
curl -fsSL https://happier.dev/self-host-preview | bash
```

By default is uses an SQLite database.

### Docker

The relay server can also run on a docker container, using the pre-built images or building from source:
- https://docs.happier.dev/deployment/docker

### Proxmox

Thanks to our community, you can also easily install Happier in Proxmox using helper scripts:
- https://docs.happier.dev/deployment/proxmox

## Running from source

The repo default branch is `dev` and may be unstable. For a more "stable" base, use `preview` or `main`:

```bash
git clone --branch preview https://github.com/happier-dev/happier.git
yarn install
```

From the monorepo root, the `yarn` scripts run in **repo-local mode** (stackless + isolated per checkout).
These scripts wrap `hstack` with repo-local defaults so you can run from source safely.

Most-used commands:

- `yarn dev`: local dev stack (server + UI + daemon)
- `yarn tui`, `yarn tui:with-mobile`: dev stack in the integrated TUI (logs + controls)
- `yarn build`, `yarn start`, `yarn stop`: prod-like build/start/stop flows
- `yarn auth login`, `yarn daemon`, `yarn happier`: auth + daemon + CLI flows
- `yarn env list|set|unset`: manage persisted env vars for your repo-local stack
- `yarn logs`, `yarn logs:all|server|expo|ui|daemon|service`: stream/select logs
- `yarn service:*`: install/manage OS service
- `yarn tailscale:*`: configure/query Tailscale Serve URL
- `yarn mobile`, `yarn mobile:install`, `yarn mobile-dev-client`: mobile workflows
- `yarn providers`, `yarn eas`, `yarn setup`, `yarn remote`, `yarn self-host`, `yarn menubar`: advanced workflows

[Run from a monorepo clone docs](./apps/docs/content/docs/deployment/repo-local.mdx)

Arguments:

- Forward extra flags/args with `--` (Yarn v1), for example:
  - `yarn logs -- --component=daemon --lines 200 --no-follow`
  - `yarn auth login -- --method=mobile --no-open`
  - `yarn service:enable -- --auth-now -- --method=web --webapp=hosted`

`hstack` and `npx`:

- To run `hstack`/`happier` from any terminal using this clone, run `yarn cli:activate`.
- You can run published `hstack` via `npx` (for example `npx --yes -p @happier-dev/stack@latest hstack <command>`), but that is **not** the same as repo-local wrappers from this checkout.

## Documentation

- [Getting started](https://docs.happier.dev/getting-started/onboarding)
- [Installing Claude Code, Codex, OpenCode and other providers CLIs](https://docs.happier.dev/providers)
- [Installing and using the CLI](https://docs.happier.dev/clients/cli)
- [What is the daemon and how to install it?](https://docs.happier.dev/clients/daemon)
- [Happier Voice](https://docs.happier.dev/features/voice)
- [macOS Menubar](https://docs.happier.dev/hstack/menubar)
- [Configuring authentication on your self-hosted server](https://docs.happier.dev/server/auth)
- [Configuring encryption on your self-hosted server](https://docs.happier.dev/server/encryption)
- hstack workflows: [hstack docs index](./apps/docs/content/docs/hstack/index.mdx)
- Deployment options:
  - [Deployment overview](./apps/docs/content/docs/deployment/index.mdx)
  - [Self-host runtime](./apps/docs/content/docs/deployment/self-host-runtime.mdx)
  - [Docker](./apps/docs/content/docs/deployment/docker.mdx)
  - [Proxmox](./apps/docs/content/docs/deployment/proxmox.mdx)

## Community-Driven

**Happier** is completely open-source. We built this because we wanted a more powerful, more social way to interact with AI agents - and we want to build it in the open, shaped by the people who actually use it.

This project exists because we needed it ourselves - and we want it to evolve through real feedback. We aim to keep the community welcoming, and contributor-friendly, whether you’re signaling an issue or proposing a larger idea. You are always welcome, whether you’re reporting a small bug or proposing a larger idea.

What that means in practice:
* **Open development** and transparent discussions
* **Fast feedback loops** on issues and pull requests
* A focus on **solving real developer pain**, not chasing hype

If something feels broken, missing, or awkward, **we want to hear about it**.
Happier grows through shared experience and collaboration.

## Project Structure
* apps/ui/ – mobile, web, and desktop clients
* apps/cli/ – Happier CLI wrapper for AI coding agents
* apps/server/ – encrypted relay / self-hosted backend

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT License — see [LICENSE](LICENCE) for details.

⸻

Not affiliated with or endorsed by Anthropic, OpenAI, or Google.

Code faster. Code together. Be Happier.
