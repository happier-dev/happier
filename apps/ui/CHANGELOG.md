# Changelog

## Release 2026-08-29.1 - 2026-08-29

<!-- happier-release-note-projections:v1
{
  "expo": {
    "message": "Happier 0.2.11 adds Connected Services and account pools, cross-Agent continuation, synchronized encrypted drafts, durable Actions, Mobile Cockpit and Swipe Teleport, expanded Agents and models, session organization, code review, and stronger handoff and delivery."
  },
  "appStore": {
    "whatsNew": "Happier 0.2.11 adds Connected Services and account pools, cross-Agent continuation, synchronized encrypted drafts, durable Actions, Mobile Cockpit and Swipe Teleport, expanded Agents and models, session organization, code review, and stronger handoff and delivery."
  },
  "playStore": {
    "whatsNew": "Happier 0.2.11 adds Connected Services and account pools, cross-Agent continuation, synchronized encrypted drafts, durable Actions, Mobile Cockpit and Swipe Teleport, expanded Agents and models, session organization, code review, and stronger handoff and delivery."
  },
  "storyDeck": {
    "summary": "Connected Services and account pools, encrypted synchronized drafts, durable Actions, cross-Agent continuation, Mobile Cockpit, expanded Agents, handoff, code review, and durable messaging."
  }
}
-->

Happier 0.2.11 brings together the public 0.2.x work completed since 0.2.1. It substantially expands how you choose Agents and models, manage accounts and quotas, work from your phone, follow goals and delegated work, organize sessions, review code, and continue work across Agents and machines.

### Connected Services and account pools

Connected Services let you link supported provider subscriptions, API keys and GitHub credentials to Happier once, then choose the appropriate account when starting compatible sessions across your machines.

- Connect multiple Codex, Claude and other supported service profiles, give them recognizable labels and choose a default or session-specific account.
- Reuse compatible credentials across machines without replacing the provider's global home on each machine.
- See account health, remaining quota and reset times where the provider exposes them.
- Choose between native provider authentication and a compatible Connected Service directly from the new-session flow.
- Reconnect accounts when credentials expire or required permissions change.
- Use Connected Services during supported session handoffs so the destination machine can materialize the required authentication.

**Account pools** can group several accounts for the same service and choose which one should currently handle work.

- Reorder pool members to set fallback priority and enable or disable individual accounts.
- Choose priority-based, least-limited or manual selection.
- Set a remaining-quota threshold for moving to a better account before the active account reaches its hard limit.
- Bound how frequently a pool can switch accounts during a turn or within an hour.
- See the pool's combined available capacity and the state of each member.

Supported Codex and Claude sessions can adopt an account change without losing the Happier session. When one session discovers that the active pool account is exhausted or unavailable, the pool can select a replacement and make that choice available to the other sessions using it. Recovery can continue with the standard continuation prompt, a custom prompt, no additional prompt, or wait for the original account's reset when no replacement is available.

Codex usage-reset credits can be inspected and applied from Happier where the service reports them. Account changes and meaningful recovery events remain visible in the session rather than happening as an unexplained background change.

Core Connected Services is stable. Quota visibility and recovery remain capability-driven and depend on the selected service, backend and runtime.

### Continue the same session with another Agent

A hosted session can now **continue with another Agent without becoming a new Happier session**.

Choose another Agent from the running session's picker, configure its model and options, then send your next message. That send stops the current Agent and commits the transition. The Happier session keeps the same id, transcript and settings, and a visible divider records where responsibility moved from one Agent to the next.

The arriving Agent receives a bounded, text-only brief containing the recent conversation and useful pointers to earlier context. The handoff can also include the previous Agent's tracked plan as past context. Images and files from earlier turns are not copied into that generated brief, although attachments on the message that commits the switch are handled normally.

If you later return to an Agent that previously ran the same session on the same machine, Happier resumes that Agent's provider session where supported and replays only the work that happened while it was away. If provider resume is unavailable, the Agent starts fresh with the full bounded handoff context instead.

Switching is available only for hosted, writable sessions while the current Agent is idle and the hosting machine is reachable. It does not move the session to another machine and does not currently target Custom ACP backends. Direct and read-only sessions are excluded. The feature is server-advertised and enabled by default; older or incompatible servers and CLIs fail closed instead of presenting targets they cannot execute.

### Goals, workflows, Agent Teams and work state

Happier now presents the purpose of a session, its current foreground turn and its delegated work as related but distinct information.

- Claude and Codex goals can show their active objective, time and token usage, optional budget progress, and controls to edit or cancel the goal.
- Claude TodoWrite and Task activity, OpenCode todo snapshots, workflows and subagents feed shared work-state surfaces instead of separate provider-specific panels.
- Workflow summaries show status, Agent count, duration and token use in the transcript and near the composer.
- A unified Agent activity roster shows foreground work, background tasks, workflows and delegated Agents in one place.
- Per-Agent details stay open while newer activity arrives, without reordering or dismissing the surface underneath you.
- Foreground completion is distinguished from detached work that may continue afterward, so you can begin another turn without treating every background task as part of the same wait.
- Ready notifications follow actual foreground completion rather than an individual subagent event.

Claude Agent Teams can be created and managed from Happier. You can monitor teammates and active subagents, send a message directly to an individual teammate, add teammates to an existing team and follow their activity through the shared Agent surfaces.

Agents can also use Happier's action system to create additional sessions, assign work, message permitted sessions, inspect status and history, and coordinate work in the same workspace. Sensitive actions can pause for an approval in the composer, while provider prompts are suppressed when Happier already owns the approval decision.

Long-running session Actions now run under daemon-owned operation custody. Progress and encrypted revisions survive reconnects, appear in Activity, and reopen with the draft and workflow context that started the operation.

Automations can target existing sessions or create new ones on a schedule, and now also support an explicit **Run now** action.

### Mobile Cockpit and Swipe Teleport

Mobile Cockpit puts the session's working surfaces into one phone-friendly shell.

Depending on availability, its tabs cover:

- the current Agent conversation
- Files
- Git
- transcript navigation
- open details and editor tabs
- Terminal

Each surface retains its own navigation state, and the session header stays present while you move between them. Opening a file, diff, review, terminal or transcript link takes you into the relevant detail surface without losing the surrounding session.

**Swipe Teleport** provides direct movement across your active sessions. Swipe across the bottom bar to slide between sessions—keep going in one gesture to skip several, each one named as you pass it. You can stop on the session you want without repeatedly returning to the session list or performing a separate swipe for each intermediate session.

A thumb-reachable new-session action also makes it faster to start related work from mobile. Background Cockpit tabs suspend unnecessary work, source-control state remains stable while switching tabs, and the classic focused-screen mobile layout remains available from session settings.

### Agents, models and engine selection

- **Cursor is now integrated as a first-class Agent choice**, with model discovery, runtime configuration, session resume, questions, todos, tasks and generated images mapped through Happier's shared surfaces.
- **Grok Build is available as an experimental Agent integration.** It uses models advertised by the active Grok session, exposes reasoning controls only where supported, handles structured and freeform questions, and publishes generated images through Happier's session media.
- **GitHub Copilot and Kiro join the Agent picker**, alongside continued support for Claude, Codex, OpenCode, Gemini, Qwen, Kimi, Auggie, Kilo and Pi.
- **Pi's experimental integration now includes a bundled Happier tools bridge**, native session-Agent tools, blocking dialogs through normal permission surfaces, live context-usage reporting, Direct-session browsing and takeover, configurable prompt behavior, and recovery for rate limits reported by the active model provider.
- **MiniMax profiles are built in** for its global and China endpoints, with compatible Claude and Codex configuration.
- **Claude Opus 5 is available from the Claude model catalog.**
- Happier can use live model lists where a backend exposes them and use its provider catalog where necessary.
- Model-specific controls such as reasoning, effort, thinking or provider modes appear only when the selected model and runtime expose them.
- Supported backends can accept a custom model id when you know an exact model that is not listed.
- Favorite engine/model combinations appear in a dedicated Favorites section for quicker session creation. Availability is still checked against the selected machine, profile, authentication and current model list.
- **Use CLI settings** remains available when you want the provider runtime to choose its configured model without a Happier override.

New-session pickers now use a shared selection system for Agents, models, paths and worktrees. Project and session shortcuts can prefill the normal new-session flow without sending anything automatically:

- A project's `+` action can reuse the newest session configuration from that project.
- **New session with same setup** copies launch selections from a specific session.
- Existing prompt and automation drafts are preserved while machine, folder, Agent, model, profile, permissions and compatible provider options are replaced.
- Transcript history, resume targets, pending messages and running state are not copied.

### Session organization and Needs Attention

Folders, tags, pins, read state and attention choices are server-backed so they remain consistent across connected devices.

- Create, rename, nest, move, focus and collapse folders.
- Move sessions by drag and drop or through their context menus, including returning them to the workspace root.
- Assign and filter by one or more tags.
- Pin important active sessions.
- Use multi-select to archive, delete, move, mark read or update attention handling for several sessions.
- Mark a session read or unread from its row, header or Session info. Manually marking the currently open session unread remains effective for that viewing activation.

**Keep in Needs attention** is separate from unread state. It keeps a session in the attention area after you have read it, until you explicitly remove it. Per-session choices override the account default and follow the session across devices.

Kept sessions are identified separately from sessions that are waiting for you, ready for review, unread or failed, so immediate work can still sort ahead of sessions you chose to retain for later.

### Code review, files and Git

Happier's workspace surfaces now support a more complete review-to-action workflow.

- Browse, search, create, upload, download, rename, delete, preview and edit workspace files.
- Keep multiple file, editor, review and historical-diff tabs open without losing local state or position.
- Review repository changes as a continuous diff set rather than opening every file separately.
- Inspect repository, latest-turn, session-attributed or selected-for-commit changes where reliable evidence is available.
- Initialize a Git repository from a folder that does not already have one.
- Use experimental Git operations for staging, committing, fast-forward pulls, pushing, branch publication and switching, and managed stashes.
- Publish a local repository to GitHub and open or reuse pull requests through a connected GitHub credential or authenticated local `gh` fallback.
- Codex native review uses the provider's review API where the requested target can be represented safely, with normalized findings shown inside Happier.

**Review comments** turn a visual diff review into structured instructions for an Agent.

Add a comment to a specific line in a file or diff, collect comments across the workspace, edit or remove them, and choose which comments to include in the next prompt. Saved comments can be sent from the current session or from a new session in the same workspace.

Each sent comment carries the file, line reference, surrounding snippet, comment text and a stable line-content hash where available. The resulting transcript card groups comments by file and includes a jump back to the reviewed location.

Review comments and Git write operations remain experimental and are enabled separately under Settings, Features.

### Session continuity, delivery and file transfer

- Pending messages can wait while an Agent is busy, reconnecting or inactive and survive app or CLI restarts after the server accepts them.
- Reorder, edit, remove or deliver a specific pending message immediately.
- Happier chooses steering, interruption or normal delivery according to the runtime's available capabilities and explains blocked delivery states.
- Sending to an inactive session can wake and resume it before delivery.
- Browse existing Claude, Codex and OpenCode sessions on a connected machine, open them as provider-backed Direct sessions, or take over and sync them into Happier.
- Fork a conversation from a chosen message. Happier uses native provider forks where available and bounded replay context elsewhere.
- Fork a session directly from its session row. Forked sessions receive recognizable titles while preserving proven lineage and provider state.
- Hand off supported sessions between machines while retaining the Happier session id. Claude and OpenCode handoff are supported; Codex handoff remains experimental. Workspace transfer is optional.
- Choose a destination path during session handoff using the shared path picker and recent paths. Long transfers stream live progress through tracked operations and use transfer-appropriate RPC and polling budgets.
- Per-session drafts survive navigation and restarts, while arrow-key message history can recall earlier prompts without destroying the draft you were writing.
- Session and new-session drafts can synchronize between devices as encrypted account data when the server supports the typed draft contract. Existing local drafts migrate only after durable acknowledgement, newer edits are protected from stale asynchronous clears, and resumable drafts appear in session lists. Older servers retain local-only draft behavior.

Direct sessions remain experimental and require the owning machine to be reachable until they are imported or synced into Happier.

File and workspace transfers use a shared encrypted, chunked transfer pipeline. When both machines have a viable direct route, transfers can move peer to peer without relaying file contents through the server. Web clients can use a machine's Tailscale Serve route where configured. When direct transfer is unavailable, the server relay provides a bounded fallback with explicit size limits rather than silently truncating data.

The same transfer foundation supports prompt assets, attachments, workspace files, handoffs and file downloads. Routes are selected according to current reachability, while progress, cancellation and recovery remain visible to the initiating workflow.

### Transcript navigation and content

Transcripts now use the shared LegendList-based renderer across web and native clients, giving the main conversation, sidechains and read-only views consistent navigation behavior.

Streaming can follow the live tail while still letting you scroll away to read earlier work. Loading older history preserves the visible area, reopening a session can restore your previous reading position, and automatic navigation respects reduced-motion preferences.

Web transcript Text Size and Content Width settings now apply consistently. Deferred history backfill avoids loading older transcript pages until they are needed.

Long sessions gain a navigation rail for earlier turns and pinned messages, including jumps to history that has not loaded yet. Transcript messages can also be selected, copied or sent into another session as a draft.

Mermaid diagrams render on iOS and Android using a bundled, sanitized runtime. Streaming Markdown, tables, lists, code fences, math and selectable native text have also received broader presentation improvements.

### Device linking, terminal pairing and restore

Device setup and recovery now share a clearer linking flow.

- **Add your phone** creates a QR flow from web or desktop settings so a mobile device can join the same Happier account and server.
- QR restore flows preserve the intended server and pending account context while reconnecting or moving between devices.
- Mobile can scan supported pairing and connection codes in app.
- Codes and links avoid embedding loopback-only server addresses that another device cannot reach.
- Server selection survives deep links, web hashes, account redirects and scanner navigation without replacing a working remote server with an unusable local address.

Terminal pairing is authenticated. Provisioning responses can be sealed with a QR-only secret, attachment ownership is checked, and terminal hosts verify their session and socket authority before accepting control. Compatibility remains for supported older terminal flows.

### Sharing, collaboration, retention and privacy

Sharing and collaboration now have clearer authority and privacy boundaries.

- Public and read-only transcripts expose only their permitted actions.
- Approval delegation clears when a share becomes view-only.
- Public capability URLs are redacted from logs, telemetry and server labels.
- Share tokens become public only after creation completes.
- Remote images require consent or an allowed proxy path.
- File and media access grants are derived from the current session and share authority instead of being assumed.
- Broad shell grants remain limited to simple commands.

Session-message retention is configurable, and current cleanup behavior is disclosed in onboarding and settings. Server-side retention sweeps cover eligible session content and sidechain transcripts in bounded batches. Self-hosted operators can choose the storage and retention posture appropriate for their deployment.

### Notifications and connectivity

- Push permission follows explicit user intent rather than being requested merely because a notification-capable screen opened.
- Required native-update notices remain visible, while stale downgrade notices are suppressed.
- Account-switch, quota and authentication notifications respect existing notification preferences and quiet hours.
- Notification operations are bounded so delivery failures do not leave session work waiting indefinitely.

Connectivity supervision keeps authentication and endpoints current through credential refreshes and planned restarts. Sessions reconnect after refreshed credentials, planned server reloads appear as neutral reconnecting states, and brief machine unavailability produces a recoverable state rather than pretending an operation completed.

### Desktop shell, avatars and interaction refresh

Desktop, web and native surfaces now share a more consistent interaction language.

- Custom theme profiles can be cloned, edited, imported and exported, with colors carried into editors, syntax highlighting, diffs and native system chrome.
- Keyboard shortcut settings and the command palette bring built-in commands, custom prompts and Happier actions into one searchable surface.
- Layered navigation transitions preserve route depth across web, iOS and Android.
- Desktop editors follow the active theme, OTA status is available from the sidebar, notched Macs receive appropriate safe-area spacing, and startup and window restoration are more dependable.
- App surfaces use a more consistent icon family, compact status treatments and refined picker, header and composer controls.
- Avatar styles are deterministic across devices. Active sessions retain color, while completed and archived sessions use a quieter monochrome treatment.
- Theme changes animate on supported desktop and web surfaces, while status motion and long-running animation honor visibility and reduced-motion policy.
- The web app can be installed as a PWA.
- French and German localization have been added.
- Focus restoration, touch handling, responsive layouts and screen-reader announcements received broader refinement.

A rich Markdown editor supports headings, emphasis, task lists, blockquotes, links, code blocks and slash commands, with a raw fallback when safe round-tripping is not possible. Tables, math, Mermaid and images are not yet supported by the rich editor itself.

Generated images from supported Agents use durable session media and can render inline after reload.

### Pets, memory and voice

**Pets** are an optional experimental companion feature. Built-in and validated Codex-compatible pets can react to session activity in web, mobile and desktop shells.

Desktop builds can use a draggable native overlay with session bubbles and submitted quick replies. Mobile pets support native dragging, safe areas, keyboard avoidance and reduced-motion behavior. Pets are off per account by default, and account-library synchronization requires a separate server feature.

**Local Memory Search** can build a machine-local derived index from decrypted conversation content and use text search or optional embeddings to find earlier work. It is opt-in, experimental and scoped to the machine that owns the index rather than being a server-wide account index.

Voice sessions use the current ElevenLabs realtime integration, with cleaner stop state, session-scoped approvals and more dependable handoff between voice and coding sessions.

### Claude Unified, provider runtimes and session runners

Claude Unified Terminal remains opt-in and runs the real Claude TUI through a shared terminal host.

- Model, reasoning effort, permission mode and plan mode can be applied from Happier.
- Permission requests, questions and plan-exit dialogs appear in Happier's normal approval surfaces.
- Queued input can be injected without switching to a second Agent runtime.
- Large-session resume can ask each time, resume from summary or resume the full provider session.
- A blocked composer can be cleared only after explicit confirmation, without automatically erasing a real user draft.

Provider runtimes received broader lifecycle and continuity upgrades:

- OpenCode uses live runtime events for turn completion and keeps compaction summaries separate from normal assistant content.
- Pi preserves pending work and authentication continuity across account changes and compaction.
- Gemini participates in Connected Services authentication and usage-limit recovery.
- ACP sessions provide clearer prompt completion and failure information.
- Claude and Codex preserve provider session identity, model controls, permission routing and recovery state across supported restarts and resumes.

Tracked sessions move to the current session runner after a CLI update or restart. The app can inspect runner status, restart a stale runner on its owning machine, and distinguish unsupported control from a failed resume or restart. A restart reports success only after the replacement runtime is ready.

### CLI, daemon, development Stack and releases

- `happier status` provides a read-only setup report covering authentication, relay health, service state, CLI installation and Connected Services.
- `happier service start|stop|status|repair` gives explicit background-service control.
- `happier doctor repair` can inspect and converge common installation and channel problems.
- Fresh CLI installs can continue into guided machine setup and reachable-host provisioning. Managed provider CLI installs can be promoted through the active Happier release.
- `happier resume`, `happier attach`, `happier session`, profiles and JSON control output expand terminal-driven workflows.
- `/happier-diagnose`, System Status and richer bug-report diagnostics make it easier to capture actionable runtime evidence.
- Terminal, tmux and zellij recovery, focus, pane cleanup and server switching have been strengthened.
- Windows runtime discovery, home paths, command shims, service handling and terminal quoting received dedicated work.
- Linux daemon workloads can run in systemd user slices for clearer resource and lifecycle ownership.
- Self-hosted deployments gain clearer readiness and database diagnostics, configurable SQLite limits, migration-only startup support, compressed UI delivery and additional database and authentication compatibility improvements. Self-hosted server binaries carry their migration closure and apply packaged migrations during installation and startup unless the operator explicitly opts out.
- The development Stack treats PostgreSQL as a first-class light-preset provider.

The development Stack can rebuild and reload the UI, server and CLI without unnecessarily dropping active sessions. Planned reloads show a server-restarting state, failed rebuilds preserve the last working server, and unchanged workspaces skip repeated installation work. Remote targets, tunnels, snapshots and local workers are supervised independently so one development target does not silently replace another.

OTA and release preparation now bind builds and promotions to explicit source and candidate identities. Mobile OTA publication uses its prepared runtime, server and binary promotions verify the selected artifacts, and retries preserve the same authorized source rather than silently rebuilding different bytes. System Status can show the installed channel, version and pending updates.

### Reliability, privacy and performance

This release also includes focused improvements to provider resume and completion handling, reconnect recovery, draft and pending-message continuity, session-list efficiency, terminal lifecycle, and daemon service ownership.

Large transcripts and session lists reuse more unchanged work, while inactive panels, polling and background surfaces do less unnecessary processing. Server and CLI maintenance reduces repeated database, migration, logging, authorization and filesystem work.

Sensitive runtime identifiers and credentials are kept out of normal diagnostics, while unsupported or ambiguous operations return visible outcomes instead of being treated as success.

Some features require matching 0.2.11 server or CLI support. When that support cannot be proven, the app hides the action, reports the limitation, or uses its documented compatibility behavior rather than claiming success.

### Thank you

Thank you to everyone who tested development releases, reported problems, suggested improvements and contributed code.

- [@jaylfc](https://github.com/jaylfc) for Grok Build as a first-class coding Agent in [#195](https://github.com/happier-dev/happier/pull/195).
- [@octo-patch](https://github.com/octo-patch) for the built-in MiniMax global and China profiles in [#212](https://github.com/happier-dev/happier/pull/212), and for refreshing the MiniMax model identity.
- [@danljungstrom](https://github.com/danljungstrom) for Claude command preservation, transcript filtering, server compatibility and presence fixes, custom-model input, and runtime Claude model discovery in [#202](https://github.com/happier-dev/happier/pull/202), [#206](https://github.com/happier-dev/happier/pull/206), [#222](https://github.com/happier-dev/happier/pull/222), [#223](https://github.com/happier-dev/happier/pull/223), [#236](https://github.com/happier-dev/happier/pull/236), and [#237](https://github.com/happier-dev/happier/pull/237).
- [@richwomanbtc](https://github.com/richwomanbtc) for Claude setup-token authentication and Agent-style TeX rendering in [#242](https://github.com/happier-dev/happier/pull/242) and [#261](https://github.com/happier-dev/happier/pull/261).
- [@hubikj](https://github.com/hubikj) for restoring web QR readability, improving disabled-signup recovery, and making web transcript text-size and content-width settings apply consistently in [#241](https://github.com/happier-dev/happier/pull/241) and [#260](https://github.com/happier-dev/happier/pull/260).
- [@Miista](https://github.com/Miista) for reducing the relay-server Docker image in [#219](https://github.com/happier-dev/happier/pull/219).
- [@DurdeuVlad](https://github.com/DurdeuVlad) for localizing unsupported transcript placeholders in [#209](https://github.com/happier-dev/happier/pull/209).
- [@RobLoach](https://github.com/RobLoach) for CLI development tooling, Android keyboard sizing and native speech build fixes in [#162](https://github.com/happier-dev/happier/pull/162), [#163](https://github.com/happier-dev/happier/pull/163), [#164](https://github.com/happier-dev/happier/pull/164), and [#204](https://github.com/happier-dev/happier/pull/204).
- [@Kunde21](https://github.com/Kunde21) for making malformed Claude assistant records fail softly in [#196](https://github.com/happier-dev/happier/pull/196), and for Pi's tools bridge, Direct sessions, context reporting and prompt controls.
- [@HiddevH](https://github.com/HiddevH) for preventing SQLite WAL checkpoint starvation in [#190](https://github.com/happier-dev/happier/pull/190).
- [@saketsawrav](https://github.com/saketsawrav) for serializing web terminal input in [#183](https://github.com/happier-dev/happier/pull/183).
- [@jiuchuanll](https://github.com/jiuchuanll) for Codex title synchronization and native passthrough in [#168](https://github.com/happier-dev/happier/pull/168).
- [@jr200](https://github.com/jr200) for preserving bridged MCP input schemas in [#167](https://github.com/happier-dev/happier/pull/167).
- [@eusip](https://github.com/eusip) for resilient metadata writes and compressed mobile UI delivery in [#159](https://github.com/happier-dev/happier/pull/159) and [#158](https://github.com/happier-dev/happier/pull/158).
- [@LightYear512](https://github.com/LightYear512) for resolving global Claude installations through the active runtime in [#153](https://github.com/happier-dev/happier/pull/153).
- [@lucharo](https://github.com/lucharo) for the original cached-session-list idea.
- [@karolzlot](https://github.com/karolzlot) for Codex shared-state recovery, Connected Services timestamp continuity and Claude structured dialogs.
- [@jacobcoro](https://github.com/jacobcoro) for deferred web transcript history, fork-title preservation, worktree defaults and nested permission authority.
- [@sergedc](https://github.com/sergedc) for synchronous stdin stream handling and chunked or bodyless POST support.

Thank you as well to [@Zeninexu](https://github.com/Zeninexu), [@KolorYan](https://github.com/KolorYan), [@Cheddies1](https://github.com/Cheddies1), and [@NeskireDK](https://github.com/NeskireDK) for co-authored feature and reliability work included in this release.

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

## Version 0.2.6 - 2026-05-14

This update improves session folder organization reliability.

- Fixed session and folder drag-and-drop so nested items can move back to the workspace root, folder drops cleanly reset after blocked moves, and drag targets remain accurate while scrolling.

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
- **`happier session send` only worked for active sessions** — happier session send <id> <message> now correctly queues messages for inactive sessions via socket-commit, consistent with how the mobile app behaves
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
