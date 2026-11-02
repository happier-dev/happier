STATUS: IMPLEMENTED_NOT_VERIFIED — VOICE-RECONNECT-LIVE-1102; RUN62H replay pending.

Outcome: UI durable Send now preserves the owner's typed startup failure through
Pending settlement, allowing the existing shared reconnect presentation to render.
UI-only correction: reload the browser tab. No daemon/stack reload required for this delta.
No stacks touched, no push; shared worktree and main index preserved.

Observed live basis: voice-ship-journey.md, “Fix verification run 62H”, row R;
evidence/final62h/r-proof.json and r-pending-basis.json, restart90.
The failed Run has connected_service_credential_reconnect_required and error keys
code/message/uxDiagnostic; Voice still reported provider_error with generic Retry.
The collector records diagnostic presence, not its values. The regression uses that
exact Run error envelope, completing values with the owner's schema and needs_reauth basis.

Observed source path: sessionExecutionRunGet → initializeVoiceAgentHandle already
copies run.error.uxDiagnostic; createVoiceTextTurnRejectedBeforeEffectError retains it.
submitDurableVoiceTextTurn records the before-effect rejection as terminal_rejected.
sendVoiceTextTurn then rebuilt an Error from result.message/errorCode and lost the diagnostic.
Its settled branch alone rethrew dispatchOutcome.failure; rejected/ambiguous branches did not.
Fix: after awaiting Pending settlement, rethrow the original dispatch failure before
interpreting the delivery result. Pending retains custody authority; Connected Services
retains diagnostic/retryability authority. No new classifier or message matching.
Existing runtime snapshot → projectVoiceAttemptPresentation feeds top bar, glance and Action reads.

Constructed RED: ui62h/red.log — actual daemon GET response with failed Run envelope,
real initializer, durable enqueue/block and Send rejected without uxDiagnostic.
GREEN: ui62h/green.log — same regression passed; reconnect copy, retryability=false,
no generic Retry and no private provider prose in the shared presentation.
Adjacent: ui62h/adjacent.log — Pending/composer 29/29; terminal helpers 6/6;
agent suite 17/18, one old assertion expected reconstructed .code rather than retained
.rpcErrorCode. Updated that assertion; the earlier typed-cause test likewise now checks
.rpcErrorCode for both admitted and durable inputs. No production fallback added.
Final agent rerun: 18/18 passed, exit 0; ui62h/agent-final.log.
Entry loads: ui62h/entry-loads.log — 7/7, exit 0.
Coherence: one wrapped local allow-local-compilation check, exit 0;
changed=2 roots=6 new=0 unowned=0, ui62h/coherence.log.
Checked production source unchanged afterward; one assertion key corrected after this check.
Whole-package typecheck not run; validation scoped to the requested single coherence check.
All logs above: .project/tmp/voice-reconnect-live-1102/.

Prior daemon fix c25805d4a0 is loaded in restart90: RUN62H verifies its typed code reaches
Run state. Earlier CLI RED/GREEN and failed-then-corrected coherence details remain in
this report's predecessor commit and the parent evidence directory.

Self-review: owner remains Connected Services; Pending delivery and Voice runtime errors
are separate results. Native composer/explicit durableDispatch bypass the outer enqueue
wrapper and retain their existing owner path. Legacy stream events contain error/code;
this startup failure is read before streaming, so no speculative stream protocol change.
No canonical documentation change: restores the existing typed-error presentation contract.
Net mechanisms: checks +0/−0, states +0/−0, codes +0/−0, timers +0/−0, retries +0/−0,
files +0/−0. Removes error reconstruction for dispatch failures; adds one regression.

Residual risk: no loaded UI replay after this correction. Orchestrator must reload tab,
repeat row R with the direct needs_reauth Codex binding, and verify top bar/glance reconnect
copy and absence of generic Retry. Keep IMPLEMENTED_NOT_VERIFIED until that live replay passes.
Browser/native platform runtime replay and whole-package compilation remain unverified.
