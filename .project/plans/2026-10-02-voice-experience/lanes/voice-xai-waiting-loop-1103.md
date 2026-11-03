STATUS: IMPLEMENTED_NOT_VERIFIED — focused tests and 7/7 entry loads pass; loaded journey replay pending

# VOICE-XAI-WAITING-LOOP-1103

- Outcome: stop the realtime Voice transcript from feeding itself as coding progress.
- Observed: RUN65 C1a persisted repeated waiting speech in the ordinary Codex Session; Home C1b passed.
- Reproduced: 82 realtime-origin assistant rows produced 82 additional spoken-turn requests per provider before the fix (`.project/tmp/voice-xai-waiting-loop-1103/red.log`).
- Cause derived from the real path: `VoiceTranscriptProjector` persists `conversation_turn.v1` with realtime Voice origin; sync's newly changed message channel calls `voiceHooks.onMessages`; that feed ignored origin and used `sendTextMessage` for the supposed coding reply, requesting another provider response.
- Status-tick hypothesis rejected for this path: online/offline hooks are disabled by `VOICE_CONFIG`; sync's lifecycle producer already compares actual transitions. No new status timer or equality state is needed.
- Owner correction: `voiceHooks.onMessages` retains lifecycle observation, then excludes non-coding-origin rows before producing provider context or spoken turns. The existing Protocol provenance reader decides origin.
- Reconnect/startup and ready-summary projections also exclude realtime Voice rows through `contextFormatters`, so persisted replies cannot be relabelled as coding history.
- Consumers: xAI, OpenAI Realtime and ElevenLabs share this context feed and have parameterized count coverage. Codex GPT Live uses the same host but `current_ui_only` already withholds Session context; that boundary stays intact and its sink-routing suite is included.
- Tests also retain genuine coding progress before/after the 82 echoes, and check reconnect context retains coding replies while excluding Voice replies.
- Focused validation: 4 files / 90 tests PASS (`.project/tmp/voice-xai-waiting-loop-1103/green.log`), including 82 echoes → 0 additional spoken/context turns for all three providers. RED was 82 → 82.
- Entry loads: 7/7 PASS through `hstack-exec -- node apps/stack/scripts/perf/entry-load.mjs` (`.project/tmp/voice-xai-waiting-loop-1103/entry-loads-direct.log`, exit 0).
- UI package typecheck: NOT RUN; worker admission remained queued for memory after placement/sync retries (`.project/tmp/voice-xai-waiting-loop-1103/typecheck.log`). No package-green claim. Commit procedure: one private-tree coherence/finalization invocation; terminal evidence goes to `.project/tmp/voice-xai-waiting-loop-1103/coherence.log`.
- Live replay: not run in this lane. Composed recipe for the journey owner: reload the UI bundle, start xAI on an ordinary Codex Session, ask “What is two plus two?”, observe the answer and settled idle period, then End; no self-generated waiting-turn loop. Compare Home C1b and GPT Live after its RPC lane settles.
- Runtime impact: UI-only source. Reload/reconnect Voice to consume the corrected bundle; no CLI/daemon/server rebuild or stack restart is required by this change. No stack was touched.
- Split-brain audit: live feed, startup/reconnect serialization and ready summary now consume the existing canonical origin classifier. No provider-specific suppression path or competing provenance schema added.
- Mechanism delta: +4 / −0 checks (three origin classifications at feed/summary/serialization entries, one empty-feed return); +0 / −0 states, error codes, timers and retries; +1 / −0 files (this requested lane report). These prevent the reproduced self-response loop using existing provenance.
- Documentation: no published contract changes; this report records the corrected implementation of the existing coding-context boundary.
- Residual risk: original live xAI replay and loaded UI identity remain for the journey owner; tests measure spoken-turn requests at the provider boundary, not completed audible utterances.
