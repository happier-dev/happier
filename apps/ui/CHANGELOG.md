# Changelog

## Version 3 - 2026-03-05

This release improves file attachments with image-first previews in the composer and transcript, plus clearer per-file upload progress while files are uploading.

- Added inline image thumbnails for image attachments in the composer and transcript, including per-file upload progress indicators during uploads.

## Version 2 - 2026-03-02

This release is a major upgrade to self-hosting and cross-device workflows (plaintext mode, keyless auth, mTLS, "Add Phone" pairing, and safer canonical URLs), plus a big step forward in in-app development features (panes, files/source control, diffs, replay/forking, and OpenCode deeper integration). It also improves reliability across web/desktop/mobile with better crash recovery, diagnostics, notifications controls, and more resilient daemon connectivity.

- Refactored the Files and Source Control UI to support richer session file workflows (changed-files review, repository tree, commit controls, files editing, and safer SCM operations like discard/stage).
- Added directory filtering and viewability tuning helpers for SCM review surfaces.
- Improved SCM reliability with adaptive polling, mutation invalidation, and better fallbacks when session/workspace paths are missing or a session is inactive.
- Improved diff caching and prefetch behavior so loaded diffs are retained more reliably while scrolling and expanding rows.

- Added a new pane-based UI architecture (details/right panes) with lazy loading, prefetching, and route integration for smoother navigation.
- Added multi-pane appearance preferences and improved details tab open/pin behavior.
- Added a resizable permanent sidebar drawer with persisted width preferences.
- Improved connection status UI to show the active server label more clearly.

- Refactored the code diff/rendering stack (Pierre web diff viewer, worker runtime/warmup, virtualization controls, unified folding, and improved syntax/language handling).
- Improved markdown rendering for developer workflows with diff-aware code fences and better table scrolling.
- Fixed a Markdown table rendering issue on Android that could clip content after large tables.
- Fixed a security issue by preventing Mermaid WebView HTML injection.

- Improved transcript UX with tool-call grouping controls and timeline improvements.
- Added compact/collapsible tool card behaviors and richer tool header/status handling (including clearer permission states).
- Added support for freeform “Ask a question” prompts in tool renderers.
- Improved list performance and stability by expanding FlashList usage, with a web fallback to FlatList on known FlashList layout crash signatures.

- Added session fork actions in the UI (from header/info/actions).
- Added “fork from message” semantics so forks happen at the expected point in the conversation.
- Added Happier Replay forking support across providers, including replay-seed propagation for continue/fork workflows.
- Added replay seed sizing limits to prevent oversized prompts and improve reliability.
- Improved replay synopsis retrieval with synopsis pointers and bounded fallback scanning for faster recovery.
- Added replay summary runner configuration support (backend/model), and ensured fork/continue flows forward summary runner settings when needed.

- Implemented major OpenCode runtime/server integration (managed server orchestration, session control, question/prompt handling, and forking support).
- Improved OpenCode runtime stability with readiness/health polling, safer shutdown cleanup, and better fallbacks when idle streaming is missing.

- Added support for session pinning
- Added support for session tags

- Improved permissions display UI
- Improved permissions notifications & user actions notifications

- Added plaintext storage mode support for self-hosted servers (so sessions can be stored plaintext-at-rest when configured).
- Added keyless external authentication support for self-hosted and enterprise auth providers.
- Added mTLS login support for environments that require certificate-based authentication.
- Added an “Add your phone” pairing flow, including QR-based pairing from web/desktop and in-app pairing helpers.
- Added QR restore flows so reconnecting a device is smoother when migrating or recovering access.
- Added in-app QR scanner routes (with better mobile-web gating) for pairing/connect flows.

- Improved QR codes and share links so they never embed `localhost` / loopback server URLs (so scanning on mobile won’t switch you to an unreachable server).
- Improved server override safety so loopback-only links won’t override an already-working non-loopback server selection.
- Added clearer in-app guidance when a QR/link cannot include a shareable server URL.

- Added canonical server URL support for self-hosted servers, with safer adoption rules (including insecure URL guards).
- Added canonical URL inference from Tailscale Serve status and improved flows to prefer the server-defined canonical URL where possible.
- Improved welcome/auth flows to be more resilient when server feature snapshots are unavailable or server switching aborts mid-flow.

- Added a web startup safety gate that fails closed when required WebCrypto primitives are unavailable (instead of partially breaking later).
- Added OIDC callback `iss` passthrough handling for RFC 9207 compatibility with more identity providers.

- Connected Services: added/expanded Codex cloud auth (PKCE + device auth) and improved connect guidance.
- Connected Services: added Claude subscription OAuth cloud-connect flow (and improved token exchange/materialization).
- Connected Services: unified OAuth routing across embedded/device/paste flows and improved error handling, labeling consistency, and quotas behavior.

- Added an “Installables” catalog surface in machine details so you can see detected/available tools more clearly.
- Added a System Status screen (app/server/machine health, grouped machine status, and system actions).
- Added a Diagnosis screen that runs probes and produces a structured diagnosis report with findings.

- Added `happier doctor --json` snapshot output for easier debugging and support workflows.
- Improved bug reports to ingest doctor snapshots (daemon + pasted CLI), enrich diagnostics context, and handle missing server diagnostics gracefully.
- Added crash recovery UI that shows a safe fallback screen with restart + copy-details actions when the app hits a render-time crash.
- Added “restart-intent” bug report flows so a queued report can reopen automatically after relaunch, preserving pre-restart diagnostics.
- Improved crash reporting by attaching Sentry event artifacts on submit (when available) and adding crash-report gating helpers.

- Added interactive push notification actions.
- Added an “In-app notifications” setting (Full / Silent / Off) and suppressed notifications for the session you’re actively viewing (so you don’t get spammed while reading).

- Improved daemon startup/readiness to reduce early RPC races (fewer “method not available” failures during startup).
- Improved daemon/service PATH handling and service reliability on Linux/macOS (systemd/launchd), including better credential repair and safer service behaviors.
- Improved Windows command/shim execution and spawn reliability for provider CLIs and subprocesses.

- Added a safer clipboard write helper so copy actions fail gracefully instead of erroring.
- Improved text selectability across transcript/tool/review/command surfaces for easier copy/paste and review.

- Added reduced-motion accessibility support.
- Expanded localization across tools, runs, files, settings, voice, automations, navigation, and modals.

Happier is moving well and fast. I hope to be able to push a new preview release in the next few weeks.

This new version will fix a lot of the bugs that have been reported:
- Default server URL in the app
- Better handling of server URLs and public server URLs
- iOS path picker fix
- change_title fixed
- OpenCode modes (plan/build)
- /clear wired and passed down to Claude/Codex
- "Working" session indicator flicker
- Session list flicker
- Push notifications
- Better display of permission requests
- Separation of user actions (AskUserQuestion) and permissions
- Horizontal scrolling in markdown tables/code
- Back button unresponsive
- Claude MCP and user settings preservation

In addition to that, it will also have a lot of new features and improvements:

### Claude
- Claude Agent Teams full integration: create and manage Claude Teams directly from Happier, send messages to teammates, add new teammates, monitor your team, etc
- Better streaming and handling of Claude Tasks/subagents in the transcript and in sidechains
- Turn-end diff summary
- Browse existing Claude sessions and display their transcript/history in Happier
- Follow live sessions started outside of Happier (e.g. with `claude`) in Happier
- Takeover an existing Claude session in Happier

### Codex
- Codex app-server as the default Codex backend
- Codex Fast mode
- Rollback discussion/edit previous message
- Turn-end diff summary
- Browse existing Codex sessions and display their transcript/history in Happier
- Follow live sessions started outside of Happier (e.g. with `codex` or the Codex app) in Happier
- Takeover an existing Codex session in Happier

### OpenCode
- OpenCode server as the default OpenCode backend
- Local/remote switching = using OpenCode in the terminal and seeing the session in Happier UI
- Per-message session forking
- Turn-end diff summary
- Browse existing OpenCode sessions and display their transcript/history in Happier
- Follow live sessions started outside of Happier (e.g. with `opencode` or the OpenCode UI/app) in Happier
- Takeover an existing OpenCode session in Happier

### File browser, editor, Git and terminal
- Fully refactored file browser
- "Review" mode to scroll through the full diff of the repository/session/turn
- Edit, download, upload, create files
- Create, download directories
- Complete Git operations: commit, pull, push, manage branches, manage worktrees, manage remotes, stash
- Integrated multi-tab editor
- Integrated terminal

### Multi-accounts & connected services
- Connect multiple Codex/Claude accounts in the UI (OAuth, device-auth, and/or setup-token) - e.g. your work and personal Codex accounts
- Select a specific account to use when starting a session
- Assign accounts to profiles and/or workspaces
- Monitor your accounts usage from Happier

### In-app terminal CLI auth
- Log in to `claude`, `codex`, etc directly from the app using the integrated terminal

### Automations
- Define tasks that should run at specific times/intervals
- Automations can run in existing sessions or new sessions

### Happier Subagents
- Happier-native subagents: e.g. start a Codex subagent in a Claude session. Ask Codex to start and manage multiple parallel subagents, etc
- Agents sidebar allows you to view, monitor and manage all types of subagents: Claude, OpenCode, Happier

### Happier Review
- Start multiple parallel review agents directly from your Happier session, including Coderabbit
- Findings of the reviewers' agents are displayed in the UI for you to accept/reject/ask for clarifications
- Clarifications are sent back to the reviewer agent
- Accepted findings are sent to the session for implementation

### Happier Replay
- Happier-native session replay/summarization, used by the voice agent and sessions in specific cases to replay sessions

### Happier Fork
- Fork any session at any point in time
- If the backend supports forking, we use the backend's native fork mechanism (e.g. OpenCode)
- Otherwise, we use Happier Replay to extract the session messages and replay them in the new session up to the fork point

### Happier Memory
- Optional unencrypted local database of your sessions
- Supports optional vector database with local embeddings generation and/or OpenAI-compatible embedding API
- Allows your agents to remember and search previous sessions

### Attachments
- Attach any files/images to your messages
- Uploads the files in a temporary folder in your project's folder or OS temporary folder

### Skills
- Manage Skills from Happier and sync/install skills for Claude/Codx/OpenCode/etc
- skills.sh direct integration

### Prompts
- Add any prompt/text to Happier's system prompt for the coding agent and voice agent
- The agents can propose edits to the prompts (OpenClaw's SOUL.md-like)
- Agent edits proposals are sent as action requests for you to review and accept/reject

### Voice
- Largely improved voice experience
- Voice Agent now prefer human-labels instead of IDs
- Lots of improvements to ElevenLabs integration following feedbacks
-

### Browse and import sessions

### Direct sessions
- Start session

### Notifications and badges

### Transcript and timeline
- Improved transcript rendering speed and streaming
- Subtle animations (configurable)
- Improved tools rendering in the transcript: tools calls are now grouped and displayed collapsed by default
- Settings allows you to go back to previous non-grouped rendering of tools and choose your prefered transcript/tools rendering (cards, non-cards, timeline, thinking display, tools expended or not, etc)
- Define tools that you want to be displayed as expended by default. E.g. have the Diff or Bash tools always render expended, while keeping the others collapsed by default

### Custom ACP backends
- Add any ACP backend/CLI from the app

### Profiles
- List profiles from the CLI
- Start a session from the CLI using a profile

### MCP servers
- Manage/add MCP servers directly in Happier
- Compatible with all Happier backends
- Those are not saved in the Claude/Codex/OpenCode MCP configurations, they are additive to them
- Allows to define your MCP servers 1x in Happier and have them work with all your machines/backends/CLIs
- Define machine-overrides to set specific paths/arguments depending on your machines
- Compatible with backends who do not support MCPs (PI and some of the ACP backends) by instructing them to use the Happier MCP Bridge CLI
- Set default MCP servers per workspace/machine

### Happier Actions
- Actions is the internal list of actions that you, your coding agents and voice agents are able to perform in Happier
- For each action, you can set exactly where they are surfaced/enabled:
  - Voice agent tools
  - Coding agent MCP server
  - Slash commands
  - Agent Input chips (optional, only for some actions as a shortcut, like "Review")
- Most of the actions are enabled by default

### Inbox
- Centralize all the permission requests/actions from all your sessions
  - Permission requests
  - User actions (AskUserQuestion, ExitPlanMode, etc)
  - Actions approvals
  - Sync conflicts
  - Updates

### UI
- Resizable left sidebar
- New Panel system:
  - Right sidebar: file browser, git, agents, workspace, etc
  - Details panel: file/diff viewer, file editor
  - Bottom panel: terminal
- Session list is now cached and session metadata is decrypted only when necessary and when there are updates to the session (thanks @lucharo for the original idea)

### Server retention settings
- Servers can define retention policies to avoid infinite growth
- Happier Cloud server will have a 30 days retention policy. Sessions inactive since 30 days will be remove from the server to limit costs for the free server.

### Workspaces
- Create workspaces to manage settings for specific projects/folders
- Link workspace locations between different machines
- Sync workspace folders between machines (Mutagen-inspired)

### Happier Sync
- Used by the workspaces to sync projects files between machines
- Supports one way/two way sync and conflicts resolution
- Conflicts are surfaced in the UI

### Happier Handoff

## Version 1 - 2026-02-15

Welcome to Happier - your secure, encrypted mobile companion for Claude Code. This inaugural release establishes the foundation for private, powerful AI interactions on the go.

- Implemented end-to-end encrypted session management ensuring complete privacy
- Integrated intelligent voice assistant with natural conversation capabilities
- Added experimental file manager with syntax highlighting and tree navigation
- Built seamless real-time synchronization across all your devices
- Established native support for iOS, Android, and responsive web interfaces
