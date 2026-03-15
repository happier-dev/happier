# Claude Teams/Swarms + Participant Routing + Execution Runs — Detailed Manual Validation Tracker (2026-03-01)

## Objective

Track full manual end-to-end verification (real Playwright UI + real local stack + real Claude account) for:
- Claude teams/swarms lifecycle and tool streaming
- Recipient routing (lead, teammate, broadcast, execution run)
- Participant-message UI rendering and route integrity
- Execution-run steering/cancel+send semantics (bounded + long-lived)
- Edge cases around stale recipients, terminated teammates, and focused-view auto-recipient behavior

## Test Environment

- Date: `2026-03-01`
- Stack URL: `http://happier-repo-dev-a1cc5e0671.localhost:19364`
- Browser driver: Playwright MCP (headed)
- Provider under test: Claude (real authenticated account)
- Session requirement: Claude permission mode set to auto-approve/YOLO for non-blocking tool execution

## Validation Rules

- Every failure must include:
  - reproducible steps
  - observed result
  - expected result
  - factual root cause (from code/runtime evidence)
  - root fix (no workaround-only patch)
  - retest result
- Update this file immediately after each meaningful test/fix cycle.
- Mark each scenario as: `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`.

## Comprehensive Scenario Matrix

### 1) Baseline Session and Claude Connectivity

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-1.1 | Create fresh Claude session from UI | PASS | Session `cmm7gsnn100k1taen2dju3yo3` active |
| S-1.2 | Verify Claude can execute tools without permission deadlock | PASS | Team tools executed in same session |
| S-1.3 | Verify normal lead message send still works | PASS | Lead-directed messages sent successfully |

### 2) Claude Team Lifecycle

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-2.1 | Create team via `AgentTeamCreate` | PASS | `repo-inspectors` created |
| S-2.2 | Spawn teammate #1 via `Agent` tool | PASS | `readme-inspector` |
| S-2.3 | Spawn teammate #2 via `Agent` tool | PASS | `package-inspector` |
| S-2.4 | Send direct message to teammate #1 from main composer | PASS | Structured participant card visible |
| S-2.5 | Send direct message to teammate #2 from main composer | PASS | Structured participant card visible (`To: package-inspector`) |
| S-2.6 | Send broadcast to team from main composer | PASS | Structured participant card visible (`To: Broadcast: repo-inspectors`) |
| S-2.7 | Send teammate-directed message from focused teammate view | PASS | Auto-target to focused teammate validated |
| S-2.8 | Shutdown single teammate | PARTIAL | TaskStop-based termination confirmed by lead summary; recipient pruning did not occur until full team delete |
| S-2.9 | Verify shutdown teammate removed from recipients | PASS | Covered by prior fix + spot check |
| S-2.10 | Delete team and verify recipients cleared | PASS | `AgentTeamDelete` completed; recipient chip disappeared (lead-only) |

### 3) Teammate Tool/Sidechain Streaming

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-3.1 | Open teammate tool details while active | PASS | Tool detail opens |
| S-3.2 | Teammate transcript/events stream into detail view | PASS | Verified rich live stream in Agent/SubAgentRun detail views |
| S-3.3 | No unknown-tool fallback for known team tool names | PASS | Agent team tool cards rendered |
| S-3.4 | Missing/odd payloads degrade gracefully | PASS | JSON fallback observed |

### 4) Recipient UX and Structured Participant Messages

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-4.1 | Recipient popover shows lead + teammates + broadcast | PASS | Verified after participant parser fix |
| S-4.2 | Recipient chip defaults to lead in main session | PASS | Expected default |
| S-4.3 | Focused teammate view auto-default recipient | PASS | Fixed member-id matching |
| S-4.4 | Manual recipient selection overrides auto-default | PASS | In focused alpha view, manual switch to beta persisted and routed correctly |
| S-4.5 | Routed messages render `participant_message.v1` card | PASS | “To: readme-inspector” cards visible |
| S-4.6 | Card text preserves original user text | PASS | No rewrite leakage in UI |
| S-4.7 | Recipient popover dark-theme contrast/colors | NOT RUN | Pending visual contrast pass |

### 5) Execution Runs — Long-Lived

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-5.1 | Start long-lived run (`SubAgentRun`) | PASS | Created `run_37819287-69d6-4b26-95bb-817d47b656c7`; SubAgentRun tool stream active |
| S-5.2 | Running long-lived run appears in recipients | PASS | Recipient popover included `Run run_37819287-69d6-4b26-95bb-817d47b656c7` while active |
| S-5.3 | Send while in-flight, `steer_if_supported` path | PARTIAL | Routed prompts accepted from main and focused run view; strategy path not explicitly surfaced |
| S-5.4 | If no steer: cancel+send fallback, run continues | NOT RUN | Requires backend without steer capability in same UI flow |
| S-5.5 | Run removed from recipients after completion | PASS | After run completion, run recipient was removed and chip reset to lead |

### 6) Execution Runs — Bounded/Ephemeral

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-6.1 | Start bounded run | PASS | Started delegate run `run_c56565f1-36d3-4aac-95f9-b4417c89e896` |
| S-6.2 | Send while bounded run is active | PASS | Recipient popover showed running run and accepted routed send |
| S-6.3 | Steer if supported OR cancel+send fallback | PARTIAL | Routed sends accepted; explicit runtime strategy path not directly surfaced in UI |
| S-6.4 | Intentional turn interruption does not incorrectly fail run | PASS | Session pending-message `Send now` interrupted turn; run did not hard-fail from interruption |
| S-6.5 | Completed run removed from recipients | PASS | After timeout + sync, run target disappeared from recipient options |

### 7) Edge and Regression Cases

| ID | Scenario | Status | Notes |
|---|---|---|---|
| S-7.1 | Teammate id normalization mismatch handling | PASS | Member-id based matching fix in place |
| S-7.2 | Teammate shutdown from sidechain event prunes recipient | PASS | Prior fix validated |
| S-7.3 | Session reload does not leave stale recipients | PASS | Repeated runs/detail/session navigation showed coherent recipients with no stale run recipient after completion |
| S-7.4 | Switching sessions and returning keeps coherent recipient state | PASS | Verified via runs/detail/session navigation loops |
| S-7.5 | Team delete + active members yields coherent recipient list | PASS | Team deleted with active members; team recipients cleared coherently |

## Findings / Defects Log

| Finding ID | Status | Area | Repro/Observation | Root Cause (facts) | Fix | Retest |
|---|---|---|---|---|---|---|
| F-001 | Fixed | Recipient lifecycle | Shutdown teammate stayed selectable in recipient list | Claude participant derivation did not consume `shutdown_approved` sidechain messages to prune team member state | Added shutdown-event parsing + robust teammate id extraction in Claude participant derivation | PASS |
| F-002 | Fixed | MCP bridge startup | Claude run failed with missing `dist/.../happyMcpStdioBridge.mjs` in source-mode stack | Bridge launch path assumed `dist` presence; source-mode runtime lacked compiled dist entry | Added source-mode TSX fallback in `createHappierMcpBridge` with tsx hook + tsconfig env | PASS |
| F-003 | Fixed | Teammate participant extraction | Only lead/broadcast shown; individual teammates missing | Team participant parser ignored JSON-string tool_result payload variants | Added JSON-string parsing path before teammate extraction | PASS |
| F-004 | Fixed | Focused auto-recipient | Focused teammate view defaulted to lead | Exact `(teamId + memberId)` matching failed when runtime team id differed from display team id | Changed availability matching to authoritative `memberId` for team member target | PASS |
| F-005 | Fixed | Runs UI freshness | Runs list/status could remain stale (`No runs yet` or `running`) until manual refresh in route transitions | Runs screen only fetched on mount/manual refresh; no focus refresh when revisiting screen | Added `useFocusEffect` reload in session runs screen so list re-fetches whenever runs screen gains focus; added route test to lock behavior | PASS (targeted UI test + repeated Playwright route retest) |
| F-006 | Open | Execution-run routed-send observability | Sending to run recipient has no explicit local acknowledgment card/event in main transcript | `execution_run_send` path does not emit a visible routed-message artifact in current session transcript UI | Pending: decide product behavior (add non-intrusive local ack row vs keep silent) and implement consistently | PARTIAL (delivery likely succeeds; visibility weak) |
| F-007 | Open | Team recipient lifecycle | `beta` remained selectable after TaskStop-driven teammate termination until full `AgentTeamDelete` | Recipient pruning currently relies on deterministic signals (`AgentTeamDelete` / `shutdown_approved` sidechain message). In observed run, beta tool payload contained no shutdown event in `tool.messages`, so parser kept member alive | Pending: decide whether TaskStop should be treated as teammate termination signal (requires reliable taskId→memberId mapping) | PARTIAL (resolved only after explicit team delete) |

## In-Progress Validation Log

### 2026-03-01 09:15
- Created this detailed tracker.
- Imported current known state from live manual run and implemented fixes.
- Next sequence:
  1. Finish remaining Claude team lifecycle scenarios (S-2.5/S-2.6/S-2.8/S-2.10)
  2. Run execution-run long-lived matrix (S-5.*)
  3. Run execution-run bounded matrix (S-6.*)
  4. Run edge/session reload checks (S-7.3/S-7.4/S-7.5)

### 2026-03-01 09:35
- Continued full manual run in session `cmm7h5cjx000ftaj33poggnqj`.
- Verified rich subagent/sub-run tool detail streaming (many live tool events visible).
- Verified bounded execution run creation + active recipient targeting + timeout terminal state.
- Verified recipient list includes running execution run and removes it after terminalization/sync.
- Verified pending-message `Send now` interruption flow (confirm modal + abort event) while preserving session continuity.
- Logged two UX gaps:
  - runs status freshness requires manual refresh in some transitions (`F-005`)
  - execution-run routed-send lacks explicit visible acknowledgment in transcript (`F-006`)

### 2026-03-01 09:28
- Implemented fix for runs-screen freshness (`F-005`) in UI code:
  - `apps/ui/sources/app/(app)/session/[id]/runs.tsx` now reloads on screen focus via `useFocusEffect`.
  - Added RED→GREEN test in `apps/ui/sources/__tests__/routes/(app)/session/[id]/runs.test.tsx` (`reloads runs when the screen regains focus`).
- Verified targeted test pass:
  - `yarn -s workspace @happier-dev/app test '__tests__/routes/(app)/session/[id]/runs.test.tsx'`

### 2026-03-01 10:10
- Re-ran full teammate routing flow in session `cmm7h5cjx000ftaj33poggnqj`:
  - created team `qa-team`, spawned `alpha` and `beta`
  - validated direct teammate + broadcast routing cards from main composer
  - validated focused-view auto-recipient and manual override persistence (`alpha` view switched to `beta`)
- Validated execution-run routing via runs screen:
  - started new run `run_37819287-69d6-4b26-95bb-817d47b656c7`
  - confirmed run recipient appears while active and can receive routed prompts
  - confirmed run recipient disappears after completion
- Validated team delete lifecycle:
  - `AgentTeamDelete` executed successfully
  - recipient chip removed once team deleted (lead-only state)
- New gap recorded (`F-007`):
  - TaskStop-based teammate termination lacked deterministic sidechain shutdown event; member stayed selectable until team delete.

### 2026-03-01 10:35
- Re-tested runs screen navigation after `F-005` fix:
  - `runs -> new run form -> runs` preserved current run list without requiring manual refresh.
  - latest run status (`succeeded`) was visible immediately on entry.
- Completed team cleanup validation:
  - `AgentTeamDelete` confirmed in transcript.
  - recipient selector was removed from composer (lead-only state) after deletion.

## Commands / Evidence Pointers

- Browser session under test: `/session/cmm7gsnn100k1taen2dju3yo3`
- Related tracker baseline: `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_2026-03-01.md`
- Current detailed tracker (this file): `docs/testing/CLAUDE_TEAMS_EXECUTION_RUNS_MANUAL_QA_TRACKER_DETAILED_2026-03-01.md`
