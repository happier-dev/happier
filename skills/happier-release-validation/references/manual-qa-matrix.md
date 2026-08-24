# Manual QA Matrix

Manual QA is mandatory for Linux Lima, macOS host, and Windows through `~/connect_windows.sh`.

## Account And Browser Invariant

For VM/remote auth flows:
- connect daemon with `happier auth login`
- open the emitted URL from the host browser/agent-browser
- create or select one account
- reuse that same account, browser storage state, hostname, port, and relay URL for the entire scenario family
- do not accidentally authenticate a different browser session or relay URL

Store browser auth state under the live validation workspace `credentials/` and record the exact server/host/port in the lane evidence.

## Candidate Artifact Rule

Manual QA simulates real user upgrades without deploying the candidate:

- Use the active released stable and preview baselines relevant to the changed components. Resolve rolling channel pointers to immutable component version tags/commits and record artifact evidence before mutating the environment.
- Build or bundle the candidate locally from the validation worktree.
- Upgrade CLI, daemon/service, server/relay, web UI, and installer artifacts using those local candidate artifacts.
- Do not use deployed preview install scripts to install the candidate. If a script is used, it must be wired to the local artifact and the evidence must include the exact local path or local URL.
- For Lima/Windows, transfer local candidate artifacts explicitly and record source path, destination path, checksum when practical, and the command that installed them.

## Mixed-Version Selection

Before manual QA, use `skills/happier-compatibility` to list affected reachable old/new directions. At minimum consider server-first, UI-first, and CLI/daemon-first rollout; CLI frontend versus already-running daemon skew; and released-writer/candidate-reader persisted state. Add candidate-writer/released-reader only when coexistence or rollback makes it reachable.

Run direct contract/vector coverage for every required direction. Select manual end-to-end rows by changed seam, deployment order, and failure cost. Do not multiply every row across every provider and OS when those dimensions cannot affect the contract; record why omitted dimensions are irrelevant rather than silently skipping them.

## Agent-Browser State Seeding

Lane L03 owns the single-writer setup:

1. Start the candidate relay/UI endpoint that later QA lanes will use.
2. Open that exact URL with agent-browser from the host.
3. Create or select the release-validation account.
4. Save browser state to `<review-dir>/credentials/agent-browser-storage-state.json`.
5. Record account id/email label if visible, relay URL, hostname, port, and storage-state path in `TRACKING.md` and L03 evidence.

All later browser/UI QA lanes must reuse that same storage state and URL. They may read the file concurrently, but they must not overwrite it. If a scenario intentionally tests account switching, create a separate clearly named state file and record why it exists.

## Lima Snapshot Discipline

For Linux lanes that mutate daemon, service, installer, or account state, use snapshots to prevent scenario contamination:

1. L03 creates or verifies a clean VM with `packages/tests/scripts/lima-vm.sh <vm-name>` or the current repo-owned Lima helper.
2. L03 creates a clean baseline snapshot: `limactl snapshot create <vm-name> --tag clean-provisioned`.
3. Before each mutating scenario in L13, L16, or L21: `limactl snapshot apply <vm-name> --tag clean-provisioned`.
4. After each scenario, record pass/fail, exact VM state, service status, daemon status, relay URL, and logs before resetting.

If snapshots are unavailable, mark the lane `[BLOCKED]` or record a human-approved fallback. Do not run a state-matrix lane where earlier scenarios can silently contaminate later ones.

## Scenario Style

The checklists below are acceptance criteria, not a ceiling. A lane is not complete just because the boxes are checked; the agent must also perform exploratory attempts to break the flow based on the current diff and any findings from prior lanes.

Prefer explicit evidence over prose: command transcript path, service/daemon JSON, session id, provider id, server URL, browser state path, screenshot only when it proves a UI state not captured by accessibility/test IDs, and the exact rerun command after fixes.

## Priority Flows

Run each flow on Linux, macOS, and Windows unless explicitly impossible. Mark impossible cells `N/A` with rationale.

1. Fresh preview install.
2. Current released stable/preview daemon login, then upgrade to local candidate with the same browser/account/server URL.
3. Duplicate or legacy service conflict: manual plus service, old preview plus dev, same relay and different relay.
4. Create sessions after upgrade for Claude, Codex, and OpenCode.
5. Continue existing sessions across server restart, daemon restart, CLI update, and UI reload.
6. Auth/account isolation: same account reuse, account switch, wrong account guard.
7. Storage/encryption: E2EE readable, plaintext readable if enabled, pending queue drains once.
8. Direct session, tail, attach, and takeover for Claude, Codex, and OpenCode.
9. Installer/update rollback: failed update does not break daemon and status gives correct guidance.
10. Native mobile preview install, launch, login, and session creation on Android and iOS.
11. Affected mixed-version topology rows: released clients with candidate server, candidate clients with released server, and released/candidate UI-daemon skew where reachable.

## Flow Acceptance Checklists

### QA-01 Fresh Preview Install

- [ ] Install current `preview` through the normal public install path for that OS.
- [ ] Run `happier --version`, `happier doctor`, and daemon/service status commands.
- [ ] Start relay/UI and verify the URL is reachable from the host browser.
- [ ] Authenticate with `happier auth login` and record the account/server identity.
- [ ] Create one session and send one message before any candidate upgrade.

### QA-02 Preview To Local Candidate Upgrade

- [ ] Start from a working preview install with at least one existing authenticated session.
- [ ] Upgrade CLI, daemon/service, server/relay, and web UI using the locally built candidate artifacts, not deployed preview install scripts.
- [ ] Reuse the same browser state, account, hostname, port, and relay URL.
- [ ] Verify existing sessions still list, open, stream history, and accept a new message.
- [ ] Verify new sessions can be created after upgrade.
- [ ] Record candidate artifact paths, upgrade commands, and before/after versions.

### QA-03 Duplicate Or Legacy Service Conflict

- [ ] Create or reproduce manual daemon plus service-managed daemon state.
- [ ] Create or reproduce old preview plus local candidate service entries where the OS supports it.
- [ ] Test same-relay and different-relay conflicts.
- [ ] Verify the tool detects conflicts, recommends the dynamic following background service as steady state, and does not leave relay ownership blank.
- [ ] Verify the user-facing repair path is actionable and preserves sessions.

### QA-04 Provider Session Creation

- [ ] Create sessions for Claude, Codex, and OpenCode through CLI or UI.
- [ ] When credentials/tools exist, also exercise provider smoke coverage for Gemini, Kilo, Kimi, Qwen, Auggie, PI, and OpenCode Server via L20.
- [ ] For each provider, send a message, wait for a stable completion/error state, and record provider id, model/profile if relevant, and session id.
- [ ] Confirm provider-specific auth or missing-prerequisite failures are reported clearly and are not confused with Happier release regressions.

### QA-05 Session Continuity

- [ ] With existing sessions open, restart server/relay, daemon, CLI, and UI separately.
- [ ] Verify session list, transcript, pending messages, active run state, and attach/tail behavior survive each restart.
- [ ] Verify no duplicate daemon ownership or duplicate session rows appear after restart.
- [ ] Verify a new message after each restart lands in the same account/server context.

### QA-06 Auth And Account Isolation

- [ ] Confirm same browser/account reuse for terminal auth and web UI.
- [ ] Attempt a wrong-account or wrong-relay flow and verify the product prevents or clearly identifies the mismatch.
- [ ] Switch account only in a controlled sub-scenario with a separate storage state file.
- [ ] Verify sessions from account A are not visible or mutated from account B.

### QA-07 Storage And Encryption

- [ ] In default encrypted mode, verify existing encrypted sessions remain readable after upgrade.
- [ ] If plaintext storage is enabled for the candidate, create/read a plaintext session and verify no decrypt path is incorrectly invoked.
- [ ] Verify pending queue content drains once after reconnect and does not duplicate messages.
- [ ] Verify public/share-sensitive flows still respect encrypted-vs-plain session rules when in scope.

### QA-08 Direct Session, Tail, Attach, Takeover

- [ ] Exercise direct session creation where supported by Claude, Codex, and OpenCode.
- [ ] Tail an existing backend session and verify transcript continuity.
- [ ] Attach to an existing session after daemon restart.
- [ ] Exercise takeover/reconnect behavior and verify old sockets/processes are cleaned up or clearly superseded.

### QA-09 Installer/Update Rollback

- [ ] Simulate an interrupted or failed update at the safest available boundary.
- [ ] Verify the existing preview install still runs or the candidate rollback/repair guidance is explicit.
- [ ] Verify daemon/service status does not falsely report healthy when it is not connected.
- [ ] Verify `doctor` or repair commands identify the next safe action.

### QA-10 Native Mobile Validate Only

- [ ] Install or launch the current-source validation build on Android and iOS without store submission.
- [ ] Log in to the same server/account family where applicable.
- [ ] Create a session and send a message.
- [ ] Verify session list/update behavior matches web expectations.
- [ ] Record platform, build identifier, server URL, account, and artifacts.

## Daemon Ownership State Matrix

Prioritize these states because daemon ownership changed materially:
- clean install, no daemon state, no service
- legacy daemon state with no startup source
- manual daemon running, no service
- service installed and running
- service installed plus stale manual daemon state
- service installed plus manual daemon conflict
- multiple services from different lanes/versions
- stale service file with no valid runtime
- stack-started daemon reported as manual startup source
- daemon restart while service-managed

Expected outcome: the dynamic following background service is the recommended steady state, conflicts are detected with actionable guidance, and users do not lose sessions or account continuity.

## UI QA Rules

Use accessibility tree/test IDs where possible. Screenshots are supplemental evidence, not primary proof. For web manual QA during active development, use `?happier_hmr=0` to avoid Fast Refresh interfering with long sessions; this is implemented under `apps/ui/sources/dev/webHmrOptOut/` and used by existing UI E2E specs.
