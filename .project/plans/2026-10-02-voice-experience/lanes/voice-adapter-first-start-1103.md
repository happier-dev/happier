STATUS: SOURCE_VERIFIED; CORRECTED_COHERENCE_RETRY_APPROVED; LOADED_REPLAY_PENDING

VOICE-ADAPTER-FIRST-START-1103 — RUN66 C1a / A2, restart94.

Observed causes and fixes:
- Start could read an absent adapter while AppShell was activating it. The committed projection now lends that existing completion to Action admission and the lifecycle owner; lifecycle waiting reuses cancellable pending Start. No activation, timer, polling, retry, or new refusal code is introduced.
- Home realtime carrier creation omitted modelSelection. spawnVoiceConversationSession now uses Voice's configured chat model with the resolved qualified Agent target, while explicit Session inheritance retains precedence. No separate Home default contract was found.
- AppShell remains the activation owner; lifecycle remains the Start/capture owner; the common carrier spawn remains the model projection owner. Existing adapter-unavailable refusal remains for genuinely absent adapters after activation settles.

Validation (constructed conditions through real composition and transports):
- Adapter RED: red-local.log — Action and lifecycle settled with adapter-not-registered instead of awaiting activation.
- Model RED: red-model-green-adapter.log — actual carrier spawn lacked modelSelection. Adapter Start and cancellation were GREEN in the same run.
- Cold AppShell composition: appshell.log — 2 passed (originless/development installed providers).
- Deciding owner/composition and Session inheritance run: green-deciding.log — 7 passed; includes real Home realtime carrier creation, Home spawn, Action/lifecycle cold Start, cancellation, native inheritance and Team refusal.
- Entry loads: entry-load.log — 7/7 passed; command: ./apps/stack/bin/hstack-exec -- node apps/stack/scripts/perf/entry-load.mjs.
- Broader attempt green.log failed: invalid test Home identity (corrected), plus adjacent approval/recovery/media assertions. No broad-suite pass is claimed.
- green-focused-auto.log: 6 passed, 1 failed at the existing collision test's later runtime_stale assertion (session_unavailable versus update_required); its carrier model assertion passed. That assertion is preserved; the new model composition test is separate.
- Public UI typecheck: own recorded PIDs 1766453/1766454/1766539 have exited; no process remains to stop. Diagnostics outside touched files were observed; no package-green claim. Package typecheck is the background baseline per orchestrator ruling.
- Commit coherence: initial invocation failed with three diagnostics from two private-tree isolation mistakes (missing import; concurrent field without its declaration). Both are corrected in the private index; orchestrator authorized the corrected retry. Evidence: coherence.log and coherence-retry.log. Private index and CAS publication only; no push.

Evidence logs: .project/tmp/voice-adapter-first-start-1103/.
Net mechanism delta: admission wait sites +2/−0; activation-completion refs +1/−0; model projection +1/−0; lifecycle states/error codes/timers/pollers/retries +0/−0; production files +0/−0; report files +1/−0. Each addition closes the reproduced Start race or missing model projection at its owner.
Self-review retained the existing activation producer, cancellation authority, explicit Session inheritance, and genuine missing-adapter failure; no competing provider/model owner was added. Documentation requires no contract update: these restore the existing selected-provider/model behavior.

Reload: UI-only source change. Reload the browser/UI before cold-Start replay; no daemon/server restart or stack lifecycle action is required or performed.
Residual risk: loaded restart94 xAI/GPT replay and physical audio were not run. Broader test/typecheck failures are not certified fixed by this lane.
