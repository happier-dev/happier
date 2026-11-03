STATUS: IMPLEMENTED_NOT_VERIFIED — source checks complete; loaded J8b replay pending UI reload.

Lane: VOICE-IMMEDIATE-WELCOME-1103

Observed defect: RUN62I J8b on restart91 stayed connected/listening for 120s,
with prewarmOnConnect=false, immediate welcome, zero Runs and zero output.
Evidence: ../evidence/final62i/j8b-immediate-observation.json.

Observed cause: localVoiceEngine's connect scheduler returned on prewarm=false
before its existing immediate-welcome branch could start the agent/welcome turn.
Fix: startLocalVoiceAgentOnConnect admits requested immediate welcome independently
of prewarm; otherwise startup remains opt-in through prewarm. Auto-speak behavior stays intact.
Both fresh-connect and speaking/rearm callers consume the same scheduler.
Existing createVoiceWelcomePolicy still owns admitted welcome execution and epoch deduplication;
initializeVoiceAgentHandle still owns bootstrap selection. No second scheduler or setting.
Direct-session and realtime adapters are unaffected by this local-agent admission fix.

Constructed RED: corrected six-case test failed only immediate/prewarm=false (missing speech);
the other five cases passed. Initial run also had two obsolete RPC-event waits, corrected
to the harness's agent-start event before the deciding RED run.
GREEN: localVoiceEngine.agent.spec.ts, all 23 tests passed, including six welcome/prewarm cases.
The test observes real lifecycle/policy through daemon RPC and speech boundaries:
one startup/welcome/speech for immediate; on_first_turn/off have no connect welcome.
Broader checks failed outside this lane: controller streaming 37/37 and persistence 31/32
fail in settings setup at actionSettings.ts:313 (previous.scopedApprovalPreferences).
Stop suite: 26/27 pass; line149 expects target/admission warning, receives content_unavailable.
Those test/setup paths were not edited by this lane; unrelated work was preserved.
Entry loads: 7/7 passed, exit 0, through hstack-exec.
One local coherence check: changed=2 roots=8 new=0 unowned=0, exit 0.
No package typecheck, stack operation, daemon reload, or push performed.
Logs: .project/tmp/voice-immediate-welcome-1103/{red-corrected,green,adjacent-stop,entry-loads,coherence}.log.

Self-review: removed prewarm's authority over requested welcome; reused existing execution,
playback, cancellation and deduplication. No new timer, retry, state, error code or dependency.
Net delta: checks +1/−0 (separate agent-mode eligibility from welcome-or-prewarm demand);
states/error codes/timers/retries +0/−0; files +1/−0 (this requested report), two existing files changed.
No canonical documentation change needed: restores the existing immediate preference contract.

Reload: UI-only; refresh the bundle containing localVoiceEngine.ts. No daemon reload needed.
Residual risk: real model/audio behavior has not been replayed on the changed loaded UI.
Next: journey owner loads this UI and replays J8b with fresh Local Agent carrier,
immediate welcome and prewarm=false; require one welcome/model turn and audible greeting
before user input, then verify on_first_turn/off remain silent at connect.
