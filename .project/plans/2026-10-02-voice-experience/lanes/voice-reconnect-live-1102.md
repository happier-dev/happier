STATUS: IMPLEMENTED_NOT_VERIFIED — VOICE-RECONNECT-LIVE-1102; R2 action replay pending.

Outcome: the owner's reconnect_profile suggestion now activates Voice's existing
connect_agent recovery slot, using the existing Connected Services reconnect route
and canonical Reconnect label. UI-only: browser tab reload; no stack reload needed.
No new component, styling, copy, message classifier, protocol or persisted shape.
No stacks touched; no push; shared worktree and main index preserved.

Observed basis: voice-ship-journey.md R2 row; evidence/final62h/r2-proof.json and
r2-send.json, f99a3e3f55 loaded on restart90 with tab reload. Typed reconnect copy
rendered, but recoveryAction:none, recovery:null, canStart:false hid recovery.
The collector records Run error keys code/message/uxDiagnostic, not diagnostic values.
Regression preserves that envelope and supplies owner-schema values from needs_reauth
member 705530f2; it does not claim the collector captured those values.

Cause: createVoiceMachineError only retained retry for retryable diagnostics.
The owner explicitly supplied reconnect_profile with retryable:false; Voice dropped
that action. Now it consumes the owner's suggestion without classifying code/message.
resolveVoiceConnectRecoveryTarget consumes the failed Run's service/profile identities
and calls buildConnectedServiceSetupRoute(kind:reconnect), the app's existing flow.
Both useVoiceAttemptControl and voiceConversationAction pass the diagnostic to this
shared resolver. projectVoiceAttemptPresentation consumes the canonical diagnostic
presenter's reconnect label through the existing recovery slot. Existing dispatcher
navigates the existing route, including when canStart:false.

RED: r2/red.log — nonretryable owner reconnect suggestion expected connect_agent,
received none. GREEN: r2/green.log — terminal helpers 6/6.
R2 composed regression: r2/agent.log — localVoiceEngine.agent.spec.ts 18/18.
Actual daemon GET boundary returns failed Run; real initializer/durable Send/Pending,
error snapshot, control, presenter and recovery dispatcher assert Reconnect navigation
with the refused service/profile, no admitted Start and no private provider prose.
Adjacent: r2/adjacent.log — four suites 74/74 (error mapping, helpers, target, recovery).
Action suite: r2/action.log — 24 passed, 7 FAILED (approval/microphone/lifecycle
cases outside typed reconnect branch); unattributed in shared moving source.
Entry loads: r2/entry-loads.log — 7/7 passed, exit 0.
One wrapped local allow-local-compilation coherence check: exit 0, changed=7,
roots=74, new=0, unowned=0; r2/coherence.log (private source tree).
All logs: .project/tmp/voice-reconnect-live-1102/.
Whole-package typecheck not run; requested type evidence is the single coherence slice.

Predecessors: c25805d4a0 carries daemon diagnostic into Run; f99a3e3f55 preserves it
through UI Pending rejection. Their evidence remains in predecessor report revisions.
This delta completes the recovery action; it does not redo either ownership decision.

Self-review: canonical authority remains Connected Services suggestedActions and
identity; Voice projects them through existing recovery/control machinery. UI hook
and Action reads/recover share the resolver. Existing provider/default recovery is
retained for failures without a typed refused account; it is not a reconnect classifier.
No canonical docs change: restores the existing typed diagnostic/recovery contract.
Net mechanisms: authority checks +0/−0, states +0/−0, codes +0/−0, timers +0/−0,
retries +0/−0, files +0/−0, recovery action kinds +0/−0. One existing suggestion
mapping and one identity projection activate the existing route for this observed failure.

Residual risk: loaded UI replay pending. Orchestrator reloads tab and repeats R2 with
the direct needs_reauth Codex binding, verifying Reconnect appears and opens that
account's existing reconnect flow. Keep IMPLEMENTED_NOT_VERIFIED until replay passes.
Native/browser runtime replay and whole-package compilation remain unverified.
