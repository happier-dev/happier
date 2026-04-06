<div align="center">
  <img src="/.github/logotype-dark.png" title="Happier Dev" alt="Happier Dev" width="280" />

  ### Open-source mobile, web, and desktop companion for AI coding agents
  
  Run Claude Code, Codex, Gemini, OpenCode (and more) on your computer<br />and continue seamlessly from your phone, browser, or desktop app.

  <p><img src="/.github/supported-ai-providers.png" title="Happier Dev" alt="Happier Dev" width="320" /></p>
  
  **Claude, Codex, OpenCode mobile client · Voice assistant<br />
  Full Git client · File editor · Subagents · Session sharing<br />
  Entreprise-ready**

  End-to-end encrypted. Self-hostable.<br />
  Built by developers, for developers.

  <p><img src="/.github/illustration.png" title="Happier Dev" alt="Happier Dev" width="650" /></p>
</div>

## Happier is in alpha preview stage: https://discord.gg/W6Pb8KuHfg

We are iterating fast and adding new features, improvements and bug fixes constantly.

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

Whether you’re stepping away for a coffee or switching devices mid-task, Happier keeps your AI coding sessions alive and accessible.

## Installation

### Step 1: Download App

#### iOS

<a href="https://apps.apple.com/us/app/happier-claude-codex-opencode/id6758554297"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>

#### Play Store

Play Store app is in private beta, to access it:
1. Join the [Happier Google Group](https://groups.google.com/g/happier-dev)
2. Join the private beta [from Android](https://play.google.com/store/apps/details?id=dev.happier.app) or [from the web](https://play.google.com/apps/testing/dev.happier.app)

#### Android APK

[Download the APK](https://github.com/happier-dev/happier/releases/download/ui-mobile-preview/happier-preview-android.apk)

### Step 2: Install the CLI on your computer

```bash
curl -fsSL https://happier.dev/install | bash
```

Windows:
```
iwr https://happier.dev/install.ps1 -useb | iex
```

If you specifically want the npm package instead of the installer-managed lanes:

```bash
npm install -g @happier-dev/cli
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

## Why “Happier”?

We originally started as contributors to [Happy](https://github.com/slopus/happy), submitting fixes, improvements, and new features upstream. 

We were using it daily for work and genuinely loved the concept.  
Over time, we realized that our own needs required faster iteration that we could not comfortably explore within the main project.

So we started building them for ourselves.

After weeks of refining, fixing, and extending the foundation, we decided to share Happier so others could try it, use it, and help shape what comes next.

Happier is about exploring a faster-moving, more collaborative direction, while remaining deeply grateful for the foundation Happy provided. We loved and still love Happy. ❤️ Happier would not exist without it.

## Key Features

- **Broad provider support**<br />
  Works with **Claude Code, Codex, OpenCode, Gemini, GitHub Copilot, Kiro, Pi, Kilo, Kimi, Qwen, Augment**, and any custom ACP-compatible CLI — all from one unified interface.

- **Browse, follow, and take over existing sessions**<br />
  Open any existing Codex, Claude, or OpenCode session on your machine directly in Happier, follow a live session started outside the app in real time, or take control and import it into Happier with full continuity.

- **Session forking and replay**<br />
  Fork a session at any message without losing context. Uses provider-native forking when available (OpenCode, Codex); falls back to Happier Replay for any provider.

- **Session handoff between machines**<br />
  Move a live session — including provider state and project directory — to another machine. The same session ID stays in place; the active machine changes.

- **Attach to a running session**<br />
  Start a session from the app and later reconnect to it in your terminal with `happier attach`, or the other way around — switch between local CLI control and remote app control at any time.

- **Persistent sessions**<br />
  Resume sessions after restarts; archive and return to them later. Supports tmux-backed resume for terminal-started sessions.

- **Seamless switching**<br />
  Move between terminal, desktop app, web, and mobile while keeping full session context. Multi-device continuity is built in.

- **Collaborative sessions**<br />
  Share a live session with teammates or via view-only public links. Friends can be added by username directly in the app.

- **Agents, subagents, and Claude teams**<br />
  Launch parallel review, plan, or delegate runs from any session. Create and manage Claude teams, send messages to individual teammates, and monitor all subagents from the Agents panel.

- **Voice assistant — a real AI colleague, not just speech-to-text**<br />
  The voice agent is a first-class assistant backed by the same action system as the UI and CLI. It monitors all your running sessions, can switch focus between them, reads pending permission requests and answers them on your behalf, sends messages to any session you dictate to, and discusses what your agents are doing with full access to recent session context. Every action it can take maps to a Happier action that can be individually approval-gated. Runs on a daemon-backed AI brain (Claude or any configured backend) or a local OpenAI-compatible endpoint, with ElevenLabs realtime, BYO ElevenLabs, Kokoro neural TTS, and device/Google STT as the voice layer.

- **Inbox**<br />
  A global attention center for permission requests, user-action prompts (`AskUserQuestion`, `ExitPlanMode`), approval-gated actions, and unread sessions — across all sessions and machines at once.

- **Pending queue**<br />
  Queue messages while the agent is busy, offline, or not yet ready. Edit, reorder, and remove queued messages before they run. The queue is session-wide and shared with collaborators.

- **Steering and interrupts**<br />
  Steer compatible sessions while they are running. New messages are injected into the active turn when the backend supports it; otherwise they queue safely.

- **Git and file browser**<br />
  Full repository-aware workspace inside sessions and projects: browse files, review diffs, edit files, and run complete Git operations (commit, pull, push, branch, stash, worktrees, remotes) without leaving the app.

- **Projects and worktrees**<br />
  Persistent repository surfaces outside sessions. Browse a repo, inspect source control state, collect review comments, switch between worktrees, and then launch a session into the exact checkout context.

- **Embedded terminal**<br />
  A live shell backed by your connected machine, dockable in the bottom panel, sidebar, or as a full-screen — shared across session and project views.

- **Attachments**<br />
  Attach files and images to any message in new or existing sessions. Works across desktop, web, and mobile.

- **MCP servers**<br />
  Define MCP servers once in Happier and reuse them across all providers, all machines, and all sessions. Previews the effective tool surface before you start. Works with native-MCP and shell-bridge providers alike.

- **Prompts and skills**<br />
  Manage reusable system prompts and skill bundles in one synced library. Attach them to coding agents, voice, or profiles; install/export to provider-native locations; integrate with `skills.sh` registries.

- **Connected services and quota monitoring**<br />
  Link Codex, Claude, and other provider subscriptions once; reuse credentials across backends and machines. Monitor usage and quota snapshots directly in the app.

- **Profiles**<br />
  Save named backend configurations (endpoint, auth scheme, environment variables, secrets) and select them at session start or via `--profile` from the CLI.

- **Custom ACP backends**<br />
  Add any ACP-compatible CLI as a selectable backend — internal tools, review bots, planning agents — without modifying Happier's source.

- **Local memory search**<br />
  Build a machine-local index from your decrypted transcripts and search past session context from the app, or let coding and voice agents use memory tools for recall.

- **Mode, model, and permission controls**<br />
  Pick model, engine, mode (plan/build), reasoning effort, and permission level per session. Session-only overrides are separate from account defaults.

- **Multi-server support**<br />
  Use Happier Cloud, personal self-host, and company self-host side by side. Auth is scoped per server; daemon state is isolated per server profile.

- **Smart notification routing**<br />
  Notification taps open the exact session and server that needs attention. Permission actions and approvals are routed safely, never silently applied to the wrong server.

- **Server feature toggles**<br />
  Server owners can selectively disable capabilities (voice, social, bug reports, etc.) so users only see what is appropriate for their deployment.

- **In-app bug reports and diagnostics**<br />
  Submit bug reports with attached diagnostics, Sentry artifacts, and `happier doctor --json` snapshots. Crash recovery shows a safe fallback screen with pre-crash diagnostics preserved.

- **Enterprise-ready**<br />
  Run your own relay server and lock it down to your organization. Supports **GitHub OAuth with org/team membership gating**, **OIDC** (Okta, any provider, with per-provider user/email/group allowlists and RFC 9207 `iss` passthrough), **mTLS** (certificate-based auth via reverse proxy or direct, with SAN email/UPN identity mapping), and **keyless external auth** for SSO-only environments.<br /><br />Configurable auto-provisioning, offboarding re-checks at configurable intervals, and strict vs. permissive enforcement.<br /><br />Storage policy is independently configurable: end-to-end encrypted (default), mixed, or plaintext-only (for organizations that manage encryption at the infrastructure layer).<br /><br />Server-level feature flags let you enable or disable voice, automations, social, attachments, bug report uploads, embedded terminal, session handoff, and more — all via environment variables, advertised to clients at runtime so the UI adapts automatically.<br /><br />Rate limiting, file transfer size limits, session retention policies, and a diagnostics endpoint with configurable access control (owner-only or all authenticated users) are all included. Deployable via Docker, with PostgreSQL, SQLite or MySQL as the database backend.


## Security & Privacy

Happier is designed with privacy as a foundation, not an afterthought.

- **End-to-end encryption**  
  Built using modern cryptography (TweetNaCl).

- **Zero-knowledge architecture**  
  Your code is encrypted on your devices before it ever hits the wire.  
  Servers cannot read your data. Encryption keys never leave your devices.

- **Built with love from Switzerland**  
  Developed in Switzerland, with a strong focus on data protection and developer transparency.

## Livin' on the edge (nightly dev builds)

If you are feeling adventurous, you can use our nightly dev builds (or run from source).

In that case, you **must** run everything from the dev releases (CLI, app, daemon **and** server). The hosted Happier Cloud server (app.happier.dev / api.happier.dev), is running the `preview` channel currently, so not all the `dev` features might be available from it.

Please note that **`dev` can be highly unstable**. It can contain partial commits and can break at any moment.

### Happier CLI (macOS/Linux) - nightly dev builds:
```
curl -fsSL https://happier.dev/install-dev | bash
```

### Happier CLI (Windows) - nightly dev builds:
```
iwr https://happier.dev/install-dev.ps1 -useb | iex
```

**Important! Then you need to run `hdev` instead of `happier`!**
This allows installing the different releases alongside eachother.

If you want `happier` to map to `hdev`, add this to your `.bashrc`/`.zshrc`:
```
alias happier='hdev'
```

### Web app

`dev` does not have a hosted web app. To use the `dev` web UI, you must run your own self-hosted server from the `dev` nightly builds/source.

### Mobile apps - nightly dev builds:
- [iOS TestFlight](https://testflight.apple.com/join/PyRCsaS3)
- [Android APK](https://github.com/happier-dev/happier/releases/download/ui-mobile-dev/happier-dev-android.apk)

### Server - nightly dev builds:
- [Docker Hub - happierdev/relay-server:dev](https://hub.docker.com/repository/docker/happierdev/relay-server/tags/dev)
- [GHCR - happier-dev/relay-server:dev](https://github.com/happier-dev/happier/pkgs/container/relay-server/778977894?tag=dev)

### Dev box (happier CLI + daemon + Claude/Codex/OpenCode/etc) - nightly dev builds
- [Docker Hub - happierdev/dev-box:dev](https://hub.docker.com/repository/docker/happierdev/dev-box/tags/dev)
- [GHRC - happier-dev/dev-box:dev](https://github.com/happier-dev/happier/pkgs/container/dev-box/778997073?tag=dev)

### Running from source

[See below](#running-from-source-1)

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
```bash
happier relay host install --mode system
```

The self-host runtime follows the public release-ring model (`stable`, `preview`, `dev`) via `--channel stable|preview|dev`.

By default is uses an SQLite database.

### Docker

The relay server can also run on a docker container, using the pre-built images or building from source:
- https://docs.happier.dev/deployment/docker

### Proxmox

Thanks to our community, you can also easily install Happier in Proxmox using helper scripts:
- https://docs.happier.dev/deployment/proxmox

## Running from source

```bash
npm i -g yarn
git clone https://github.com/happier-dev/happier.git
cd happier
yarn
yarn build
yarn cli:activate
yarn tui
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT License — see [LICENSE](LICENCE) for details.

⸻

Not affiliated with or endorsed by Anthropic, OpenAI, or Google.

Code faster. Code together. Be Happier.

[Mobile, desktop and web app to run Claude Code, Codex, Gemini, OpenCode (and more) on your computer and continue seamlessly from your phone, browser, or desktop app.](https://guides.happier.dev/)
