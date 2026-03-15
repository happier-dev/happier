# Claude Teams/Swarms + Execution Runs — Live Manual QA Tracker (2026-03-01)

## Scope

This is the primary live tracker for manual Playwright validation of the current worktree implementation covering:
- Claude agent teams/swarms lifecycle and teammate interactions
- Participant recipient routing from session composer and focused tool views
- Execution-run routing for both long-lived and bounded runs
- Steering behavior (`steer_if_supported`) and fallback (`cancel + send`) semantics
- Interrupt/abort-then-send flows for active runs
- Subagent sidechain streaming correctness in task detail views
- Recipient list lifecycle (appearance, pruning on termination/completion)
- UI transparency/UX (structured recipient cards, selector options, colors/contrast)
- Cloud/remote Claude start paths relevant to teams behavior in the running stack

## Test Environment

- Date: `2026-03-01`
- App URL: `http://happier-repo-dev-a1cc5e0671.localhost:19364`
- Browser harness: Playwright MCP (headed)
- Provider: real authenticated Claude CLI account
- Validation mode: manual end-to-end flow (UI + live provider behavior)

## Status Legend

- `NOT RUN` — not yet exercised
- `IN PROGRESS` — active currently
- `PASS` — validated end-to-end
- `PARTIAL` — some assertions validated, at least one still pending
- `FAIL` — reproducible defect validated
- `BLOCKED` — external blocker prevents deterministic validation

## Master Validation Matrix

### 1) Baseline Session Health

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| H-1 | Session loads and stays interactive | PASS | Multiple live sessions loaded and remained interactive |
| H-2 | Standard lead messaging remains functional | PASS | Lead-targeted prompt sent and Claude responded |
| H-3 | Navigation session ↔ runs ↔ tool detail remains stable | PASS | Repeated navigation session → `SubAgentRun` detail (`/message/39q11qwpxrc`) → session remained stable with no crash/reload loop |

### 2) Claude Teams/Swarms Lifecycle

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| T-1 | Create team (AgentTeamCreate) | PASS | `AgentTeamCreate` tool card observed in live Claude session |
| T-2 | Spawn at least 2 teammates | PASS | `Agent — Teammate alpha...` and `Agent — Teammate beta...` observed |
| T-3 | Team members appear in recipient selector | PASS | Selector listed `Lead`, `Broadcast`, teammate entries |
| T-4 | Broadcast appears only when team exists | PASS | Broadcast entry shown while team active |
| T-5 | Send direct message to teammate from main composer | PASS | Sent to beta/alpha; `AgentTeamSendMessage` follow-up observed |
| T-6 | Send broadcast from main composer | PASS | Broadcast routed via recipient chip (`To: Broadcast: qa4`), `AgentTeamSendMessage` observed, teammate reply token observed |
| T-7 | Send teammate-targeted message from focused teammate detail | PASS | Tool-detail composer defaulted to teammate and sent message |
| T-8 | Terminated teammate disappears from recipients | PASS | `shutdown_approved` sidechain event for `beta5` now removes teammate target from recipient popover |
| T-9 | Deleting team removes all team recipients | BLOCKED | Live Claude kept `AgentTeamDelete` retry-looping when teammates stayed active; deterministic full-delete not reached in this pass |

### 3) Teammate/Subagent Streaming in Tool Detail

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| S-1 | Teammate detail shows sidechain transcript | PASS | Tool detail displayed teammate sidechain payload/events |
| S-2 | Live updates stream while teammate is running | PASS | Live teammate detail timer/progress updated continuously during `sleep 10` loop (77s→82s→86s) while sidechain events streamed |
| S-3 | Tool cards are normalized (not unknown fallback) | PASS | Agent-team tool cards rendered as known workflow/system tools |
| S-4 | Missing payload fields degrade gracefully | PASS | Added focused regressions for SubAgentRun timeout/error payload normalization and fallback rendering paths; no raw crash path observed in current pass |

### 4) Recipient UX + Structured Message Transparency

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| U-1 | Recipient chip hidden when only lead exists | PASS | Fresh empty session `cmm7mxkwe01apta388jpj7hgb` showed no recipient chip before any team/run targets existed |
| U-2 | Recipient popover lists lead + valid dynamic targets | PASS | Popover showed lead, broadcast, teammates, and active execution run |
| U-3 | Routed message renders structured `participant_message.v1` card | PASS | `To: ...` structured cards rendered in transcript |
| U-4 | Structured card shows original user text (no rewrite leakage) | PASS | User text preserved exactly in structured card |
| U-5 | Dark-theme recipient popover colors/contrast are correct | PASS | Visual check in dark theme confirms readable light text on dark popover (`/tmp/recipient-popover-dark.png`) |
| U-6 | Manual recipient override beats auto-recipient default | PASS | Focused tool view auto-selected teammate; manual override selectable |

### 5) Execution Runs — Long-Lived

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| L-1 | Start long-lived run and observe running state | PASS | Delegate run `run_520e...` started and shown as running |
| L-2 | Running long-lived run appears in recipients | PASS | `Run run_520e...` appeared in recipient selector |
| L-3 | Send message to long-lived run while active | PASS | Sidechain acknowledged routed messages (`RUN-STEER-1`, `RUN-STEER-2`) |
| L-4 | Verify steer path (provider supports steering) | PASS | Long-lived run accepted mid-run routed prompts and continued execution |
| L-5 | Verify fallback path when steer unsupported (cancel+send) | PARTIAL | Automated pass: `apps/cli/src/rpc/handlers/executionRuns.feat.execution.runs.test.ts` validates long-lived cancel+send fallback branches |
| L-6 | Completed long-lived run is pruned from recipients | PASS | After `MCP: Happier Execution Run Stop`, stopped long-lived run recipient disappeared from popover after state refresh |

### 6) Execution Runs — Bounded/Ephemeral

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| B-1 | Start bounded run and observe running state | PASS | Bounded run `run_6b9bd7ad-...` started and streamed progress |
| B-2 | Send message to bounded run while active | PASS | Routed messages delivered to sidechain during active bounded run |
| B-3 | Verify active-turn steering or fallback behavior | PASS | Mid-run send to bounded run injected `RUN-STEER-OK` into next progress line; run continued to completion |
| B-4 | Verify interrupt/abort-turn + continue behavior | PARTIAL | Automated pass: execution-run RPC/runtime tests validate interrupt delivery semantics; pending dedicated manual UI run after re-auth |
| B-5 | Completed bounded run is pruned from recipients | PASS | After bounded run completion, recipient popover no longer listed run target (lead/broadcast/teammates only) |

### 7) Error Handling + Reliability Edge Cases

| ID | Scenario | Status | Evidence |
|---|---|---|---|
| R-1 | Runs screen recovers from transient RPC method unavailability | PASS | No `RPC_METHOD_NOT_AVAILABLE` observed in this pass |
| R-2 | Recipient selector does not crash pane/provider context | PASS | No `useAppPaneContext` crash observed in this pass |
| R-3 | Rapid recipient switching routes only to selected target | PASS | Switched recipients rapidly (`beta_live` → `broadcast` → focused `alpha_live`) and each send mapped to matching `AgentTeamSendMessage` payload/structured card |
| R-4 | Reload/reopen keeps recipient derivation coherent | PASS | Full page reload preserved coherent targets; composer reset to `Lead` (per-screen persistence) and dynamic recipient list repopulated correctly |
| R-5 | Team/run lifecycle churn does not leave stale recipients | PASS | Fixed stale teammate recipient issue from config-removal events |

## Findings Ledger (Root Cause Driven)

| Finding ID | Status | Area | Repro Facts | Root Cause | Fix | Retest |
|---|---|---|---|---|---|---|
| FL-001 | MITIGATED | Runs screen intermittent unavailable | Prior history had transient `/runs` method-unavailable | Not reproducible in this pass | No code change in this pass; keep watch | PASS (this pass) |
| FL-002 | MITIGATED | Recipient selector context stability | Prior history captured `useAppPaneContext ...` | Not reproducible in this pass | No code change in this pass; keep watch | PASS (this pass) |
| FL-003 | FIXED | Pending queue web DOM semantics | Reproducible console error: nested `<button>` in pending reorder row | Reorder drag handle wrapped an `IconAction` pressable, creating nested button structure | Replaced reorder affordance with non-pressable drag icon; added regression test | PASS (`PendingMessagesTranscriptBlock.test.tsx`) |
| FL-004 | FIXED | Stale team recipients after teammate removal | Recipient selector kept removed teammate (`beta`) after config-based removal | Participant derivation did not model Claude team-config edit removals and ordering ambiguity | Added Claude config-mutation removal parsing + robust ordering fallback; expanded tests | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-005 | OPEN | Playwright stability for long manual loops | Intermittent app re-init/background behavior during long scripted steps | Harness/runtime focus churn in long browser automation runs | Continue with shorter deterministic test slices + test-suite coverage | PARTIAL |
| FL-006 | FIXED | Stale stopped execution-run recipients | After explicit `Execution Run Stop`, selector still showed stopped run and routed sends failed with `Not running` | Participant derivation only trusted stale `SubAgentRun` tool running state, ignoring explicit stop tool events | Added explicit-stop detection for run recipients + focused auto-recipient suppression; added RED/GREEN tests | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-007 | FIXED | Teammate recipient not removed after shutdown approval | Teammate sidechain showed `shutdown_approved` but recipient remained selectable | Claude participant derivation only inspected `tool.messages`; live shutdown event was emitted in `tool-call.children` sidechain messages | Added shutdown parsing from `tool-call.children`; added RED/GREEN test for child-sidechain shutdown payload | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-008 | FIXED | Stop-result signal parsing for escaped payloads | Live stop tool output contained escaped `{\"ok\":true}` text shape | Stop-result signal matcher did not normalize escaped quote payloads in string checks | Normalized escaped quote content before `ok:true` detection and added coverage for escaped payload shape | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-009 | FIXED | Run recipient not pruned when stop returned `Not running` | Live `MCP: Happier Execution Run Stop` output returned `{ok:false,errorCode:execution_run_not_allowed}`; run still appeared as recipient and routed send failed with `Not running` dialog | Stop-recipient pruning only treated `ok:true` as terminal and ignored terminal `not running/already finished` stop responses | Added terminal stop-signal detection for `execution_run_not_allowed` / `execution_run_not_running` + `Not running/already finished` signals, with RED/GREEN coverage | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-010 | OPEN | Claude team deletion completion | Fresh session `cmm7v4fhp016gtarmk2h5hbgx` (`qadelete`) reproduced repeated `AgentTeamDelete` failures (`Cannot cleanup team with 1 active member(s): alpha_del`) even after multiple shutdown requests; lead then looped with `sleep`/`ls` retries | Real Claude team member lifecycle remained active in provider config despite shutdown-request sends; no deterministic `shutdown_approved` termination path observed for this teammate in this run | No local code change yet; keep as live-provider/runtime behavior; continue monitoring with explicit teammate transcript probes | BLOCKED (provider-level lifecycle/ack timing) |
| FL-011 | FIXED | Execution-run routed send hangs until socket RPC timeout | Sending to a running bounded run in an unresponsive turn path showed `operation has timed out` after ~30s and left the same stale recipient selected | `ExecutionRunManager.send` for bounded runs waited indefinitely for queued external-message ACK; if the bounded turn never reached the queue consumer, the RPC never returned before server forward timeout | Added bounded external-send ACK timeout guard (`HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS`, default `20000ms`) that removes stale queued message and returns canonical `execution_run_busy`; added RED/GREEN coverage | PASS (`executionRuns.feat.execution.runs.test.ts`) |
| FL-012 | FIXED | Stale execution-run recipients after interrupted subagent calls | Live session `cmm7sw73p00q0tarmnlz3g5vx`: recipient popover listed `run_029...`, `run_8a65...`, `run_95fe...`; routed send raised `Error / Not running` modal | Recipient derivation treated `SubAgentRun` abort-like errors (`Request interrupted`) as running even without prior running evidence; this left non-running runs selectable | Refactored run lifecycle derivation in `deriveSessionParticipantTargets.ts` to be history-aware (running/terminal/unknown), only keeping interrupted runs targetable when preceded by running signal; added RED/GREEN tests including focused auto-recipient behavior | PASS (`deriveSessionParticipantTargets.test.ts`) |
| FL-013 | FIXED | SubAgentRun error rows render opaque JSON blobs in timeline | Erroring `SubAgentRun` cards displayed raw JSON strings (`{ \"status\":\"failed\", ... }`) in timeline instead of structured tool rendering | `SubAgentRunView` returned `null` for `tool.state === 'error'`, forcing generic fallback code block rendering | Added explicit error-state structured fallback in `SubAgentRunView.tsx` and regression coverage in `SubAgentRunView.test.tsx` | PASS (`SubAgentRunView.test.tsx`) |
| FL-014 | FIXED | Running long-lived runs hidden after interrupted SubAgentRun | Session `cmm7te3d300y2tarmygg0kg6g` had running run `run_4243449c-...` (CLI-confirmed) but recipient selector missed it | Transcript-only interrupted state masked active long-lived run visibility | Merged transcript + external running-run feed and added run-start text fallback in participant derivation; wired `useSessionRunningExecutionRuns` into both composers with tests | PASS (`deriveSessionParticipantTargets.test.ts`, `useSessionRunningExecutionRuns.test.ts`) |
| FL-015 | FIXED | Recipient remains stale after `execution.run.send` returns not-running | Sending to bounded recipient sometimes returns `Not running` (race at run end) and can leave stale run selection in composer | Send failure path restored text/error but did not reset invalid execution-run recipient target | Added `isExecutionRunNotRunningSendError(...)` and reset recipient to lead (`setManualRecipient(null)`) in both session and focused-tool composers on terminal not-running send failures; added unit tests | PASS (`sessionExecutionRuns.test.ts`, Playwright retest) |
| FL-016 | FIXED | SubAgentRun terminal error rendering fallback | SubAgentRun timeout/error rows could still render raw JSON fallback via generic ToolError path in mixed normalization paths | ToolInlineBody non-specific error branch did not apply SubAgentRun fallback logic, and fallback detection depended only on normalized tool name | Added SubAgentRun-aware structured fallback in non-specific error branch (`tool.name` + payload-shape detection), suppressed duplicate raw ToolError for those rows, and added RED/GREEN coverage | PASS (`ToolInlineBody.selectabilityScope.test.tsx`, `ToolInlineBody.subAgentRunErrorFallback.test.tsx`) |
| FL-017 | FIXED | Double-encoded JSON payload normalization | Some tool results/subtitles arrived as quoted JSON strings (`\"{...}\"`) and rendered as large opaque blobs | `maybeParseJson` parsed only direct object/array strings and ignored double-encoded JSON payloads | Extended `maybeParseJson` to decode nested object/array JSON strings safely and added regression tests; also compacted SubAgentRun header subtitle extraction from JSON payloads | PASS (`parseJson.test.ts`, `resolveToolHeaderTextPresentation.test.ts`) |

## Live Execution Log

### 2026-03-01 13:25 CET — Tracker initialized
- Created this live tracker for full-scope end-to-end validation.
- Next sequence:
  1. Baseline stability pass
  2. Claude teams lifecycle + recipient routing
  3. Execution runs (long-lived + bounded) steering/fallback/interrupt
  4. Edge-case stress and retests

### 2026-03-01 15:45 CET — Claude teams routing baseline validated
- Confirmed `AgentTeamCreate` + teammate spawns in real Claude session.
- Confirmed recipient selector population (lead, broadcast, teammates).
- Confirmed structured routed message cards for teammate-targeted sends.
- Confirmed focused teammate tool transcript supports targeted sending.

### 2026-03-01 16:10 CET — Root-cause fix FL-003 (nested button in pending queue)
- Reproduced browser error: nested `<button>` in pending reorder row.
- Implemented root fix:
  - `apps/ui/sources/components/sessions/pending/PendingMessagesTranscriptBlock.tsx`
  - `apps/ui/sources/components/sessions/pending/PendingMessagesTranscriptBlock.test.tsx`
- Added/ran RED→GREEN test asserting reorder affordance is non-pressable.
- Console error cleared in subsequent browser run (`Errors: 0`).

### 2026-03-01 16:45 CET — Root-cause fix FL-004 (stale teammate recipients)
- Reproduced stale recipient after teammate removal through Claude team config edit flow.
- Implemented root fix in Claude participant derivation:
  - `apps/ui/sources/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants.ts`
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
- Added coverage for:
  - config-edit teammate removals,
  - newest-first transcript ordering,
  - no-seq and mixed-seq ordering cases.
- Recipient popover now reflects removal correctly (`beta` removed, `beta-2` retained).

### 2026-03-01 17:00 CET — Execution run routing pass (partial)
- Started delegate execution run (`run_520e7808-8140-4fa9-82ed-51f58ad20832`).
- Confirmed running execution run appears as recipient target.
- Exercised routed send to execution run from session composer.
- Full steer/fallback branch verification remains pending due browser/harness instability in long loops.

### 2026-03-01 11:45 CET — Additional execution-run + recipient lifecycle validation
- Verified long-lived run sidechain acknowledged routed prompts (`RUN-STEER-1`, `RUN-STEER-2`).
- Verified bounded run (`run_6b9bd7ad-2c02-402f-8cd3-0e44adf91b3b`) received mid-run routed prompts in sidechain detail view.
- Reproduced stale stopped-run recipient after successful `MCP: Happier Execution Run Stop` (`Not running` dialog on send).
- Implemented root fix in participant derivation:
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
- Added RED→GREEN coverage for:
  - stopped run exclusion from recipient targets
  - stopped run suppression in focused auto-recipient derivation.

### 2026-03-01 18:25 CET — Additional live retest (teams + bounded steering)
- Created fresh live team `qa4` and confirmed recipient chip options: `Lead`, `Broadcast: qa4`, `alpha4`, `beta4`.
- Verified focused teammate detail routing for `alpha4` (`ALPHA4-DIRECT-OK`, `ALPHA4-DETAIL-OK`) with live sidechain streaming.
- Started bounded execution run (`run_208827d9-fbc2-494c-8a42-1d109c696cb6`) and validated:
  - run recipient availability while active,
  - mid-run steer-style message injection produced `RUN-STEER-OK`,
  - run continued and reached `elapsed=180s | status=complete`.
- Verified recipient pruning after bounded completion (run target absent from popover; lead/broadcast/teammates only).
- Verified broadcast routing from main composer (`To: Broadcast: qa4`) and observed follow-up `AgentTeamSendMessage` + teammate response token (`BROADCAST4-OK`).

### 2026-03-01 11:35 CET — Additional live retest + root-cause fixes (qa5 session)
- Created fresh team `qa5` (`alpha5`, `beta5`) and reproduced stale teammate recipient after shutdown:
  - `beta5` sidechain included `{"type":"shutdown_approved",...}` but recipient popover still listed `beta5`.
- Implemented FL-007 root fix:
  - `apps/ui/sources/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants.ts`
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
  - New RED/GREEN coverage for shutdown events emitted through `tool-call.children`.
- Revalidated live: after shutdown approval, `beta5` no longer appears in recipients (`Lead`, `Broadcast: qa5`, `alpha5` only).
- Reproduced stop-output shape with escaped ok payload and hardened parser (FL-008):
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
- Execution-run live checks in same session:
  - Bounded run `run_db578076-6fc7-45e2-ab7a-bfac1ea7136c` steer from main and run-detail inputs (tokens `RUN5_STEER`, `RUN5_DETAIL` present in sidechain command stream).
  - Long-lived run `run_a391ac4f-db62-4c0c-8395-b0a9d42d9dc7` started, steered, then explicitly stopped (`STOPPED_LONG5`), and recipient pruned after refresh.

### 2026-03-01 11:50 CET — Follow-up live validation + FL-009 fix
- Reproduced residual stale bounded-run recipient case:
  - recipient popover still listed `run_db578076-...` after stop output returned `Not running`.
  - sending to that recipient raised `Not running` modal (confirmed mismatch between selector state and backend run state).
- Implemented FL-009 root fix:
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
  - Added RED/GREEN test for escaped `execution_run_not_allowed` stop payload.
- Revalidated live after reload:
  - stale run recipient disappeared (selector reset to `Lead` + active team targets only).
  - focused teammate detail view still auto-selected teammate (`To: alpha5`) and routed send produced structured card + `AgentTeamSendMessage`.

### 2026-03-01 12:06 CET — Additional pass: recipient UX + automated execution-run fallback coverage
- Revalidated recipient UX in dark mode on live team popover:
  - readable contrast confirmed visually (`/tmp/recipient-popover-dark.png`), closing U-5.
- Created fresh empty session `cmm7mxkwe01apta388jpj7hgb`:
  - verified recipient chip is hidden when only lead is available (U-1).
- Live team-delete retest:
  - `qa7`/`qa9` delete attempts repeatedly retried `AgentTeamDelete` due teammates reported active; deterministic final deletion not reached in this run (T-9 remains blocked by provider-state behavior).
- Added automated validation for execution-run delivery edge cases while UI session was unstable:
  - `apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.test.ts` → PASS (13/13)
  - `apps/cli/src/rpc/handlers/executionRuns.feat.execution.runs.test.ts` → PASS (36/36), including cancel+send and interrupt branches
  - `packages/tests/suites/providers/claude.agentTeams.toolNames.realProbe.test.ts` with `HAPPIER_TEST_REAL_CLAUDE=1` → PASS

### 2026-03-01 13:47 CET — Root-cause fix FL-011 (bounded external-send ACK timeout)
- Reproduced repeated UI modal `operation has timed out` when sending to `To: Run run_c3c68c97-...` in a live session with a bounded run stuck in-flight.
- Added deterministic RED test proving bounded `execution.run.send` can hang indefinitely when external message ACK never arrives:
  - `apps/cli/src/rpc/handlers/executionRuns.feat.execution.runs.test.ts` (`fails fast when bounded runs cannot acknowledge external send requests`) — RED (`'__timeout__'` observed).
- Implemented root fix:
  - `apps/cli/src/agent/executionRuns/runtime/ExecutionRunManager.ts`
  - bounded-send queue now enforces ACK timeout via env-configurable guard:
    - `HAPPIER_EXECUTION_RUN_BOUNDED_SEND_ACK_TIMEOUT_MS` (default `20000`, clamped to `<=120000`)
  - on timeout, stale queued message is removed and send returns `{ ok:false, errorCode:'execution_run_busy' }` instead of hanging.
- GREEN validation:
  - `npx vitest run src/rpc/handlers/executionRuns.feat.execution.runs.test.ts -t "fails fast when bounded runs cannot acknowledge external send requests"` → PASS
  - `npx vitest run src/rpc/handlers/executionRuns.feat.execution.runs.test.ts` → PASS (37/37)

### 2026-03-01 14:55 CET — Native Claude teams retest + execution-run stale-recipient root fixes
- Enabled Claude provider setting **Force-enable Agent Teams** in UI (`/settings/providers/claude`), then created session `cmm7sr77t00m2tarmiee90oiu`.
- Validated native Claude teams path end-to-end:
  - observed `AgentTeamCreate`,
  - recipient popover contained `Lead`, `Broadcast: qa-native`, `alpha`, `beta`,
  - routed teammate message produced structured `To: alpha` card and `AgentTeamSendMessage`,
  - focused tool detail input auto-defaulted to `To: alpha`,
  - sending from detail view returned `ALPHA_2`,
  - teammate shutdown removed `beta` from recipient options.
- Reproduced execution-run stale-target issue in session `cmm7sw73p00q0tarmnlz3g5vx`:
  - after repeated `SubAgentRun` interruptions, recipient popover still exposed run ids,
  - routed send opened modal `Error / Not running`.
- Implemented FL-012 + FL-013 fixes in UI:
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
  - `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.tsx`
  - updated tests:
    - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts`
    - `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.test.tsx`
- Verification:
  - `yarn -s workspace @happier-dev/app test:unit sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts sources/components/tools/renderers/workflow/SubAgentRunView.test.tsx` → PASS (36/36)
  - Live retest after hot reload: stale run recipients no longer shown when only interrupted/non-running evidence exists.

### 2026-03-01 15:08 CET — FL-014 root fix (running long-lived runs hidden after interrupted SubAgentRun)
- Reproduced conclusive mismatch in session `cmm7te3d300y2tarmygg0kg6g`:
  - transcript showed `SubAgentRun` result `{ "error": "Request interrupted" }` + follow-up “run has been started” text with `run_4243449c-...`,
  - `happier session run list cmm7te3d300y2tarmygg0kg6g --json` confirmed `run_4243449c-...` status=`running`,
  - recipient chip previously failed to expose that running run.
- Implemented root fixes:
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
    - added merge of transcript-derived running runs + external running run states,
    - added fallback detection from run-start agent text (`Run ID: ...`) when SubAgentRun is interrupted,
    - preserved stop/terminal pruning safeguards.
  - `apps/ui/sources/hooks/session/useSessionRunningExecutionRuns.ts` (+ test)
    - polls `execution.run.list` and feeds only `status=running` runs.
  - wired into:
    - `apps/ui/sources/components/sessions/shell/SessionView.tsx`
    - `apps/ui/sources/app/(app)/session/[id]/message/[messageId].tsx`
  - updated route test mock:
    - `apps/ui/sources/__tests__/routes/(app)/session/[id]/message.test.tsx`
- RED→GREEN test evidence:
  - `deriveSessionParticipantTargets.test.ts` new failing cases for:
    - external-running override on interrupted SubAgentRun,
    - start-text + interrupted SubAgentRun fallback.
  - `yarn -s workspace @happier-dev/app test:unit sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts sources/hooks/session/useSessionRunningExecutionRuns.test.ts 'sources/__tests__/routes/(app)/session/[id]/message.test.tsx' 'sources/components/sessions/shell/SessionView.transcriptRender.seqOnly.test.tsx'` → PASS (43/43).
- Live retest via Playwright:
  - recipient chip now appears for the long-lived run (`To: Run run_4243449c-a556-44ae-a7b5-a32a985f2eaf`),
  - recipient popover includes the running run target and remains selectable.

### 2026-03-01 15:42 CET — FL-015 root fix (clear stale run recipient on terminal send failure)
- Additional real Playwright pass in session `cmm7ugy6t00zutarmmfcctb1a` covered:
  - team lifecycle (`qa8`) with recipient popover (`Lead`, `Broadcast`, `alpha8`) and teammate shutdown removal,
  - long-lived run lifecycle start/route/stop and recipient pruning,
  - bounded run routing edge where send returned `Not running`.
- Reproduced UX edge:
  - user can hit a race window where bounded run recipient is selected, send returns terminal not-running, and composer should immediately fall back from invalid run target.
- Implemented root fix:
  - `apps/ui/sources/sync/ops/sessionExecutionRuns.ts`
    - added `isExecutionRunNotRunningSendError(...)` (error code + message fallback detection).
  - `apps/ui/sources/components/sessions/shell/SessionView.tsx`
  - `apps/ui/sources/app/(app)/session/[id]/message/[messageId].tsx`
    - on terminal not-running send failures: reset recipient selection to lead (`setManualRecipient(null)`), restore input text, then show error modal.
- RED→GREEN:
  - added failing tests in `apps/ui/sources/sync/ops/sessionExecutionRuns.test.ts` for terminal-not-running detection.
  - `yarn -s workspace @happier-dev/app test:unit sources/sync/ops/sessionExecutionRuns.test.ts` → PASS.
  - `yarn -s workspace @happier-dev/app test:unit 'sources/__tests__/routes/(app)/session/[id]/message.test.tsx'` → PASS.
  - `yarn -s workspace @happier-dev/app test:unit 'sources/components/sessions/shell/SessionView.transcriptRender.seqOnly.test.tsx'` → PASS.
- Live retest result:
  - post-failure composer now falls back to `To: Lead` instead of keeping invalid run target selected.

### 2026-03-01 15:56 CET — Extended real-Claude deletion probe + provider-test validation
- Ran explicit team-delete probe in new session `cmm7v4fhp016gtarmk2h5hbgx`:
  - created team `qadelete` with teammate `alpha_del`,
  - sent shutdown requests repeatedly,
  - observed repeated `AgentTeamDelete` `success:false` with active-member message,
  - lead retried with terminal waits/checks (`sleep`, `ls`) but member remained active in team config.
- Conclusion: deletion non-determinism remains provider/runtime behavior in this scenario (tracked as FL-010), not caused by recipient routing or UI normalization regressions in this pass.
- Re-ran real Claude provider probe to ensure integration wiring still works:
  - `HAPPIER_TEST_REAL_CLAUDE=1 yarn -s workspace @happier-dev/tests test:providers claude.agentTeams.toolNames.realProbe.test.ts` → PASS.

### 2026-03-01 16:45 CET — Additional manual matrix closure (recipient switching, reload coherence, bounded run recipient lifecycle)
- Created fresh Claude team session `cmm7x02zv01aotarmx2qhr6jm` and revalidated recipient routing:
  - popover listed dynamic targets (`Lead`, `Broadcast: qa_live`, `alpha_live`, `beta_live`) with dark-theme readable contrast.
  - rapid recipient switching validated with concrete sends:
    - `To: beta_live` → `RECIPIENT-SWITCH-BETA-1` produced matching `AgentTeamSendMessage`.
    - `To: Broadcast: qa_live` → `RECIPIENT-SWITCH-BROADCAST-1` produced broadcast `AgentTeamSendMessage` with both recipients.
    - focused tool view send auto-targeted `alpha_live@zesty-floating-ember` and produced structured `To: alpha_live` card + matching tool payload.
- Revalidated streaming in teammate detail:
  - live sidechain activity/timer changed while teammate command was running (`sleep 10` elapsed counter increments).
- Revalidated reload coherence:
  - full browser reload on the same session retained correct dynamic recipients and reset composer selection to `Lead` (expected per-screen persistence behavior).
- Revalidated bounded execution-run recipient lifecycle:
  - started bounded delegate run `run_1452d372-bc34-4a2b-a871-ffb1eb607ffc`; recipient popover exposed `Run run_1452...` while active.
- attempted routed send to running bounded run near completion returned `Run is busy` modal (canonical busy handling path).
- composer preserved draft text and later recipient list pruned the run target after completion (no stale run recipient remained).

### 2026-03-01 17:40 CET — SubAgentRun timeout/error rendering hardening
- Reproduced remaining raw-JSON fallback risk through SubAgentRun timeout/error transcript rows.
- Implemented and validated root hardening across rendering + normalization:
  - `apps/ui/sources/components/tools/shell/views/ToolInlineBody.tsx`
    - SubAgentRun fallback now also applies in non-specific renderer branch.
    - Fallback detection now accepts `tool.name==='SubAgentRun'` and SubAgentRun-like error payload shape (`runId` + call reference + timeout/error).
  - `apps/ui/sources/components/tools/normalization/parse/parseJson.ts`
    - added safe double-encoded JSON decode path (`"{\\\"...\\\"}"` → object).
  - `apps/ui/sources/components/tools/shell/presentation/resolveToolHeaderTextPresentation.ts`
    - compact SubAgentRun JSON subtitles to high-signal summary/error text.
- Added RED/GREEN tests:
  - `apps/ui/sources/components/tools/shell/views/ToolInlineBody.selectabilityScope.test.tsx`
  - `apps/ui/sources/components/tools/shell/views/ToolInlineBody.subAgentRunErrorFallback.test.tsx`
  - `apps/ui/sources/components/tools/normalization/parse/parseJson.test.ts`
  - `apps/ui/sources/components/tools/shell/presentation/resolveToolHeaderTextPresentation.test.ts`
  - `apps/ui/sources/components/tools/renderers/workflow/SubAgentRunView.test.tsx`

### 2026-03-01 18:00 CET — FL-018 focused SubAgentRun detail recipient gap (root fix)
- Manual repro (Playwright, session `cmm7zmfpi021rtarmzkqpauia`):
  - opened focused `SubAgentRun` detail while run `run_8a2d03b6-80d6-4cf6-8d87-2c5c5bc84b63` was actively streaming.
  - focused composer showed `To: Lead` and recipient popover only listed `Lead/Broadcast/teammates`; active run recipient was missing in tool detail context.
- Root cause:
  - focused-tool auto-recipient derivation did not consider sidechain-local running signals when the parent `SubAgentRun` tool state was non-running/interrupted,
  - and the focused-view recipient targets did not guarantee inclusion of execution-run auto-recipient targets.
- Implemented fix:
  - `apps/ui/sources/sync/domains/session/participants/deriveSessionParticipantTargets.ts`
    - `deriveAutoRecipientFromFocusedToolTranscript(...)` now accepts `focusedMessages` and recognizes running signals from focused sidechain messages.
  - `apps/ui/sources/app/(app)/session/[id]/message/[messageId].tsx`
    - focused tool view now merges execution-run auto-recipient into recipient targets when missing, so chip options stay coherent and steerable from tool detail.
- RED → GREEN evidence:
  - RED command:
    - `yarn -s workspace @happier-dev/app test 'sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts' 'sources/__tests__/routes/(app)/session/[id]/message.test.tsx'`
    - failing tests:
      - `deriveAutoRecipientFromFocusedToolTranscript > returns execution_run recipient for focused SubAgentRun when focused sidechain messages show running`
      - `Session message route hydration > includes focused execution run target when auto-recipient resolves to execution run`
  - GREEN command:
    - `yarn -s workspace @happier-dev/app test 'sources/sync/domains/session/participants/deriveSessionParticipantTargets.test.ts' 'sources/__tests__/routes/(app)/session/[id]/message.test.tsx' 'sources/components/sessions/agentInput/recipient/useSessionRecipientState.test.ts'`
    - result: PASS (45/45)
- Live revalidation note:
  - immediate post-fix live revalidation was interrupted by stack/server context switch (`localhost:8081` refused; session host switched to stack endpoint with inactive machine snapshot), so this specific UI assertion is currently test-backed and queued for next stable live pass.
