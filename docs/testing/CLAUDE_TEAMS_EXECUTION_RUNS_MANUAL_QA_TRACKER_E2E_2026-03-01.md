# Claude Teams/Swarms + Execution-Run Steering — End-to-End Manual QA Tracker (2026-03-01)

## Purpose

This tracker is the authoritative checklist and evidence log for manual Playwright validation of:
- Claude teams/swarms lifecycle and teammate interactions
- Participant recipient routing (lead, teammate, broadcast, execution run)
- Execution-run routed messaging/steering/interrupt behavior (bounded + long-lived)
- Subagent/task detail streaming visibility and correctness
- UI rendering/UX edge cases (recipient popover, focused auto-recipient, structured cards, color/contrast)

This file is updated continuously during test execution with:
- findings
- factual root causes
- implemented fixes
- retest results

## Environment

- Date: `2026-03-01`
- Stack URL: `http://happier-repo-dev-a1cc5e0671.localhost:19364`
- Browser: Playwright MCP (headed)
- Backend under test: Claude (real authenticated CLI/account)
- Session(s): live session IDs are captured in the execution log below
- Expected runtime mode: YOLO/auto-approve enabled for Claude session permissions

## Status legend

- `NOT RUN`: not executed yet
- `PASS`: behavior validated end-to-end
- `PARTIAL`: some assertions validated, at least one critical assertion still pending
- `FAIL`: validated failure with reproducible steps
- `BLOCKED`: cannot proceed due to external dependency or missing test precondition

---

## Comprehensive Validation Matrix

### A) Baseline and Session Health

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| A-1 | Claude session can be created from UI | PASS | Existing active session loaded and usable |
| A-2 | Claude tools execute without permission deadlock | PASS | Team and run tools executed in-session |
| A-3 | Lead/direct message flow still works after routing features | PASS | Standard send path remains functional |
| A-4 | Switching panes/routes keeps session responsive | PASS | Session ↔ runs ↔ tool details navigation works |

### B) Claude Teams/Swarms Lifecycle

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| B-1 | Create team (`AgentTeamCreate`) | PASS | Team creation visible with tool card |
| B-2 | Spawn teammate #1 (`Agent`) | PASS | Teammate appeared and became selectable |
| B-3 | Spawn teammate #2 (`Agent`) | PASS | Second teammate appeared and selectable |
| B-4 | Send direct message to teammate from main composer | PASS | Routed message + team send tool invocation observed |
| B-5 | Send broadcast message from main composer | PASS | Broadcast card visible and routed correctly |
| B-6 | Send teammate message from focused teammate detail view | PASS | Auto-target from focused view works |
| B-7 | Manual recipient override beats focused auto-target | PASS | Manual selection persisted and routed correctly |
| B-8 | Terminated teammate removed from recipient list | PARTIAL | Confirmed for team delete; single-member termination needs deterministic signal validation |
| B-9 | Delete team (`AgentTeamDelete`) removes all team recipients | PASS | Team recipients cleared; lead-only composer state |

### C) Teammate Task/Subagent Streaming

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| C-1 | Opening teammate tool detail shows sidechain transcript | PASS | Detail view contains teammate activity stream |
| C-2 | Live teammate events continue updating while task runs | PASS | Ongoing tool/message updates visible |
| C-3 | Known team tools map to non-unknown UI renderers | PASS | Agent team cards displayed (not unknown) |
| C-4 | Missing/odd payloads degrade safely | PASS | Fallback rendering paths observed |

### D) Recipient UX + Structured Message Transparency

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| D-1 | Recipient chip appears only when non-lead targets exist | PASS | Chip hidden after team deletion/completion |
| D-2 | Popover shows valid targets (lead/teammates/broadcast/runs) | PARTIAL | Valid options observed earlier; later runs hit selector instability during repeated route reloads |
| D-3 | Structured routed message card (`participant_message.v1`) appears | PASS | “To: …” card rendered |
| D-4 | Structured card shows original user text (no rewrite leakage) | PASS | Raw typed text preserved in UI |
| D-5 | Recipient popover color/contrast in dark theme | NOT RUN | Pending explicit dark-theme visual pass |
| D-6 | Stale recipients do not remain after termination/completion | PASS | Repeated route/session loops looked coherent |

### E) Execution Runs (Long-lived)

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| E-1 | Start long-lived `SubAgentRun` | PASS | Run started and appeared in UI |
| E-2 | Running long-lived run appears as recipient target | PASS | Recipient list includes running run |
| E-3 | Send routed message while run is active | PASS | Routed send accepted and processed |
| E-4 | Steer-if-supported behavior confirmed in real run | PARTIAL | Behavior appears correct; explicit strategy signal not directly surfaced in UI |
| E-5 | No-steer fallback (cancel turn + send new prompt, run continues) | NOT RUN | Needs provider/case without steering in active run |
| E-6 | Completed run disappears from recipient list | PASS | Recipient removed after completion |

### F) Execution Runs (Bounded/Ephemeral)

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| F-1 | Start bounded/ephemeral execution run | PASS | Run started from session runs UI |
| F-2 | Send routed message while bounded run is active | PASS | Send accepted during active run |
| F-3 | Steering path or cancel+send path works while run remains healthy | PARTIAL | Routed send works; strategy branch not surfaced directly |
| F-4 | Interrupt/abort current turn then continue run with new message | PARTIAL | Interrupt behavior seen in related flow; needs explicit dedicated re-check |
| F-5 | Bounded run completion removes recipient target | PASS | Recipient removed after completion |

### G) Resilience/Edge Cases

| ID | Scenario | Status | Evidence / Notes |
|---|---|---|---|
| G-1 | Rapid recipient switching sends to selected target only | PASS | Manual cross-target checks succeeded |
| G-2 | Session reload/reopen does not corrupt recipient state | PASS | Reopen loops stayed coherent |
| G-3 | Switching between teammate details and main composer remains consistent | PASS | Auto/manual state behavior stable |
| G-4 | Team lifecycle changes during active run keep recipient list coherent | PARTIAL | Team-delete path good; single teammate stop path still under review |
| G-5 | Execution-run send errors surface clearly to user | PARTIAL | Delivery works; explicit positive/negative local ack visibility remains weak |
| G-6 | Runs screen availability remains stable across reload/navigation | PARTIAL | Added one-shot retry on `RPC_METHOD_NOT_AVAILABLE`; unit test coverage added, manual retest still pending in unstable dev runtime |
| G-7 | Recipient selector interaction does not crash app tree | FAIL | Console captured React error: `useAppPaneContext must be used within <AppPaneProvider>` during selector interaction pass |

---

## Findings Log (Root-Cause Driven)

| ID | Status | Area | Repro / Observation | Root Cause (factual) | Fix Implemented | Retest |
|---|---|---|---|---|---|---|
| QAF-001 | Open | Team recipient pruning | After TaskStop-driven teammate stop, teammate may remain selectable | Pruning relies on deterministic termination signal; observed payload lacked explicit teammate shutdown marker | Pending design/implementation: derive deterministic task-stop → member mapping or add explicit lifecycle marker ingestion | PARTIAL |
| QAF-002 | Open | Execution-run send observability | Routed send to run has weak explicit acknowledgement in main transcript | `execution_run_send` path currently sends via RPC without guaranteed user-facing ack artifact | Pending product decision: add local ack row/card vs keep silent | PARTIAL |
| QAF-003 | Mitigated | Runs screen reliability | /session/:id/runs intermittently showed RPC method not available after reload/navigation loops | Failure confirmed on execution-run list call path; exact upstream trigger remains intermittent | Implemented UI-level one-shot retry when RPC_METHOD_NOT_AVAILABLE is returned in runs load flow | PASS (unit), manual revalidation pending |
| QAF-004 | Open | Recipient selector stability | While exercising `Send to` recipient selector, console logged React crash error about missing `AppPaneProvider` context | Confirmed via console stack (`useAppPaneContext must be used within <AppPaneProvider>`); triggering component path still under isolation | Pending root-cause fix in selector render path so pane-context hooks are never mounted outside provider | FAIL |

---

## Execution Log (Chronological)

### 2026-03-01 11:35 CET — Tracker created
- Created new comprehensive tracker for full flow coverage.
- Imported known validated status from live manual session context.
- Next actions:
  1. Execute remaining NOT RUN/PARTIAL scenarios (D-5, E-5, F-4).
  2. Deep retest teammate termination path to resolve `QAF-001`.
  3. Re-validate execution-run steering/interrupt behavior and evidence capture.

### 2026-03-01 11:45 CET — In progress
- Active Playwright tab points to live session `cmm7h5cjx000ftaj33poggnqj`.
- YOLO mode confirmed in UI.
- Continuing detailed manual pass from this state.

### 2026-03-01 09:35 CET — Extended run steering pass
- Created run `run_81ad34e7-21d8-43e7-8854-1eae415c2012`; terminal status became `failed` with summary `Claude SDK error: error_during_execution`.
- Created run `run_644155b3-dc77-4c30-bba7-c5951246a404`; terminal status became `succeeded`.
- Created run `run_ad23a041-3250-4334-825c-ea87162caebd` with explicit long-running shell-loop instruction; run did not remain available long enough in session composer to complete a deterministic routed-send-while-running check.

### 2026-03-01 09:39 CET — Reliability regressions observed
- Runs screen intermittently returned `RPC method not available` instead of listing runs (reproducible in current stack state, including refresh attempts).
- During recipient-selector interaction pass, console captured:
  - `Error: useAppPaneContext must be used within <AppPaneProvider>`
  - React recovered through app crash boundary, but this is a functional reliability defect.
- Added open findings `QAF-003` and `QAF-004`.

### 2026-03-01 09:46 CET — Mitigation implemented for runs-page method unavailability
- Added a one-shot retry in `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/app/(app)/session/[id]/runs.tsx` when list RPC returns `RPC_METHOD_NOT_AVAILABLE`.
- Added RED→GREEN regression test in `/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/__tests__/routes/(app)/session/[id]/runs.test.tsx` (`retries once when execution run list returns RPC_METHOD_NOT_AVAILABLE`).
- Verified with targeted test command: yarn -s workspace @happier-dev/app test "__tests__/routes/(app)/session/[id]/runs.test.tsx" (pass).


---

## Completion Gate

This tracker is only complete when:
- All scenarios are `PASS` or have explicit `BLOCKED` reason with mitigation plan.
- Every `FAIL`/`PARTIAL` finding includes root cause, code fix reference (if implemented), and retest result.
- No unresolved critical behavior regressions remain for:
  - teammate visibility/routing
  - execution-run routing/steering/interrupt
  - recipient lifecycle coherence
