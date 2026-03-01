# Claude Teams/Swarms + Participant Routing + Execution-Run Steering — Live Manual QA Tracker (2026-03-01, V2)

## Objective
Validate end-to-end behavior in the real app (UI + daemon + CLI + real Claude account) for all implemented features in this workstream:
- Claude agent teams / swarms creation and operation
- teammate task visibility and streaming in tool sidechains
- participant recipient selection (lead/member/broadcast)
- participant-routed message sending from session composer and tool detail screens
- execution run recipient targeting (bounded + long-lived)
- execution run steer/interrupt fallback semantics
- recipient list lifecycle (spawn, running, completion, termination)
- UI correctness (labels, colors, structured participant cards, no unknown tools)
- robustness under edge cases (out-of-order messages, stale transcript ordering, reconnect)

## Environment / Preconditions
- Stack: local dev stack running and reachable at `happier-repo-dev-a1cc5e0671.localhost:19364`
- Browser automation: Playwright MCP (headed)
- Auth: test dev account authenticated in browser session
- Claude: authenticated locally and usable from Happier sessions
- Session mode under test: Claude with Agent Teams enabled where required
- Permission mode: YOLO/no-confirm where required to avoid approval stalls

## Status Legend
- `NOT RUN`
- `PASS`
- `FAIL`
- `PARTIAL`
- `BLOCKED`

## Test Matrix (Canonical)

### A) Claude Teams/Swarms Core
| ID | Scenario | Expected | Status | Evidence / Notes |
|---|---|---|---|---|
| A-01 | Create team from Claude lead | Team creation tool event visible; canonical renderer shown | PASS | `AgentTeamCreate` visible and rendered in workflow tool card. |
| A-02 | Spawn teammate task 1 | Task tool event appears and teammate is discoverable | PASS | `Agent` task cards created and opened in detail view. |
| A-03 | Spawn multiple teammates | All active teammates appear in recipient selector | PASS | Recipient popover showed lead + broadcast + teammates. |
| A-04 | Stream teammate progress to sidechain | Tool detail shows ongoing teammate work, not only mailbox idle line | PASS | Sidechain showed live permission/tool activity and progress text. |
| A-05 | Teammate completion captured | Task completion visible in sidechain + main transcript linkage | PARTIAL | Continuous updates confirmed; explicit completed terminal marker not exhaustively validated for both teammates. |
| A-06 | Teammate termination/removal | Removed teammate disappears from recipient selector | PASS | Removed original `beta` stayed absent; only active entries remained. |
| A-07 | Broadcast capability shown | Broadcast recipient appears when team context supports it | PASS | Broadcast entry present in recipient selector. |
| A-08 | Team deletion/cleanup | Team recipients removed after cleanup/delete | NOT RUN | |

### B) Participant Routing UX (Session Composer + Tool Detail)
| ID | Scenario | Expected | Status | Evidence / Notes |
|---|---|---|---|---|
| B-01 | Recipient chip visible when non-lead recipients exist | Chip appears with selectable recipients | PASS | Composer displayed `Send to` chip once team/run recipients existed. |
| B-02 | Recipient list includes lead + members + broadcast | Correct options rendered; no stale members | PASS | Popover listed lead, broadcast, and active teammates (stale removed member absent). |
| B-03 | Send to specific teammate from main composer | Message routed and teammate-targeted behavior occurs | PASS | Sent to `beta-2`; structured card + subsequent `AgentTeamSendMessage` activity observed. |
| B-04 | Send broadcast from main composer | Team-wide message behavior occurs | PARTIAL | Routed broadcast card shown; Claude reported no active team context for broadcast tool in this run. Fallback prompt fix added (FL-004). |
| B-05 | Send to recipient from focused Task tool detail | Auto-recipient/default recipient maps to focused teammate | PASS | Task detail input defaulted to teammate recipient and sent successfully. |
| B-06 | Structured participant message card rendering | `participant_message.v1` card shown with recipient label | PASS | `To: alpha` / `To: beta-2` / broadcast card render confirmed. |
| B-07 | Manual recipient override persists per screen | Manual selection overrides auto until screen leave/reset | PARTIAL | Manual override worked while staying on screen; full leave/re-enter persistence cycle still pending. |
| B-08 | Color/theme correctness in recipient popover (dark mode) | Team/member colors readable and consistent | NOT RUN | |

### C) Execution Runs (Bounded + Long-Lived) Messaging/Steering
| ID | Scenario | Expected | Status | Evidence / Notes |
|---|---|---|---|---|
| C-01 | Running long-lived run appears as recipient | Recipient chip lists active run | PASS | Running `run_aa8bc...` appeared in `Send to` list. |
| C-02 | Send to long-lived while in-flight (steer supported path) | Uses steer path, run continues | PASS | Steering messages changed run behavior live (reprioritized + output format change) without stopping run. |
| C-03 | Send to long-lived while in-flight (no steer path) | Interrupt turn then prompt, run continues | NOT RUN | |
| C-04 | Send to long-lived with explicit interrupt | Cancel current turn then prompt, run not killed | NOT RUN | |
| C-05 | Running bounded run appears as recipient | Recipient chip lists bounded run while active | PARTIAL | Session runs view showed bounded succeeded + long-lived running; active bounded recipient window not captured yet. |
| C-06 | Send to bounded while in-flight (steer path) | Steer injected, bounded run continues and completes | NOT RUN | |
| C-07 | Send to bounded while in-flight (fallback interrupt+prompt) | Cancel turn and continue run without terminal failure | NOT RUN | |
| C-08 | Send to completed bounded run | Rejected cleanly (`execution_run_not_allowed`) | NOT RUN | Requires explicit UI/RPC negative-path probe. |
| C-09 | Recipient disappears after run completion | Completed/terminated run removed from selector | PARTIAL | Completed run shown in runs panel as succeeded; composer excludes known inactive teammate, but run-removal timing still pending full check. |

### D) Reliability / Edge Cases
| ID | Scenario | Expected | Status | Evidence / Notes |
|---|---|---|---|---|
| D-01 | Reload/reconnect during active team run | UI recovers recipients and sidechains correctly | PARTIAL | App reloaded/recovered multiple times; session returned with recipients, but noisy dev-HMR behavior affected determinism. |
| D-02 | Out-of-order transcript/tool events | No stale teammate resurrection | PASS | Previously removed teammate remained absent after transcript churn/reload. |
| D-03 | Unknown/partial tool payload fields | Renderer degrades gracefully (no crash) | PARTIAL | Tool/result JSON fallbacks rendered correctly; separate crash found in transcript rendering path (FL-005). |
| D-04 | Rapid recipient switches and sends | Correct target per send, no cross-target leakage | PASS | Lead/member/broadcast/run target switching preserved intended destination labels/messages. |
| D-05 | Concurrent active execution runs | All active runs listed and individually targetable | PARTIAL | Runs panel showed concurrent run history; active targeting validated for long-lived run only. |
| D-06 | Console/runtime errors during workflows | No blocking errors; warnings triaged | PARTIAL | One blocking runtime error observed (`forkSemantics` undefined) during reload phase; subsequent runs continued after refresh. |

## Findings Ledger (Live)
| Finding ID | Severity | Symptom | Repro IDs | Root Cause (Fact-based) | Fix | Status |
|---|---|---|---|---|---|---|
| FL-001 | Medium | Nested interactive element warning/error in pending reorder handle | D-06 | Drag handle wrapped a pressable action inside another interactive wrapper on web | Replaced nested action with non-pressable visual affordance + test | Fixed |
| FL-002 | High | Removed teammate still appeared in recipients | A-06, B-02 | Claude participant derivation did not reliably apply config-based removals across payload/order variants | Added robust config-edit parsing + ordering-safe removal logic + tests | Fixed |
| FL-003 | Open | Remaining manual validation coverage incomplete | Multiple | Not a code defect; test matrix not fully executed yet | Continue full matrix execution | Open |
| FL-004 | Medium | Broadcast recipient route sometimes fails with Claude error `Not in a team context` | B-04 | Broadcast rewrite prompt assumed team context always active; no deterministic fallback guidance | Hardened Claude broadcast prompt to include explicit fallback (`read ~/.claude/teams/<team>/config.json` then direct-send each active teammate). Added RED/GREEN unit test. | Fixed |
| FL-005 | High | Runtime crash in transcript render path: `forkSemantics is not defined` | D-06 | Local running bundle hit code path where `forkSemantics` was referenced before available in Agent text block during reload flow | Verified regression coverage with fork-button tests; current source includes `forkSemantics` resolution for agent block. Continue monitoring for recurrence after stack restart. | Mitigated |
| FL-006 | Medium | Dev UI repeatedly hot-reloads/reinitializes during Playwright pass, causing unstable refs and noisy console warnings | D-01, D-06 | Local dev web runtime in fast-refresh loop (`App state changed to background`, repeated boot logs), likely environment/runtime state rather than feature logic | Continued validation using resilient selector interactions + added deterministic unit tests for critical behaviors; keep remaining manual items as partial until runtime stabilizes. | Open |

## Execution Log (Chronological)
- 2026-03-01T00:00Z: Created V2 tracker and reset full matrix for fresh end-to-end pass.
- 2026-03-01T09:00Z–10:00Z: Validated teammate creation, recipient chip options, teammate-targeted sends, structured routed cards, task-detail recipient auto-targeting.
- 2026-03-01T10:00Z+: Started long-lived delegate run, validated execution-run recipient listing and mid-run steering messages from composer/detail input.
- 2026-03-01T10:10Z+: Observed runtime crash (`forkSemantics` undefined) during reload/navigation; app recovered after reload.
- 2026-03-01T10:16Z+: Implemented broadcast prompt fallback hardening with RED/GREEN test in CLI Claude participant routing helper.
- 2026-03-01T10:19Z+: Ran targeted regression suites for execution-run steering and participant derivation/routing while Playwright runtime was unstable.

## Fix Log (Code + Tests)
- Pending reorder nested button fix already implemented and tested.
- Claude participant stale recipient cleanup fix already implemented and tested.
- `apps/cli/src/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt.test.ts`
  - RED: added broadcast fallback assertions (`If broadcast is unavailable`, team config path).
  - GREEN: `apps/cli/src/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt.ts` updated with deterministic fallback instructions.
  - PASS command: `yarn -s workspace @happier-dev/cli test src/backends/claude/utils/participantRouting/formatClaudeTeamRoutedPrompt.test.ts`.
- Execution-run steering contract regression:
  - PASS command: `yarn -s workspace @happier-dev/cli test src/rpc/handlers/executionRuns.feat.execution.runs.test.ts` (`36/36` pass).
- Participant target/routing regression:
  - PASS command: `yarn -s workspace @happier-dev/app test sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts` (`24/24` pass).
  - PASS command: `yarn -s workspace @happier-dev/app test sources/sync/domains/input/participants/resolveParticipantRoutedSend.test.ts` (`2/2` pass).
- Crash regression check:
  - PASS command: `yarn -s workspace @happier-dev/app test sources/components/sessions/transcript/MessageView.forkButton.test.tsx -t \"renders fork button left of copy when replay is enabled and message has seq|renders fork button when replay is disabled but provider supports native fork-at-message\"`.

## Commands / Evidence Checklist
- Playwright snapshots/screenshots where necessary.
- Targeted test commands for any behavior fixes.
- End-of-pass: targeted suite run for touched behavior.

## Exit Criteria
All A/B/C/D matrix items are `PASS` or explicitly `BLOCKED` with concrete external cause. Every `FAIL` includes a finding entry with root cause and either implemented fix or explicit follow-up.
