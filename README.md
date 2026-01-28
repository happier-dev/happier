<div align="center"><img src="/.github/happier.png" width="400" title="Happy Coder" alt="Happy Coder"/></div>

<h1 align="center">
  Mobile and Web Client for Claude Code, Codex, Gemini, OpenCode, Augment Code
</h1>

<h4 align="center">
Use Claude Code, Codex, Gemini, OpenCode, Augment Code from anywhere with end-to-end encryption.
</h4>

This forks adds a lot of new features, improvements, fixes on top of the original Happy project. **The goal is to keep upstream compatibility for now and be able port our changes into upstream when the time comes.**

# Happier
## 🏗 Core Architecture

### 1. Server Light (SQLite & Local Files)
We have introduced a "Light" server flavor designed for local-only use, removing the dependency on Docker (Postgres/Minio) for personal usage.
*   **Dual Flavor Entrypoints:** The server now boots in either `'full'` (Postgres/S3) or `'light'` (SQLite/Local FS) mode.
*   **SQLite Infrastructure:** Added dynamic Prisma client generation for SQLite (`schema:sync`), atomic write-ahead DB handling, and baseline migrations.
*   **SQLite env correctness:** sqlite DB URLs are formed via proper `file:///...` URLs (URL-escaped), and light flavor validates `PORT` fallbacks and normalizes public paths across platforms.
*   **Migration reliability:** light migration scripts validate `HAPPY_SERVER_LIGHT_DATA_DIR` (trim/require) and centralize the deploy plan args; light entrypoint does not exit after start.
*   **Master secret race hardening:** light flavor master secret file creation is atomic (exclusive create + EEXIST read-back), preventing corruption when multiple processes start concurrently.
*   **Local Files Backend:** In "Light" mode, public files (avatars, attachments) are served directly from `~/.happy/server-light/files` via a secured `/files/*` route.
*   **Public file URL hardening:** strict path normalization rejects traversal/absolute/drive-letter/null bytes; URL generation encodes each path segment (`encodeURIComponent`) so `#`/`?` cannot be interpreted as fragment/query.
*   **Schema sync + Prisma centralization:** a unified `schema:sync` generator produces the SQLite schema and enum exports (with `--check` drift tests), and server code centralizes Prisma init/types with a fail-fast `db` proxy.
*   **Integrated UI Serving:** The server can optionally serve the frontend static bundle (handling SPA routing fallbacks), enabling single-process deployments.

### 2. Pending MessageQueue V1 (Metadata-Backed)
We replaced the ephemeral socket-based pending queue with a persistent, encrypted queue stored in session metadata.
*   **Source of Truth:** The pending queue is stored in `session.metadata.messageQueueV1`. This ensures queue state survives server restarts and synchronizes perfectly across devices.
*   **CAS Updates:** Enqueue/dequeue operations use `update-metadata` with version checking (Compare-And-Swap) to prevent race conditions.
*   **Submit Modes:** message sending is driven by `settings.sessionMessageSendMode` (`agent_queue|interrupt|server_pending`). The default `agent_queue` mode chooses `server_pending` automatically when queue support exists and the agent is busy/offline/not-ready or controlled by the terminal (so we never “lose” input that cannot be injected safely).
*   **Transcript Recovery:** The CLI observes the server-echoed message (by stable `localId`) before clearing `messageQueueV1.inFlight`, preventing loss if the CLI crashes between emit and server persistence.
*   **Discard tracking:** queued items can be discarded into `messageQueueV1Discarded`, and committed transcript messages can be marked discarded via `discardedCommittedMessageLocalIds` (UI dims and labels discarded bubbles).
*   **Fail-closed parsing:** invalid persisted queue shapes (e.g. malformed `inFlight`) are rejected so corrupted state doesn’t partially apply.
*   **Optimistic “thinking” UX:** the app sets a short-lived `optimisticThinkingAt` marker when sending/enqueueing so sessions reflect activity immediately, then clears it once the server reports `thinking: true`.
*   **Pending UI:** the “Pending messages” indicator/modal is a derived view of `messageQueueV1` (queue + inFlight + discarded). Actions like “send now”, discard, and delete are performed via metadata updates, with fail-closed ordering so send failures never delete items.

### 3. Capabilities Protocol
Machine introspection has been standardized into a flexible **Capabilities Protocol**, replacing ad-hoc RPCs. This allows to easily detect what is currently installed on the user's computer and surface clear options
*   **Checklist-based Discovery:** The UI requests capabilities via `capabilities.detect` (e.g., checking for "new-session" requirements or "resume" support).
*   **Protocol surface:** `capabilities.describe` / `capabilities.detect` / `capabilities.invoke` support checklist-driven discovery (e.g. `new-session`, `machine-details`, `resume.codex`) and user-initiated install/upgrade operations.
*   **Unified Snapshot:** The daemon returns a comprehensive snapshot of installed tools (Claude, Codex, Gemini, Tmux, OpenCode) and their versions/status.
*   **ACP probing:** capabilities detection covers ACP backends (including Codex ACP dependency checks) so the UI can gate “new session” and “resume” flows on actual machine support.
*   **Dependency Management:** The protocol supports checking and installing helper binaries (like the `codex-mcp-resume` bridge) into a managed prefix (e.g. `~/.happy/tools/codex-mcp-resume`).
    *   The app maintains an installable-deps registry used by Machine/New Session screens (e.g. Codex MCP resume + Codex ACP).
*   **Machine-level UX:** machine screens/pickers can surface detected CLI status (with caching + stale-while-revalidate refresh and safe timeouts) so users can quickly diagnose “tool missing / not logged in / daemon too old” states.
*   **Hook timestamp stability:** `useCLIDetection` now produces a stable timestamp even when loaded snapshots lack `checkedAt`, avoiding UI flapping; covered by fake-timer tests.
*   **Cache reliability:** capabilities caches transition to `error` on detection throws (avoids “stuck loading” states while preserving any previous snapshot).
*   **Cache race hardening:** capabilities cache updates are guarded by in-flight tokens so late/stale requests cannot overwrite newer loaded results; covered by a dedicated race regression test.
*   **Probe robustness + UX polish:** ACP probes fail closed with normalized error shapes and hardened termination semantics; installable deps UI strings/dropdowns are localized and update badges use semver comparison; Gemini config loading is ESM-safe.
*   **Diagnostics details:** `detect-cli` is daemon-side (PATH scan, no login shell) and can include best-effort `version` and optional `isLoggedIn` probes (plus `tmux`), guarded by timeouts so it never blocks core flows.
    *   Version parsing is tolerant (scans combined stdout+stderr, not just the first line) to reduce false “unknown version” states.
*   **Probe tuning:** tuned `tmux` version probe timeouts (e.g. 1.5s) to reduce false negatives on slow hosts.
*   **Shared protocol contracts:** `@happy/protocol` defines shared daemon↔app contracts (RPC result shapes/error codes, checklist helpers, socket RPC event typing) so the CLI/daemon and Expo app stay in sync without copy/paste drift.

---

## 🤖 Agents & Runtimes

### ACP providers (OpenCode + Auggie)
*   **OpenCode ACP:** a first-class ACP-backed agent runtime with consistent tool rendering/lifecycle semantics (see ACP runtime notes below). Vendor resume support is not available yet (see Known Issues).
*   **Auggie ACP (experimental):** an ACP-backed agent runtime that is experiment-gated in the app, with per-session spawn options (e.g. an indexing toggle) surfaced through the UI and persisted in session state.

### Agent catalog (Expo + CLI)
*   **Shared agent ids + manifest:** `@happy/agents` provides canonical `AgentId` and shared agent metadata used across the Expo app and CLI (resume gating, connect targets, and stable identifier mapping).
*   **Expo catalog facade:** the app uses a single catalog entrypoint (`expo-app/sources/agents/catalog.ts`) backed by per-agent providers (`expo-app/sources/agents/providers/*`) so agent UI behavior/copy/capability wiring is centralized and testable.
*   **CLI backend catalog:** agent-specific logic lives under `cli/src/backends/<agentId>/**` and is composed via `cli/src/backends/catalog.ts` to drive CLI subcommands, detection snapshots, capability/checklist contributions, daemon spawn hooks, and ACP backend factories.
*   **Extensibility:** adding a new agent is primarily “add catalog/provider/backend entries”, rather than editing many unrelated screens/commands/rpc handlers; this reduces wiring churn and makes integrations easier to review.

### ACP runtimes (Codex + OpenCode + Auggie)
ACP runtimes support multiple ACP-backed agents with consistent UI semantics.
*   **New runtimes:** full runtime support for **Codex ACP**, **OpenCode ACP**, and **Auggie ACP**, including transport wiring and session id management.
*   **Tool Normalization:** Implemented a normalization layer that standardizes tool events (calls/results) across different backends, ensuring consistent rendering in the UI.
*   **Replay Support:** Added infrastructure to capture and import ACP session history for debugging and regression testing.
    *   Includes replay capture/import helpers and `loadSession` support on the CLI side, plus slash-command publishing for ACP backends.
*   **Slash commands:** when ACP backends report available commands, they are published into session metadata so the UI can surface slash-command affordances consistently across agents.
*   **Task lifecycle edges:** CLI runtimes emit durable ACP lifecycle events (`task_started`, `task_complete`, `turn_aborted`) with stable task ids so the UI can render agent “thinking/task” boundaries consistently across backends.
    *   CLI agent entrypoint aligns subcommands/startup flags across backends (OpenCode wiring, Codex/Gemini argument alignment, and `--permission-mode-updated-at` parsing), and supports `--existing-session` and vendor `--resume` where applicable.
    *   ACP stdio is hardened: stdin write failures propagate (not silently swallowed) and stdin drain is guarded to avoid hangs (including “synchronous drain” edge cases in Node stream adapters).

### Claude Reliability & Switching
Significant hardening of the Claude local/remote runner.
*   **Hook-Mode Continuity:** The runner now preserves the `transcript_path` reported by hook scripts. This allows switching between Remote and Local modes without losing session context.
    *   Tests cover the `transcriptPath` surface to prevent regressions.
*   **Switch preflight:** switching waits briefly for hook session/transcript info (with a visible status message) to avoid switching with missing sessionId/transcriptPath.
*   **Fork safety on resume:** when starting local from an existing session, the runner clears stale session info until the new hook data arrives; if spawn fails before the forked session is reported, it restores the previous sessionId/transcriptPath so remote mode can still resume it.
*   **Transcript availability UX:** when attaching to a fresh local session before its transcript file exists, the CLI emits a clear session status message and the scanner begins streaming automatically once the transcript appears (avoids “blank” remote sessions).
*   **Resume validation robustness:** remote resume attempts continue even if transcript validation has not passed yet, avoiding false-negative context loss during fast switching/initialization.
*   **Signal Forwarding:** The CLI now correctly forwards OS signals (`SIGINT`, `SIGTERM`, `SIGHUP`) to the underlying Claude binary, preventing orphaned processes.
    *   Forwarding is hardened to avoid orphan lifecycle events and to re-raise forwarded signals where appropriate (reduces “stuck running” and exit-code confusion).
    *   _Credit:_ Thanks to @fberlakovich — commits ported into the monorepo from [slopus/happy-cli#127](https://github.com/slopus/happy-cli/pull/127).
*   **Switching Idempotency:** The `switch` RPC is idempotent and does not thrash mode state under repeated calls.
*   **Remote→local switch safety:** when switching to local mode while messages are queued/pending, the terminal prompts with a preview and requires explicit confirmation.
    *   If confirmed, queued/pending items are discarded in session metadata (so they can be recovered/reviewed later from the app’s discarded/pending UI) and the switch proceeds.
    *   If declined, the switch is canceled and remote mode continues (no surprising “silent” state changes).
*   **Remote↔local switching reliability (non-tmux):** hardened the Claude remote-mode Ink UI and teardown to prevent terminal corruption/buffered-input leaks (deterministic key handling incl. `Ctrl+T`, raw-mode reset + brief stdin drain after Ink unmount, and non-async input handlers with cancellable timeouts).
*   **Scanner + CLI flag correctness:** session scanning tolerates consumer callback exceptions; Claude local-runner treats `-c` as `--continue` for session control detection; and remote runner handles `--resume/-r` with or without an id (without id resumes the most recent valid UUID session for the project).
*   **Config dir robustness:** `CLAUDE_CONFIG_DIR` overrides are trimmed so accidental whitespace doesn’t create wrong paths.
*   **Local runner robustness:** orders `claudeArgs` last for slash-command correctness, forwards OS signals to spawned local children, and treats abort errors as expected (reduces spurious “process error” noise).
    *   _Credit:_ Thanks to @jiogallardy and @cruzanstx — commits ported into the monorepo from [slopus/happy-cli#139](https://github.com/slopus/happy-cli/pull/139) and [slopus/happy-cli#120](https://github.com/slopus/happy-cli/pull/120).
*   **AskUserQuestion / ExitPlanMode tools:** the app completes these Claude tool interactions via the existing session `permission` RPC.
    *   AskUserQuestion attaches structured `answers` keyed by the question text when supported; otherwise it falls back to denying the tool call and sending a normal user message with the same content so older agents can proceed.
    *   ExitPlanMode uses allow/deny without injecting extra chat messages, and denial can include a free-text “request changes” reason that Claude can use to revise the plan in-place. Tool UIs require a `permission.id`, fail-closed when missing, and show localized errors on submit failures.

### Codex Approvals & MCP Interaction
*   **ExecPolicy Amendments:** Added native UI support for Codex's "Always allow this command" flow. The approval decision is passed via the permission system with the specific command amendment payload.
    *   _Credit:_ Thanks to @OrdinarySF — commits ported into the monorepo from [slopus/happy#299](https://github.com/slopus/happy/pull/299) and [slopus/happy-cli#102](https://github.com/slopus/happy-cli/pull/102).
*   **Tool ID Alignment:** Permission requests and cached amendments are now strictly keyed by the **MCP Tool Call ID** to prevent mismatches.
*   **MCP result correctness:** Codex MCP tool results preserve falsy `{ Ok: ... }` / `{ Err: ... }` outputs (no lossy `||` fallthrough), with unit tests.
    *   Tool correlation prefers stable `call_id` where available, reducing “wrong tool result attached” edge cases.
*   **MCP tool calls surfaced:** Codex `mcp_tool_call_begin` / `mcp_tool_call_end` events are surfaced into the transcript as tool calls/results (prefixed `mcp__...`) for consistent UI rendering.
*   **MCP bridge reliability:** the Happy MCP bridge is launched via `process.execPath` (node/bun) to avoid relying on `.mjs` executable bits across runtimes.
    *   _Credit:_ Thanks to @OrdinarySF — commits ported into the monorepo from [slopus/happy-cli#101](https://github.com/slopus/happy-cli/pull/101).
*   **MCP transport safety:** Codex MCP server detection is more tolerant of version output (`codex` vs `codex-cli`, optional `v` prefix) and avoids printing full elicitation payloads to stdout (debug-only, redacted logging instead).
*   **Tool tracing (debugging):** CLI can emit JSONL tool traces and includes a fixture extractor script for building stable tool/permission fixtures from traces.
    *   Tracing includes permission request/response events and is broadened for more tool surfaces (while keeping metadata wakeup safety).

---

## 🛡️ Permissions & Safety

### Persistent Permission State
*   **Message-Derived Restoration:** Permission modes (e.g., "Read-Only", "Safe-Yolo") are now inferred from the **last user message** in the transcript. This ensures that permission state follows the session history accurately across devices, even if local state is lost.
*   **Arbitration:** Permission changes are arbitrated using server-aligned timestamps to prevent race conditions when multiple devices update the mode simultaneously.
*   **Default Permissions:** Users can now define default permission modes per Agent Type (e.g., default to "Read-Only" for Codex but "Plan" for Claude) in their profile settings.
*   **Cross-agent normalization:** permission modes are normalized/clamped per agent and mapped across flavors (Claude ↔ Codex/Gemini) so switching agent types preserves intent instead of silently falling back to incompatible modes.
*   **Carry mode across remote↔local:** sessions track `lastPermissionMode`, and local spawns/threading update CLI args so switching local/remote does not drop the active policy.
*   **Permission mode options helper:** centralized per-agent mode lists/labels/icons and normalization to prevent UI drift between agents (descriptions are still hardcoded English where used).
*   **Mode cycling correctness:** keyboard/UI cycling is clamped to the active agent’s valid modes so users can’t get “stuck” on an invalid mode.
*   **Per-session allowlists (Codex/Gemini):** CLI persists “always allow” tool approvals per session using a stable tool identifier and a hardened shell command allowlist, with focused unit tests.
*   **Metadata-published mode:** the CLI publishes `permissionMode` (+ `permissionModeUpdatedAt`) into session metadata at session creation and on changes (Claude/Codex/Gemini), so the UI can seed state even before the first app-originated message meta exists.
*   **No-op stability:** permission mode updates do **not** bump `permissionModeUpdatedAt` unless the effective mode actually changed (prevents “latest wins” churn overriding real user selections).

### Secrets Vault
*   **Encrypted Storage:** credentials and sensitive env vars are sealed in `SecretString` containers before persistence. Plaintext values are never stored in settings.
*   **Requirement Resolution:** A new `SecretRequirementModal` resolves missing secrets at spawn time, allowing users to provide "session-only" keys in memory ("Enter Once") or select from the vault.
    *   Secret requirement UX is modularized and can be used via a dedicated picker route in the New Session flow.
*   **UI Privacy:** Env var cards enforce masking (`***`) for vault-backed values.
*   **Inline add UX:** saved secrets (and env vars) can be added inline via an expander with Cancel/Save actions (reduces modal churn; covered by tests).
*   **Saved Secrets + bindings:** secrets are stored as **Saved Secrets** and can be bound per profile/env var (profile → env var → secret id). Drafts never persist plaintext; session-only values are encrypted before draft persistence.
*   **Tolerant parsing:** one malformed saved secret no longer wipes other valid secrets (invalid entries are dropped individually; regression test included).

### Daemon Process Safety
*   **Strict Reattach:** The daemon persists "session markers" to disk. On restart, it only re-adopts processes if the **PID and Command Hash** match exactly.
*   **Safe Kills:** The daemon verifies process identity before sending SIGTERM, preventing accidental killing of reused PIDs.
*   **Cross-stack safety:** marker adoption and webhook updates are gated by `HAPPY_HOME_DIR` so a daemon never reattaches or kills sessions from another stack.

---

## 🖥️ Terminal & Session Management

### Inactive Session Resume
Users can now reconnect to stopped or crashed sessions.
*   **Resume Flow:** The UI offers a "Resume" action for inactive sessions.
*   **Codex Resume:** Implemented via a `codex-mcp-resume` bridge that re-hydrates session context using MCP.
*   **Experimental gating (Codex):** Codex resume is disabled by default and requires explicit enablement (UI experiment + per-spawn flag), plus daemon-side gating (fail-closed) so we never “silently” resume Codex without user intent.
*   **Resume server install/status (Codex):** machines can report/install the Codex resume MCP server into a Happy-owned prefix (with logged installs + version/status reporting, Windows-aware binary checks).
    *   The install spec is explicit/user-provided (default is empty) so we don’t ship fork-specific defaults as global behavior.
    *   Codex resume install/update/reinstall modals are localized in both Machine and New Session screens and share consistent success/error framing (including `deps.*` status strings).
*   **Local session persistence:** the machine persists a per-session file under `HAPPY_HOME_DIR/sessions/<happySessionId>.json` (metadata, agentState, versions) to make reattach/resume possible.
*   **Resume plumbing (Happy session resume):** the UI calls a `resume-session` RPC and securely provides the **session encryption key** so the daemon can reconnect to the existing Happy session (`--existing-session <happySessionId>`). This path is intentionally UI-only (a CLI user cannot resume an existing Happy session without the key).
*   **Safer resume flow:** resume avoids passing message payloads via spawn env; instead the UI enqueues the user message first (pending/metadata queue), then requests a spawn-only resume so the agent drains staged messages normally.
*   **Vendor resume (CLI-supported):** the CLI supports resuming *vendor* sessions inside **new Happy sessions** via `--resume <vendorSessionId>` where supported (Claude baseline; Codex is experimental and gated; OpenCode currently falls back because its ACP backend lacks `loadSession`).
*   **New-session resume:** New Session supports selecting a resume id (capability-gated), persists it in the New Session draft, and includes it in the spawn payload when supported.
*   **Resume request shape hardening:** UI resume no longer requires passing an `agentSessionId`; resume is keyed by Happy session id + agent type so vendor-id derivation happens on the machine/daemon side.
*   **Capability-gated resume UX:** resume affordances are gated by machine capabilities/agent registry (per agent type) and the session UI surfaces clearer inactive/offline/pending notices during resume workflows.
    *   Resume capability helpers use the agent registry and include vendor resume-id lookup helpers; temp session data is typed to `AgentId` to reduce agent-type mismatches.
*   **Offline resume safety:** offline/continue tooling uses a safer `offlineSessionStub` (EventEmitter-based, aligned to the real client surface) to avoid “missing method/event” crashes.

### Tmux & Headless Support
*   **Headless Mode:** Support for spawning "headless" sessions via `happy-cli --tmux`.
*   **Attach Tooling:** New `happy attach` command handles identifying and attaching to running tmux sessions.
*   **Security:** Fixed path traversal vulnerabilities in terminal attachment metadata filenames (`encodeURIComponent` for session filenames) and blocks unsafe legacy fallback reads when `sessionId` contains path separators.
*   **Attach metadata:** CLI records per-session terminal metadata (requested mode, fallback reason, tmux target/tmpDir) and persists local attach info atomically once a session ID exists (Codex/Gemini/Claude parity).
*   **TMUX correctness:** targeting/parsing is hardened (prefers `TMUX_PANE`, rejects invalid target injection, correct kill-window targeting) with focused tests.
*   **TMUX instance isolation:** supports per-instance socket paths (`-S <socket>`) and passes `TMUX_TMPDIR` via the tmux command environment (not conflated with socket path), with deterministic session selection and opt-in integration tests.
*   **Tmux reliability:** tmux spawn/attach is hardened (including retrying `new-window` on index conflicts) and avoids attach/spawn edge cases that could desync terminal state.
*   **Daemon tmux spawn:** daemon accepts terminal spawn options, supports tmux spawn + isolated servers, strips legacy `TMUX_*` env from agent env, and passes internal runtime flags to surface fallback reasons when tmux is unavailable.
*   **Headless argv validation:** headless tmux argv validation fails closed on missing/invalid `--happy-starting-mode` values.

### General Improvements
*   **Remote-Only Agents display in terminal:** we have made it clearer in the CLI when starting remote-only agents (Codex, OpenCode, Gemini), so that users are not confused anymore as to why they cannot send messages using the terminal to those agents.
*   **`happy connect` clarifications:** we also made it clearer which providers currently supports `happy connect` and which ones are not wired into Happy yet (only connection work, but then it's not effectively used anywhere yet), to reduce confusion with `happy connect claude` and `happy connect codex` not changing the authentication of the CLI yet.

---

## 🤝 Session Sharing (Friends + Public Links)

Happy sessions can be shared securely with other users, either directly (friends-only) or via a public view-only link.

*   **Direct sharing (friends-only):** a session owner/admin can share a session with friends and assign an access level (`view`, `edit`, `admin`). Shared sessions appear in the session list with clear indicators.
    *   Sharing management is restricted to the session owner/admin (non-admin recipients cannot manage shares).
    *   The session view enforces access levels (e.g. view-only disables sending/agent input).
*   **Public share links (view-only):** a session owner can create a public link with optional expiry and max-uses limits.
    *   Public share access is always view-only for safety.
    *   Links can require explicit consent before access when detailed access logging is enabled.
*   **Key handling + privacy:** the session data encryption key is wrapped for sharing:
    *   For direct sharing, the client encrypts the session DEK for the recipient using their published content public key (verified against the recipient’s signing key binding).
    *   For public links, the client generates a token and encrypts the session DEK using that token; the server stores only a hash of the token (not the token itself).
*   **Realtime updates:** share changes (direct shares and public links) emit realtime events so owners/recipients see updates promptly without a full refresh.
*   **Feature gating:** the server exposes `/v1/features` so the app can detect whether session sharing/public sharing/content keys are supported and adjust UI accordingly.
*   **Credit:** Thanks to @54m [slopus/happy#356](https://github.com/slopus/happy/pull/356) (UI) and [slopus/happy-server#25](https://github.com/slopus/happy-server/pull/25) (server) — this PR ports those changes into the monorepo and applies additional fixes/hardening.

## 💅 UI & UX Improvements

### New Session Wizard
*   **Complete Rewrite:** The creation flow is now a route-based wizard (`NewSessionWizard`) with dedicated pickers for Machine, Path, and Profile.
*   **Profile 2.0:** Migrated profiles to be purely environment-variable based (removing legacy provider configs).
*   **Pre-flight Checks:** The wizard runs `preview-env` to ensure the selected machine meets the profile's requirements before spawning.
*   **Picker/navigation stability:** picker screens avoid inline `Stack.Screen` options and pick flows were stabilized to reduce “stale selection / wrong route params” issues; wizard can pre-visualize the selected machine for faster verification.
*   **Web + resume UX polish:** on web, the new-session wizard is presented in a `BaseModal` with an explicit header/close; Codex resume “not installed” dialogs are localized and route users to the Machine screen to install/inspect the resume server.
*   **Wizard polish:** Codex resume banner strings in the wizard are localized and wizard sections use shared header-row primitives for consistency.
*   **Draft persistence + pick flows:** wizard state is persisted before navigating to picker/edit screens, so leaving the wizard doesn’t reset inputs; selections are returned via route params (not global callback plumbing).
*   **Resume pick reliability:** resume session id selection is persisted in new-session drafts and paste-from-clipboard is hardened (safe fallback when clipboard reads fail).
*   **iOS navigation reliability:** picker and profile-edit screens are also presented as iOS `containedModal` (with explicit back buttons) so they never render “behind” the wizard modal.
*   **Recent/favorites UX:** added recent machines/paths helpers and more deterministic favorites/search behavior in picker screens (with feature toggles for picker-search UX).
*   **Agent compatibility correctness:** when the profile changes, the wizard clamps agent type to supported backends and maps permission modes across agents rather than resetting blindly.
*   **Secrets + terminal integration:** the wizard resolves required secrets via the secrets/vault flow (machine env presence checks, saved-secret bindings, or “enter once”), and passes terminal/tmux spawn options into session creation (including tmux warnings when requested but not detected).
*   **Performance hardening:** draft/settings writes are debounced and often deferred via `InteractionManager.runAfterInteractions` on native to keep iOS taps/animations responsive.

### UI Primitives & Polish
*   **Unified Overlay System:** Introduced `Popover` and `OverlayPortal` to handle floating UI consistently on Web (Radix-based) and Native.
*   **Modal Fixes:** Fixed iOS touch-blocking on stacked modals and restored Expo Web modal behavior (enables `EXPO_UNSTABLE_WEB_MODAL=1`, pins/patches `expo-router`, and ensures patches apply in both hoisted and non-hoisted installs).
    *   Also pins `libsodium-wrappers` to a compatible version and aligns patch-package directories so the Expo-router patch is applied reliably.
*   **List + row-action primitives:** added a shared `SearchHeader`, refactored `SearchableListSelector` grouping/search placement, and added inline row actions with an overflow menu modal (plus click-through guards).
*   **List/pending polish:** added reusable item-group row-position/title primitives and refined list/pending UI for more consistent layout/behavior (with targeted divider/row tests).
*   **Unsaved-changes prompts:** added a reusable “discard/save/keep editing” alert helper used by picker-friendly edit screens.
*   **Popover + portal overlays:** added `OverlayPortalHost`/`OverlayPortalProvider` and a `Popover` primitive with web/native portal support, spotlight/backdrop options, and a `ModalPortalTargetProvider` for correct web focus/stacking inside modals.
*   **Popover hardening:** improved web anchor measurement (DOM `getBoundingClientRect()` fallback + retries) and iOS portal pointerEvents to prevent invisible/click-through overlay failures.
    *   Web popover positioning accounts for scroll offsets and uses a dedicated portal target + more robust measurement to avoid “misplaced overlays” during scroll/resize.
*   **Scroll edge indicators:** list edge indicators are shown without fades when appropriate (improves discoverability without relying on subtle animations).
*   **WebAlertModal safety:** ensures an empty `buttons: []` config still renders a default `OK` button (prevents non-dismissible alert modals).
*   **Overlay action reliability:** improved “close-then-act” behavior for row-action menus (`InteractionManager` with timeout fallback) so actions aren’t delayed indefinitely under continuous interactions.
*   **i18n hygiene:** many previously hard-coded UI literals (including error alerts and permission/microphone prompts) are now translated via `t(...)` keys; tooling was added to help find remaining untranslated literals.
*   **Specialized Tool Views:** Added optimized renderers for common tools (Bash, ReadFile, Grep) and structured ACP results.
    *   Tool views handle additional ACP shapes (e.g. diff items and “read” aliases) and can infer pending permissions from tool-call surfaces to keep the transcript state consistent.
*   **Error Surfacing:** Agent errors (Codex/Gemini quota, MCP failures) are now surfaced as visible status messages in the transcript.
    *   Includes formatted “status” events forwarded from CLI runtimes so Codex/Gemini startup/stream/tool failures are actionable (not silent hangs).
    *   Includes follow-up polish for Codex MCP startup failures and Gemini quota reset formatting (regression-tested).
*   **Input + editor polish:** prompt input adapts to keyboard height on native and env-var editor cards were refined for clearer editing ergonomics.

---

## 🛠️ Foundations & DevX

*   **Test Harness:** Root scripts validate the full monorepo surface (expo-app + cli + server) via `happys test/typecheck`. Added **Vitest stubs** for Expo/React Native modules to enable fast Node-based unit testing of UI logic.
*   **Test deps alignment:** updated `react-test-renderer` to stay aligned with the repo’s React version (prevents subtle test renderer mismatches).
*   **Expo iOS build stability:** patched `@more-tech/react-native-libsodium` podspec evaluation so `pod install` doesn’t fail when `folly_version` is undefined (falls back to `RCT-Folly` when needed).
*   **Expo install + web runtime stability:** deterministic `expo-app` postinstall that reliably runs `patch-package` even when hoisted; includes libsodium-wrappers patching plus a web adapter that forces the CJS build to avoid Metro parsing failures from ESM/top-level `await`.
    *   Also runs patching from both repo root and `expo-app/` so patches apply for hoisted deps *and* non-hoisted deps (e.g. `expo-router`).
    *   Postinstall includes verification that critical patches (e.g. `expo-router`) were actually applied, failing fast when patching silently didn’t happen.
*   **App variant hardening:** added opt-in overrides (`EXPO_APP_NAME`, `EXPO_APP_BUNDLE_ID`, `EXPO_APP_SCHEME`) and safe fallbacks when `APP_ENV` is unknown (prevents undefined config values, reduces multi-install collisions).
*   **Test determinism:** defines `__DEV__ = false` in Vitest so dev-gated code paths behave predictably under unit tests.
*   **Unistyles Migration:** Migrated the entire codebase (`expo-app`) from `StyleSheet` to `react-native-unistyles` for consistent theming.
    *   Includes a guard test to enforce “no `StyleSheet` imports from `react-native`” and prevent regressions.
*   **Repo commit conventions:** added Conventional Commits guidelines for tooling (Copilot commit instructions).
*   **Workspace hygiene:** ignores `.project` artifacts and adds naming-conventions documentation used by tooling/agents.
*   **i18n Sweep + tooling:** refactored i18n types to be derived from `translations/en.ts`, expanded locale dictionaries for new surfaces, and added scripts to compare translation coverage and scan for likely-untranslated literals (with follow-up parsing fixes for file kinds and `:` in literal grouping keys).
    *   Adds device locale helpers (shared + native) used by the text/runtime layer when selecting the best locale.
*   **Production log hygiene:** gated noisy detection/realtime debug logs behind `__DEV__` (keeps errors as errors; avoids incidental message/metadata logging).
*   **Log Redaction:** Hardened CLI logging to redact env vars and secrets from debug output.

---

## 📦 Appendix: Additional Details

Additional implementation details and edge-case hardening notes that didn’t fit cleanly in the high-level sections above.

### Auth & Storage Scoping

*   **Auth token persistence hardening (web):** `tokenStorage` no longer throws on malformed `localStorage` JSON; `setItem/removeItem` failures return `false` (quota/security errors handled).
*   **CLI auth ergonomics:** `happy auth login --no-open` (and `HAPPY_NO_BROWSER_OPEN`) skips auto-opening a browser for login; unit-tested.
*   **Scoped native storage:** storage keys (and selected MMKV ids) are scope-qualified via `EXPO_PUBLIC_HAPPY_STORAGE_SCOPE` to prevent cross-stack/worktree state bleed on device.
*   **Unauthenticated route guard:** app layout redirects unauthenticated users off protected routes (public allowlist is explicit) to prevent flashes of protected screens.
    *   Includes a follow-up fix to avoid React hooks-order violations in the redirect path (regression-tested).
*   **Auth failure surfacing:** raw message parsing tolerates `usage.service_tier: null` so messages/events aren’t dropped on schema failures (helps keep auth/401 failures visible).

### Settings, Profiles, and Requirements

*   **Settings parsing hardening:** tolerant per-field parsing so one invalid field doesn’t reset everything; invalid profiles are filtered individually instead of failing the whole settings object.
*   **Profile shape migration:** legacy provider config objects are normalized into `environmentVariables` entries (e.g. `OPENAI_*`, `ANTHROPIC_*`, `AZURE_OPENAI_*`, `TOGETHER_*`); non-persistable fields (e.g. `startupBashScript`, `tmuxConfig.updateEnvironment`) are dropped from the persisted GUI profile model.
*   **Settings sync convergence:** added “always write” `replaceSettings(settings, version)` to converge after server/account switching or server-side resets (used to prevent version mismatch retry loops).
*   **Env var templates:** added parse/format support for `${VAR}`, `${VAR:-fallback}`, `${VAR:=fallback}` and bash-like empty-string fallback semantics.
*   **Profiles:** profiles are now centered on env-var requirements/selection (with supporting UX + built-in profile gating fixes).
*   **`preview-env` end-to-end:** UI prefers daemon-computed “effective spawn env” (supports `extraEnv` expansion + secrets policy `none|redacted|full` + per-key sensitivity metadata); falls back to *non-sensitive only* bash probing when unsupported (node-backed JSON protocol when available; robust unset sentinel parsing; avoids pulling secret-like values into UI memory). Daemon handler validates key names and caps requests; sensitive-key detection is heuristic with an overridable (safe-fallback) regex.
    *   `preview-env` accepts lowercase keys and explicitly blocks prototype-pollution keys (`__proto__` / `constructor` / `prototype`), using `Object.create(null)` to avoid inherited properties.
*   **Model modes:** per-session model-mode persistence + UI allowlisting/clamping (invalid model modes cannot be written from the session UI; persisted maps are filtered to an allowlist).
*   **Experiments + agent-input customization:** settings gained per-experiment toggles (preserving legacy “master experiments” behavior) and new agent-input layout/density controls.
    *   The master “experiments” toggle also controls Codex resume enablement (so disabling experiments disables `expCodexResume`).
*   **Session settings consolidation:** message-send policy and tmux preferences are unified under session settings (`sessionMessageSendMode`, `sessionUseTmux`, etc.) with migrations/aliases for legacy keys and routes.
    *   Settings list items are localized (e.g. the Session settings row title/subtitle), and Spanish experiment subtitles are fully translated.
*   **Credential requirements resolver:** profiles can declare required secret env vars / machine-login requirements; UI preflights readiness via `preview-env` and provides a resolver modal (use machine env, select a saved credential, or enter once for session-only use).

### Sessions UX

*   **Message list quality-of-life:** unread badges, inactive-session grouping, archive fallback behavior when kill RPCs aren’t available, and small transcript/message conveniences (e.g. copy-to-clipboard for message blocks).
    *   Unread state is cross-device: read markers are stored in encrypted session metadata (`readStateV1`) and updated on focus/blur with debounced writes.
    *   Path display is safer: avoids false “under home” matches when formatting paths relative to `homeDir`. Session list formatting consistently shows `~`-prefixed home-relative paths.
*   **Session rename:** session info screen supports renaming by updating encrypted session metadata via `update-metadata` (version-checked), with a prompt-based UX.
*   **Agent-visible errors:** improved surfacing of agent failures (Codex/Gemini quotas/MCP failures) as explicit transcript status, not silent failures.
    *   Session-level error fallbacks and profile-info modal copy are localized (avoids hard-coded English “Error / failed to …” messages).
*   **Codex runtime correctness:** Codex ignores per-message model overrides; permission-mode changes restart Codex sessions with explicit context drop (no automatic resume attempt), and mode hashing ignores `model` to avoid spurious restarts.
*   **Codex/Gemini readiness:** prime `agentStateVersion` immediately after session creation so UI readiness flips true without requiring an `update-state` event.

### CLI / Sync / Daemon reliability

*   **Daemon ownership gating:** reattach/restart safety based on persisted per-PID “session markers” under `HAPPY_HOME_DIR`, strict PID classification, and process-command-hash verification; avoids unsafe cross-process interactions and PID reuse hazards.
    *   Resume requests are idempotent (avoid duplicate processes), and the daemon maintains per-session attach files/metadata merges to support safe reattach and clearer session startup behavior.
    *   The daemon reports and persists session termination (including keeping sessions tracked until exit) so the app/CLI can present accurate session end state.
*   **Atomic daemon state persistence:** daemon state reads are schema-validated (Zod) and retried on transient errors; writes are atomic (tmp + rename, with Windows fallbacks and tmp cleanup).
    *   Includes a retry path for `ENOENT` when the daemon state file appears shortly after startup (race hardening; regression-tested).
*   **Refactor + opt-in integration tests (daemon):** extracted `pidSafety`/`reattach` helpers and added opt-in “real process” integration tests gated by `HAPPY_CLI_DAEMON_REATTACH_INTEGRATION=1` for validating PID hashing + marker adoption on the host OS.
*   **CLI reconnection correctness:** waiter lifecycle cleanup, reconnection/backoff hardening, and metadata/socket coordination fixes.
    *   Includes a fix where `waitForMetadataUpdate()` resolves `false` on socket disconnect and always cleans up listeners (prevents hanging awaiters; tested).
*   **Capabilities cache race hardening:** prevents late/stale overlapping prefetches from overwriting newer loaded snapshots (token-guarded updates; race regression test).
*   **Runtime support (daemon subprocesses):** daemon-spawned subprocess invocation supports `node` or `bun` (selectable) with tested invocation building; missing entrypoints surface a clear error instead of failing silently.
*   **Sync robustness:** transport parsing guards + disconnect/await safety for reliability in flaky connectivity scenarios (kept separate from MessageQueueV1 semantics).
    *   Includes a fix to ensure `invalidateAndAwait()` never hangs forever when the sync command throws (awaiters resolve; retries are bounded; tests included).
    *   Failures are counted consistently even under custom backoff implementations (`failuresCount` increments per attempt; tests de-flaked by stubbing jitter).
    *   Metadata waiters are hardened against lost wakeups and abort races, avoiding “hang forever” edge cases under concurrent message/pending events.
*   **RPC compatibility signal:** server returns a structured `errorCode=RPC_METHOD_NOT_AVAILABLE` (while preserving legacy message strings) so the app can do reliable back-compat fallbacks without brittle string matching.
*   **Sync perf + crash-safety:** debounced pending settings persistence with flush-on-background to avoid losing last-second toggles; added a de-duped `refreshMachinesThrottled` helper to prevent network churn.
*   **Error parsing hardening:** guards JSON parsing for non-JSON error bodies (e.g. GitHub OAuth config 400 and disconnect 404s) and preserves correct `HappyError(kind/status)` typing.
*   **Spawn safety boundaries:** GUI-spawned sessions do not inherit the CLI’s active profile implicitly; profile env injection is opt-in from the caller (prevents surprising env leakage).
*   **Profile identity propagation:** `profileId` is threaded through daemon spawn into session metadata (identity only; separate from env var contents), enabling consistent UI display across devices.
*   **Log redaction (daemon/CLI):** spawn logs no longer print tokens or env var values; doctor output masks `${VAR:-default}` / `${VAR:=default}` templates to avoid leaking embedded secrets.
*   **Offline buffering restored:** CLI socket sends rely on socket.io buffering when disconnected (with tests), instead of refusing to emit while offline.
*   **Spawn env flexibility:** spawn RPC accepts arbitrary env var maps (typed as `Record<string,string>`) to keep GUI/CLI interoperable as provider keys evolve.
    *   Spawn env inputs are sanitized (including prototype-pollution defenses) before use to reduce risk from untrusted keys.
*   **CLI profile schema alignment:** CLI persistence drops legacy provider config objects and migrates them into env vars at parse-time (preserves data; env-var based profiles are the single source of truth).
*   **Legacy tmuxConfig removal:** CLI profile schema removes deprecated `tmuxConfig` and stops exporting tmux env vars from profiles (terminal behavior is driven by explicit terminal spawn options).

### Server hardening beyond “Server Light”

*   **Serve UI from server:** hardened optional static UI serving and SPA fallback behavior; improved missing bundle/index handling (404 vs 500), including in SPA error handlers.
*   **Public files safety:** strict path normalization and segment-wise URL encoding in file serving routes (rejects traversal/absolute/drive-letter input; encodes `#`/`?` safely).
*   **Storage validation (S3/Minio):** fail-fast env validation and bucket existence checks (validates `S3_PORT` range and errors if the bucket does not exist).

### Misc

*   **Codex `/clear` handling:** treat `/clear` as a session boundary so Codex session state resets deterministically.
    *   _Credit:_ Thanks to @zkytech — commits ported into the monorepo from [slopus/happy-cli#72](https://github.com/slopus/happy-cli/pull/72).
*   **Friends UX/reliability:** follow-up hardening for friends surfaces (e.g., stable error handling/search behaviors, localized search failure messaging via stable error codes).
    *   Friends/Inbox routes are experiment-gated (with hooks + settings toggle) so access/routing is consistent when the feature is disabled.

---

## ✅ Test Plan (what maintainers should validate)

This is the suggested “high-signal” manual test checklist for the master PR:

*   **Server Light:** boot light flavor, create sessions, verify SQLite persistence, verify local-files/public-file serving, verify optional UI serving (SPA routes + missing bundle handling).
*   **MessageQueueV1:** queue messages while agent is busy/offline, resume connectivity, verify CAS semantics prevent duplication, verify in-flight removal happens only after delivery confirmation.
*   **Capabilities + `preview-env`:** verify capability detection for key tools (Claude/Codex/Gemini/Tmux/OpenCode), verify `preview-env` detects missing requirements and wizard shows actionable preflight errors.
*   **Session Sharing:** share a session with a friend, verify access levels (`view/edit/admin`) and enforcement (view-only disables send), verify realtime updates on share changes, create/rotate/disable a public link (expiry/max-uses), verify consent-required flows, and verify `/share/[token]` viewing works as expected.
*   **Secrets Vault:** create/select secrets, verify masking/redaction (no plaintext persistence), verify requirement modal supports “enter once” vs vault selection.
*   **Permissions:** verify default mode per agent, verify mode restoration from transcript across device restart, verify agent-specific allowlists/approvals (Codex/Gemini), verify AskUserQuestion/ExitPlan flows complete via the session `permission` RPC (including answers-on-permission where supported).
*   **Resume:** resume inactive sessions end-to-end (Claude + Codex), verify no transcript loss, verify terminal/runner state is rehydrated correctly.
*   **Terminal/TMUX:** headless tmux session spawn, attach to existing sessions, verify targeting correctness, verify switching local↔remote without orphaned processes.
*   **UI primitives:** overlays/popovers/modals on iOS + web (especially stacked modal touch behavior + Expo web modal behavior).

---

## 🔗 GitHub Issue Crosswalk (happy + happy-cli)

This is a conservative, audit-driven mapping between GitHub issues and the changes described above.

(Scan date: 2026-01-26; audit base: `upstream/main` vs `leeroy-wip`)

**Legend**
- **Likely addressed/implemented**: strong match + direct code changes in `leeroy-wip` that plausibly resolve the issue.
- **Partially addressed / needs validation**: PR improves the area, but does not obviously guarantee a full fix.
- **Related (unverified)**: same surface area; included for reviewer context only.
- **Already in upstream (PR refines)**: feature existed on `upstream/main`; changes here are refinements (scoping, hardening, polish).

### Server selection & self-hosting (server URL + deployment/docs)
- **Already in upstream (PR refines):** slopus/happy#51, slopus/happy#340
- **Partially addressed / needs validation:** slopus/happy#142, slopus/happy#246, slopus/happy#284, slopus/happy#381, slopus/happy#420, slopus/happy#463
- **Related (unverified):** slopus/happy#415, slopus/happy#421, slopus/happy#54, slopus/happy#472, slopus/happy-cli#14, slopus/happy-cli#31

### MessageQueueV1 / pending-message reliability
- **Likely addressed/implemented:** slopus/happy#260, slopus/happy#349
- **Partially addressed / needs validation:** slopus/happy#261, slopus/happy#297, slopus/happy#405, slopus/happy#474

### Inactive session resume
- **Likely addressed/implemented:** slopus/happy#23, slopus/happy#98, slopus/happy#147, slopus/happy#353, slopus/happy#426, slopus/happy#437
- **Related (unverified):** slopus/happy#73, slopus/happy-cli#10

### Claude reliability (switching + terminal state restoration)
- **Likely addressed/implemented:** slopus/happy#301, slopus/happy#304
- **Partially addressed / needs validation:** slopus/happy#90, slopus/happy#430, slopus/happy#424, slopus/happy#46, slopus/happy#425
- **Related (unverified):** slopus/happy#123, slopus/happy#422, slopus/happy#423, slopus/happy#443, slopus/happy#379, slopus/happy-cli#11

### Codex MCP / approvals / tool-call correctness
- **Likely addressed/implemented:** slopus/happy#167, slopus/happy#207, slopus/happy-cli#39
- **Partially addressed / needs validation:** slopus/happy#157, slopus/happy#158, slopus/happy#164, slopus/happy#181, slopus/happy#445, slopus/happy#447, slopus/happy#470
- **Related (unverified):** slopus/happy#146, slopus/happy#139, slopus/happy#247, slopus/happy-cli#43

### Permission modes / YOLO / approval state persistence
- **Likely addressed/implemented:** slopus/happy#29, slopus/happy#446
- **Partially addressed / needs validation:** slopus/happy#206, slopus/happy-cli#150, slopus/happy#371, slopus/happy#350
- **Related (unverified):** slopus/happy#375, slopus/happy#225, slopus/happy#146, slopus/happy#365, slopus/happy#469, slopus/happy-cli#147, slopus/happy#227

### ACP agent expansion (Codex ACP + OpenCode ACP + Auggie ACP + agent catalog)
- **Likely addressed/implemented (OpenCode):** slopus/happy#265, slopus/happy#344, slopus/happy#394, slopus/happy#477
- **Likely addressed/implemented (Auggie, experimental):** slopus/happy#133
- **Partially addressed / needs validation (broader ACP roadmap items):** slopus/happy#217, slopus/happy#267

### Slash commands (Claude + ACP)
- **Partially addressed / needs validation:** slopus/happy#14, slopus/happy#203
- **Related (unverified):** slopus/happy#182

### Models / Gemini availability
- **Partially addressed / needs validation:** slopus/happy#176, slopus/happy-cli#146, slopus/happy#471

### Daemon process safety (reattach/ownership gating) + service requests
- **Partially addressed / needs validation:** slopus/happy#175, slopus/happy#191
- **Related (unverified):** slopus/happy#433, slopus/happy#434

### Auth / linking / backups
- **Likely addressed/implemented:** slopus/happy#19
- **Partially addressed / needs validation:** slopus/happy#399, slopus/happy#400, slopus/happy#80, slopus/happy#387
- **Related (unverified):** slopus/happy#92

### Secrets / logging / path safety
- **Likely addressed/implemented:** slopus/happy-cli#44
- **Related (unverified):** slopus/happy-cli#46, slopus/happy#336, slopus/happy#416

### New Session Wizard + machine/endpoint selection
- **Partially addressed / needs validation:** slopus/happy#315, slopus/happy#57

### Sessions UX (unread/rename/notifications/deep linking)
- **Partially addressed / needs validation:** slopus/happy#102, slopus/happy#305, slopus/happy#209, slopus/happy#435, slopus/happy#462, slopus/happy#86, slopus/happy-cli#28, slopus/happy#362, slopus/happy#368

### Terminal/TMUX & headless attach
- **Partially addressed / needs validation:** slopus/happy#195, slopus/happy#204

### Tool UX (specialized renderers + native interaction routing)
- **Related (unverified):** slopus/happy#128, slopus/happy#8

---

## 🧾 Upstream Open PRs Cross-check (double-verified)

Scan date: **2026-01-26** (open PRs in `slopus/happy`, `slopus/happy-cli`, and `slopus/happy-server`).

Verification method: sampled added/removed diff lines from each PR (via GitHub `pulls/<n>/files` patches) and checked whether those lines are present/absent in the monorepo branch `slopus/tmp/leeroy-wip` (file paths mapped to `expo-app/…`, `cli/…`, and `server/…`).

- `PORTED`: we intentionally extracted/ported this PR into the monorepo and added explicit credits elsewhere in this PR description.
- `VERIFIED`: strong evidence the PR’s changes are already present (or superseded) in `leeroy-wip`.
- `PROBABLE`: meaningful overlap, but not tight enough to claim superseded without a quick human spot-check.

PRs without sufficient evidence are intentionally omitted to avoid false positives.

### slopus/happy

#### PORTED (credited above)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy#299](https://github.com/slopus/happy/pull/299) | feat: add execpolicy approval option for Codex | @OrdinarySF | checks 61; add 93%; remove 78%; missingFiles 1 |
| [slopus/happy#356](https://github.com/slopus/happy/pull/356) | feat: session sharing UI (friends + public links) | @54m | ported into monorepo; see Session Sharing section |

#### VERIFIED (likely superseded)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy#345](https://github.com/slopus/happy/pull/345) | Add copy-to-clipboard button to message blocks | @leeroybrun | checks 14; add 100%; remove 100%; missingFiles 0 |

#### PROBABLE (review)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy#372](https://github.com/slopus/happy/pull/372) | Fix possible issues introduced by #272 | @leeroybrun | checks 1407; add 83%; remove 81%; missingFiles 9 |
| [slopus/happy#388](https://github.com/slopus/happy/pull/388) | fix: stabilize PR272 new-session UX, profiles gating, and env safety | @leeroybrun | checks 1840; add 82%; remove 88%; missingFiles 15 |

### slopus/happy-cli

#### PORTED (credited above)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy-cli#72](https://github.com/slopus/happy-cli/pull/72) | feat: handle /clear command as session reset in codex | @zkytech | checks 15; add 92%; remove 0%; missingFiles 0 |
| [slopus/happy-cli#101](https://github.com/slopus/happy-cli/pull/101) | fix: use runtime execPath for MCP bridge | @OrdinarySF | checks 30; add 39%; remove 58%; missingFiles 0 |
| [slopus/happy-cli#102](https://github.com/slopus/happy-cli/pull/102) | feat(codex): support execpolicy approvals and MCP tool calls | @OrdinarySF | checks 63; add 59%; remove 96%; missingFiles 1 |
| [slopus/happy-cli#120](https://github.com/slopus/happy-cli/pull/120) | fix(cli): improve abort error handling to reduce spurious error messages | @cruzanstx | checks 14; add 100%; remove 100%; missingFiles 0 |
| [slopus/happy-cli#127](https://github.com/slopus/happy-cli/pull/127) | fix: forward signals to child process in binary launcher | @fberlakovich | checks 12; add 25%; remove —; missingFiles 0 |
| [slopus/happy-cli#139](https://github.com/slopus/happy-cli/pull/139) | fix: move claudeArgs to end of args array for slash command support | @jiogallardy | checks 6; add 100%; remove 0%; missingFiles 0 |

#### PROBABLE (review)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy-cli#123](https://github.com/slopus/happy-cli/pull/123) | Fix possible issues introduced by #107 | @leeroybrun | checks 413; add 81%; remove 75%; missingFiles 8 |
| [slopus/happy-cli#134](https://github.com/slopus/happy-cli/pull/134) | fix: stabilize PR107 tmux spawn, offline buffering, and bun runtime | @leeroybrun | checks 414; add 81%; remove 76%; missingFiles 9 |

### slopus/happy-server

#### PORTED (credited above)

| PR | Title | Author | Evidence |
| --- | --- | --- | --- |
| [slopus/happy-server#25](https://github.com/slopus/happy-server/pull/25) | feat: session sharing API/server support | @54m | ported into monorepo; see Session Sharing section |

<div align="center">
  
[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy-coder
```

<h3 align="center">
Step 3: Start using `happy` instead of `claude` or `codex`
</h3>

```bash

# Instead of: claude
# Use: happy

happy

# Instead of: codex
# Use: happy codex

happy codex

```

<div align="center"><img src="/.github/mascot.png" width="200" title="Happy Coder" alt="Happy Coder"/></div>

## How does it work?

On your computer, run `happy` instead of `claude` or `happy codex` instead of `codex` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code and Codex** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude Code and Codex needs permission or encounters errors  
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Command-line interface for Claude Code and Codex
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - Backend server for encrypted sync

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation Website](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development setup including iOS, Android, and macOS desktop variant builds
- **[Edit docs at github.com/slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)** - Help improve our documentation and guides

## License

MIT License - see [LICENSE](LICENSE) for details.
