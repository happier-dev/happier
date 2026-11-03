STATUS: DONE — Voice test drift corrected; private-index commit finalized through coherence/CAS (see log).
Lane: VOICE-TURN-ADMISSION-TESTS-1103.

Cause (observed): voiceTurnAdmission.test.ts:115 start/recover expected a
blocking approval waiter; both now return approval_request_created immediately.
Canonical owner: packages/protocol/src/actions/actionApprovalPolicy.ts:400,
resolveActionApprovalRouting: durable Agent/MCP requests use deferred custody
unless their host retains live invocation custody. Current uncommitted owner
diff changes that flow versus HEAD; this is shared-approval contract drift,
not the RUN-RESUME-CUSTODY detached-Run admission predicate or Voice playback,
spoken-decision, disabled-approval, or reconnect regressions.
History checked: 1ffcda351e (test), 444fb4021a (direct UI controls),
91ce2b633e (spoken confirmation), 34206cf826, 05f840ce92, 275f5960f4.

Fix: await the returned Artifact, assert open/deferred and no client effect,
approve through the real executor, assert executed/completed persisted result,
then retain the original Agent stream/welcome refusal and unchanged-run checks.
Removed the obsolete blocking coordinator fixture; no production owner changed.
Foreign NonNullable hunk remains in the worktree, excluded from this commit.

Evidence prefix: .project/tmp/voice-turn-admission-tests-1103-
- red.log: reproduced 2 timeouts at :115 /8 passed.
- diagnose.log: both returned approval_request_created before the waiter.
- green.log: intermediate assertion used an incorrect execution.kind field;
  corrected to canonical execution.ok/result before the final run.
- green-final.log: focused suite 10/10 PASS, exit 0, via hstack-exec.
- entry-loads.log: current-source graphs 7/7 PASS, exit 0, via hstack-exec.
- coherence.log: single --local --allow-local-compilation wrapped coherence
  check and private-index CAS finalization; terminal verdict/commit recorded there.
No package typecheck, stack lifecycle, process kills, branch changes, or push.

Self-attack: tests still reject premature opening, failed replay, and Agent Run
control after approval; neighboring human/delegate/RPC admission cases pass.
Net runtime mechanisms: checks/states/errors/timers/retries/files +0/-0.
Test files +0/-0; report files +1/-0 (explicitly requested lane handoff).
Residual risk: depends on the current shared-approval owner diff landing;
no live Voice or native-platform certification claimed by this test-only lane.
