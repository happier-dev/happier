# Changelog

## Release 2026-08-09.1 - 2026-08-09

<!-- happier-release-note-projections:v1
{
  "expo": {
    "message": "This development release delivers the latest fixes and improvements for Happier's public dev channel."
  },
  "appStore": {
    "whatsNew": "This development release delivers the latest fixes and improvements for Happier's public dev channel."
  },
  "playStore": {
    "whatsNew": "This development release delivers the latest fixes and improvements for Happier's public dev channel."
  },
  "storyDeck": {
    "summary": "This development release delivers the latest fixes and improvements for Happier's public dev channel."
  }
}
-->

This development release delivers the latest fixes and improvements for Happier's public dev channel.

## Version 0.2.1 - 2026-04-05

This is a massive release. Here's everything that changed.

---

## Bug Fixes

A large number of reported bugs have been fixed in this release:

- **First prompt consumed / session stuck waiting for input**
- **Default server URL in the app** — self-hosted web deployments now auto-seed the correct same-origin server profile on first load
- **Server URL and public URL handling** — loopback/localhost server URLs are now properly excluded from QR codes, share links, and canonical URL adoption to prevent mobile devices from resolving unreachable addresses
- **iOS path picker** — fixed file and directory selection on iOS
- **`change_title` tool** — now properly wired and required before first reply, fixing broken session title behavior
- **OpenCode plan/build modes** — plan and build mode flags are now correctly passed through to the OpenCode backend
- **`/clear` command** — now properly wired and propagated to Claude, Codex, and OpenCode backends
- **"Working" session indicator flicker** — resolved timing issue causing the indicator to flash unexpectedly
- **Session list flicker** — fixed session list rerender churn during streaming updates
- **Push notifications** — delivery and routing issues resolved; per-device server URL routing is now correct
- **Permission request display** — permissions are now shown more clearly and consistently across all surfaces
- **Separation of user actions and permissions** — `AskUserQuestion`, `ExitPlanMode`, and similar agent-driven requests are now displayed separately from tool permission requests in the inbox and transcript
- **Horizontal scrolling in markdown tables and code blocks** — fixed clipping and overflow behavior across platforms, including a specific Android crash where large tables would expand beyond bounds
- **Back button unresponsive** — resolved navigation deadlock on certain route transitions
- **Claude MCP and user settings preservation** — MCP configuration and account settings are no longer dropped on session restart or environment reloads
- **Mermaid WebView HTML injection** — security fix preventing malicious Mermaid diagrams from injecting HTML
- **Nested Claude Code environment leaks** — `CLAUDE_*` environment variables are now stripped before spawning child processes to prevent recursion/conflicts
- **Out-of-order message batches** — incoming socket message batches are now sorted before being applied to the reducer
- **Session prompt dropping** — fixed a regression where user prompts could be silently dropped under certain conditions
- **Codex speed mode eligibility** — speed option is now correctly restricted to eligible accounts and models
- **Cold-start machine list blank-state flicker / list pops in and shifts on app resume** — the machines list no longer drops to empty while machine encryption is still initializing, and cached machines are returned immediately even when the bootstrap isDataReady flag hasn't settled yet, eliminating the layout jump when returning to the app from the background
- **Claude compaction hang: long threads triggered compaction but queued messages stalled until stop** — the turn is now correctly finalized on system/init compaction events for both the remote Agent SDK and the SDK backend, keeping the prompt pump moving and draining pending sends without requiring a manual stop
- **Pending queue messages sent out of order** — when multiple messages were queued quickly, larger or later messages could appear to send first; fixed at three layers: the server now reserves positions with an atomic per-session counter so legacy sessions can't append into the middle of the queue, the UI preserves optimistic insertion order without re-sorting by createdAt, and enqueue call order is now serialized per session so earlier encryption resolving late can't swap two queued messages
- **`happier session send` inactive-session handling** — `happier session send <id> <message>` now fails closed for inactive sessions; resume the session first so the provider context is restored before sending
- **`bun install -g @happier-dev/cli@next` fails with 404 errors** — Bun doesn't honor `bundledDependencies` and was fetching unpublished internal `@happier-dev/*` packages from the registry; the packed tarball now strips those entries from `package.json` while keeping the bundled files intact
- **`ERR_MODULE_NOT_FOUND` for `@happier-dev/release-runtime` after npm install** — bundled workspace packages were missing from the published CLI tarball; bundled workspace sync is now part of the release packaging step
- **CLI binary crashes with `Illegal instruction` on older x86-64 CPUs** — Linux x64 release binaries now use `bun-linux-x64-baseline` (pre-AVX2 compatible) instead of the default modern build
- **`hstack stack auth` hangs forever when the daemon is crash-looping** — guided stack auth now times out on an unhealthy web UI path and falls back to mobile auth instead of waiting indefinitely
- **`hstack happier` overrides the CLI server URL and breaks cloud auth** — the stack wrapper no longer shadows an already-configured CLI server setting, so multi-terminal workflows on the same machine work correctly
- **Daemon loses machine registration on transient DNS failures at startup** — the daemon now retries registration in a background loop with a configurable policy; `EAI_AGAIN`, timeouts, and connection errors recover automatically without a manual restart
- **`happier --resume <happier-session-id>` passes the ID straight to the provider CLI, which rejects it** — Happier session IDs are now detected and resolved to their vendor resume ID before dispatching to the provider
- **Session working directory missing from `happier daemon list` output** — the `/list` endpoint now includes an optional `directory` field per session
- **`session.continueWithReplay` not accessible from the daemon HTTP API** — `POST /continue-with-replay` is now exposed on the daemon control server, backed by the same shared implementation used by the machine RPC handler
- **Mobile UI locks up and can't change server URL when the server is unreachable** — the reachability probe now uses the endpoint supervision path, which is timeout-safe and cancellable, instead of a raw fetch that could hang indefinitely
- **Enhanced Session Wizard crashes on new session creation** (`undefined is not an object: 'acpSessionModeOptions'`) — null-guarded in the wizard preflight
- **OpenCode sessions showed no model choices in the picker** — the model picker now shows probed/available models instead of an empty list
- **Can't log in from another terminal after the first login** — `hstack happier` no longer overwrites an explicitly configured server URL from CLI settings when a stack environment is present
- **Sessions frequently lock up and appear stuck `in_progress`** — ACP tools in a permission-pending state were incorrectly arming execution timeouts; timeouts are now only started after the permission gate clears. OpenCode/Kilo backends were also stalling on `allow_once` replies; they now prefer `allow_always` when approving to avoid a vendor-side hang
- **Web markdown tables clipped with no visible scroll** — the table `ScrollView` was hiding the horizontal scroll indicator and forcing `overflow: hidden` on web; both are now corrected
- **Stale permission approval cards remained visible in inactive sessions** — when a session goes inactive, pending tool calls now always render as canceled/failed instead of leaving un-actionable approval buttons. Voice context surfaces were hardened to match
- **Unresponsive taps on tool expand icons and back button on mobile** — a hidden Drawer layer was still mounted on narrow viewports and intercepting touch events; the shell now renders a plain Stack on mobile widths. Validated with live iOS Safari QA

---

## New Features and Improvements

### Claude

- **Better streaming and subagents handling** — interleaved `stream_event` sidechains from Claude Tasks and parallel agents are now correctly bridged and rendered in the transcript
- **Sidechain repair** — synthetic partial messages are no longer dropped; the main parent chain is preserved across sidechains
- **Turn-end diff summary** — a compact diff summary is shown at the end of each assistant turn when files were modified
- **Reasoning effort** — reasoning effort can be selected and is now passed through to Claude queries where supported
- **MCP variadic prompt parsing fix** — variadic MCP tool prompts are now parsed correctly
- **Permission handler improvements** — `resetAndFlush` support added; session title changes are now auto-approved
- **Browse existing Claude sessions** — browse and display the transcript/history of any Claude session, even those not started by Happier
- **Follow live sessions** — follow in real time a session currently running in the Claude CLI or Claude Code
- **Take over a session** — import an existing live Claude session into Happier control, including its full transcript

### Claude Agent Teams

- Create and manage Claude Teams directly from Happier
- Send messages directly to individual teammates
- Add new teammates to an existing team
- Monitor your team and all active subagents from the agents sidebar

### Codex

- **Codex App Server is now the default backend** — replaces the ACP/MCP integration for a more stable experience and more features
- **Fast mode** — Codex fast/speed option is now available in the model picker (for eligible accounts)
- **Rollback / edit previous message** — navigate back to any turn and steer the conversation from that point
- **In-flight turn/steer handling** — Codex turns can now be steered while in progress
- **Turn-end diff summary** — compact diff shown at turn end when files were modified
- **Model display name normalization** — Codex model names are now cleaned up and consistent across the UI
- **Per-model session options in metadata** — model-specific options (like speed, reasoning) are stored and surfaced correctly
- **Browse, follow, and take over existing Codex sessions** — same capabilities as Claude: browse history, follow live sessions, and import sessions started in the Codex CLI or the Codex app into Happier

### OpenCode

- **OpenCode Server as the default backend** — managed server orchestration handles startup, health checks, and shutdown
- **Local/remote switching** — start a session with `happier opencode` in the terminal, use the OpenCode TUI experience directly in your terminal, and open the session in Happier's UI to follow or control it
- **Per-message session forking** — fork the conversation at any message directly from the UI
- **Turn-end diff summary** — compact diff shown at turn end when files were modified
- **Thinking option** — OpenCode thinking/reasoning is now surfaced in the preflight options
- **Browse, follow, and take over existing OpenCode sessions** — same capabilities as Claude and Codex
- **`happier attach`** — attach an OpenCode session to multiple terminals simultaneously

### Browse and Import Existing Sessions

These capabilities are now available for Claude, Codex, and OpenCode:

- Browse any existing session on your connected machine, even sessions Happier didn't start
- Follow a session currently running outside Happier (e.g. started with `claude`, `codex`, or `opencode` in the terminal) — messages stream into Happier in real time
- Take over / import a session — Happier links to it, stores the transcript, and you can continue from the app

### Direct Sessions

- New "direct" session mode where Happier does not persist the session transcript server-side — messages are forwarded directly between machine and connected devices
- Direct session linking and takeover with full transcript import

### Session Forking and Replay

- Fork any Happier session
- **"Fork from message"** — forks happen at the correct point in the conversation, not at the latest message
- **Happier Fork** — for backends that don't support native forking, Happier Replay extracts session messages and replays them into a new session up to the chosen fork point
- **Replay seed sizing limits** — prevents oversized prompts from causing failures
- **Synopsis pointers + bounded fallback scanning** — faster synopsis retrieval for long sessions
- **Summary runner config** — choose the backend and model used for replay summarization; fork/continue flows carry these settings forward
- **OpenCode native fork** — uses OpenCode's built-in fork mechanism when available
- **Codex fork** — full-conversation fork support

### Session Handoff (Machine Transfer)

- Transfer a full session — including provider state and project directory — to another machine
- **Workspace replication engine** — content-addressed storage (CAS) with baseline commits, blob packs, and incremental sync
- **Replication job leases** — safe concurrency with progress tracking and phase lifecycle
- **Server-routed recovery** — handoff can recover via the server relay when direct transfer fails
- **Progress modal** — shows applied/remaining counts and recovers gracefully from partial transfers
- **Filesystem transfer limits** — enforced at the RPC boundary to prevent oversized transfers
- Session handoff metadata store for persistent handoff state across daemon restarts

### File Transfers and Transfer Relay

- **Transfer Relay v2** — new transfer architecture with end-to-end encryption and chunked delivery
- **Bulk transfer pipeline** — unified pipeline for prompt assets, prompt registries, workspace files, and session attachments
- **Direct-peer transfers** — when both machines are reachable on the same network, transfers bypass the server entirely for maximum speed
- **Tailscale Serve integration** — secure HTTPS direct-peer transfers from the web app using Tailscale Serve
- **Max-bytes limits** — transfers that exceed configured limits fail closed rather than silently truncating
- **Machine route viability cache** — reduces redundant probing for transfer route selection
- Server-defined limits for server-routed file transfers

### File Browser and Source Control

- **Fully refactored file browser** — session and workspace-scoped filesystem operations with a new repository tree
- **File operations** — edit, download, upload, and create files; create and download directories
- **In-app file editor** — edit files directly from the repository tree or diff view
- **Complete Git operations** — commit, pull, push, manage branches and remotes, stash, and manage worktrees
- **Multi-tab editor integration** — open multiple files in parallel tabs
- **Diff view improvements** — Pierre web diff viewer with worker runtime warmup, virtualization controls, unified folding, and improved syntax/language detection
- **Diff caching and prefetch** — loaded diffs are retained while scrolling and expanding rows
- **Directory filtering** — viewability tuning helpers for SCM review surfaces
- **Improved SCM reliability** — adaptive polling, mutation invalidation, and better fallbacks when session paths are missing or sessions are inactive
- **Discard safety** — safer discard/stage operations with confirmation guards
- Review comments can now be added directly in diff views and sent to agents

### Worktrees

- Start sessions in a specific worktree from the new session screen
- Create and manage worktrees from the Git panel in session details
- Worktree-aware project routes and mobile headers

### Review Mode

- Scroll through the full diff of the repository, session, or turn
- Browse previous commit diffs and history
- Add review comments directly in diffs and files to send to agents
- **CodeRabbit integration** — start a CodeRabbit review run from a session; findings are displayed as structured cards with accept/reject/clarify actions
- Review follow-up messages and findings v2 structured metadata are now rendered

### Panes and Navigation

- **New pane-based UI architecture** — right details panel, left sidebar, bottom panel (terminal)
- Lazy loading and prefetching for panel content
- Route integration for smooth navigation between panes
- **Resizable left sidebar** with persisted width preferences
- **Sidebar nav toggle** — collapse/expand the sidebar with a keyboard shortcut
- Multi-pane appearance preferences
- Details tab open/pin behavior improvements
- **Connection status UI** — now shows the active server label more clearly

### Session List

- **Cached session list** — session metadata is decrypted only when needed and only when updated (thanks @lucharo for the original idea)
- Session **pinning** — pin important sessions to the top of the list
- Session **tags** — label sessions with custom tags for easy filtering
- Project-grouped headers with collapse/expand
- Session reorder mode with drag handles
- List **density settings** — comfortable and compact modes
- Resolved selected session ID for multi-server list views
- Virtualized list with improved FlashList usage and a web FlatList fallback for known crash signatures

### Transcript and Tools Rendering

- **Tool-call grouping** — related tool calls are now grouped and collapsed by default
- **Per-tool expansion settings** — define which tools (e.g. Bash, Diff) should always be expanded; keep others collapsed
- **Compact tool cards** — cleaner display with configurable card/non-card rendering
- **Ask a question** — tools that prompt the user for freeform input are now rendered with a dedicated input UI
- **Tool header error indicator** — a red badge appears in the session header when a tool fails
- **Timeline improvements** — cleaner turn boundaries and thinking-grace handling
- **Streaming improvements** — delta deduplication, thinking reconciliation, and better merge for out-of-order chunks
- **Text selectability** — improved across transcript, tool, review, and command surfaces

### Settings UI

- **Prompt registry editor** — manage system prompts and prompt templates
- **Connected services** — OAuth, device auth, and setup-token accounts in one place
- **MCP server management** — add, edit, and remove MCP servers per workspace or machine
- **Session list density** — new density preference in session settings

### Self-Hosted Server Improvements

- **Plaintext session storage** — sessions can be stored plaintext-at-rest when configured (for environments where server-side encryption is managed separately)
- **Keyless external authentication** — support for auth providers that don't require a Happier-managed key challenge
- **mTLS login** — certificate-based authentication for environments that require mutual TLS
- **Canonical server URL** — define a canonical public URL for your self-hosted server; Happier adopts it safely with insecure URL guards
- **Canonical URL inference** — automatically derived from Tailscale Serve/Funnel status when available
- **API rate limiting** — server-side rate limit policies to protect shared instances
- **OIDC `iss` passthrough** — RFC 9207 compatibility for more identity providers
- **GitHub and OIDC auth** — new guides and improved server-side support
- Docker images now published to GHCR; Tailscale sidecar Docker Compose example added
- MySQL/Vitess `encryptionModeUpdatedAt` compatibility fix

### Add Your Phone / Pairing

- **"Add your phone"** — if you set up Happier on web or desktop, you can now easily add your phone from Settings using a QR code
- **QR restore flows** — reconnect a device smoothly when migrating or recovering access
- **In-app QR scanner** — mobile-web gated scanner for pairing and connect flows
- QR codes and share links never embed localhost/loopback addresses
- Server override safety: loopback-only links won't override an already-working non-loopback server selection
- Clear in-app guidance when a QR/link can't include a shareable server URL

### Multi-Accounts and Connected Services

- Connect multiple Codex and Claude accounts simultaneously (e.g. personal and work)
- **Claude subscription OAuth** — cloud-connect flow with improved token exchange and materialization
- **Codex PKCE + device auth** — full OAuth flow for Codex cloud accounts
- Select which account to use when starting a session
- Assign accounts to profiles
- Connect once, use on multiple devices
- Unified OAuth routing across embedded/device/paste flows
- **Quota monitoring** — view your Codex and Claude quota/usage directly in Happier

### Permissions and Approvals

- **Centralized permission approvals** — all permission requests from a session are surfaced at the bottom of the transcript (configurable)
- **Improved permission display** — clearer distinction between tool permissions and user-action requests
- Permission allowlist refinements in the base permission handler

### Notifications and Inbox

- **Interactive push notification actions** — tap notifications to directly approve, deny, or navigate to the relevant session
- **"In-app notifications" setting** — choose Full, Silent, or Off; notifications for the session you're actively viewing are suppressed automatically
- **Inbox** — centralized view of all sessions with unread messages, permission requests, user actions (`AskUserQuestion`, `ExitPlanMode`), action approvals, and updates
- Push notification routing now uses per-device server URLs

### Attachments

- Attach files and images to messages
- Files are uploaded to a temporary folder in the project or OS temp directory
- **Chunked upload handlers** — robust multi-part upload with progress tracking
- Attachment action chip in the agent input bar

### MCP Servers

- **`happier mcp` command** — manage MCP servers from the CLI; `--mcp-server` alias available
- Manage and add MCP servers from the Happier settings UI
- MCP servers defined in Happier work with all backends and all machines
- Machine-specific overrides for paths and arguments
- Default MCP servers per workspace or machine
- MCP bridge: non-MCP-compatible backends (like Pi) can call Happier MCP servers via a CLI shim

### Automations

- Define tasks that run on a schedule or at specific times
- Automations can target existing sessions or start new sessions

### Voice

- **Kokoro runtime** — expanded Kokoro TTS support with local downloads and audio output routing
- **Carrier session routing** — voice sessions can now route through a carrier session
- **Local conversation runtime** — voice agent can run a full conversation loop locally
- Voice settings panels and surface controls improved
- Voice agent tool catalog: human-readable labels instead of IDs
- ElevenLabs integration improvements (streaming, model selection)
- Voice agent now recovers from daemon disconnects automatically
- Voice tool model probing and machine capabilities cache integration
- Voice agent can now run all the same actions that are available through the CLI/MCP: create sessions, manage sessions, monitor any session, approve requests, etc.

### Diagnostics and Bug Reports

- **`happier doctor --json`** — outputs a structured JSON snapshot for support workflows
- **Bug reports** — now ingest doctor snapshots (daemon + pasted CLI), enrich diagnostics context, and handle missing server diagnostics gracefully
- **Crash recovery UI** — safe fallback screen with restart and copy-details actions when the app hits a render-time crash
- **Restart-intent bug report flow** — a queued report reopens automatically after relaunch, preserving pre-restart diagnostics
- **Sentry integration** — exception capture helper; Sentry event artifacts attached on bug report submit when available
- **Diagnosis screen** — runs probes and produces a structured report with categorized findings
- **System Status screen** — app, server, and machine health grouped by component, with system actions

### CLI Improvements

- **`happier mcp`** — MCP server management and bridge
- **`happier doctor --json`** — structured JSON diagnostics snapshot
- **JSON envelope output** for control commands — machine-readable responses
- **Deterministic JSON exit codes** for session commands
- PTY configuration and PID cleanup for terminal sessions
- `--backend` flag normalization — consistent target key handling
- `--mcp-server` alias added
- Daemon wait flag for reliable daemon startup before RPC
- Default session path derived from invoked `cwd` instead of requiring explicit `--path`
- `happier resume` & `happier attach` — interactive list of available Happier sessions to resume
- `happier session` — full session management CLI
- Improved systemd/launchd service PATH capture (user PATH preserved in unit files)
- Windows command/shim execution improvements
- Nested `CLAUDE_*` env stripping to prevent environment leaks in subprocesses

### Daemon and Runtime

- **Improved startup/readiness** — reduced early RPC races during daemon startup ("method not available" errors on first connect)
- Service reliability improvements on Linux (systemd) and macOS (launchd)
- **Control client version checks** — daemon heartbeat and compatibility enforcement
- Automation, memory, service, and PTY runtime flows consolidated
- Daemon shutdown state is cleaned up reliably on exit

### Profiles

- List profiles from the CLI (`happier profiles`)
- Start a session from the CLI using a specific profile (`--profile`)

### Session Tags

- Add custom tags to sessions for organization and filtering
- Tags are rendered in the session list and session header

### Happier Memory

- Optional local database of sessions
- Supports optional vector embeddings (local generation and/or OpenAI-compatible embedding API)
- Agents can search previous sessions for relevant context

### Happier Actions

- Unified action catalog controlling where each action is surfaced: voice agent tools, coding agent MCP, slash commands, agent input chips
- Per-action approval gating — route sensitive actions through the inbox before execution
- Most actions enabled by default; fully configurable

### GitHub Copilot Integration

- Full GitHub Copilot CLI agent support — use your GitHub Copilot subscription directly as a backend in Happier
- Windows support with correct shim resolution
- Streaming debounce, model ID fallback, and permission argument handling
- Install guidance and provider setup flow in the UI

### Kiro Integration

- New Kiro provider plugin with full UI configuration
- Provider settings screen and icon support
- Listed alongside other providers in the backend picker

### Nightly Dev Releases

Due to popular demand, a new release lane builds nightly from the `dev` branch and publishes new dev releases for the app, CLI, Docker images, relay server, and more.

Dev should **not** be treated as stable — it can break at any time and may contain partial commits or breaking changes.

The recommended way to run Happier is using the preview releases, which will now have a much more frequent release cycle.

## Version 1 - 2026-02-15

Welcome to Happier - your secure, encrypted mobile companion for Claude Code. This inaugural release establishes the foundation for private, powerful AI interactions on the go.

- Implemented end-to-end encrypted session management ensuring complete privacy
- Integrated intelligent voice assistant with natural conversation capabilities
- Added experimental file manager with syntax highlighting and tree navigation
- Built seamless real-time synchronization across all your devices
- Established native support for iOS, Android, and responsive web interfaces
