STATUS: IMPLEMENTED_NOT_VERIFIED — RUN62I follow-up; pending loaded replay

Outcome: fixed a reproduced Local playback overlap that cancels spoken Actions
before their host read-back starts. Canceled operations now have accurate speech.
Live attribution remains derived, not certified: replay row17 and row3 ON/OFF.
No package typecheck was run, per the explicit lane instruction.

Loaded observations (read-only nl3, restart91):
- Server5691bbc901ea923f / daemonf2d361b616947baf; daemon PID3619870,
  carrier cmvzxotrc002nmc8aklpo916w / PID3962860, built-in Codex gpt-6-luna.
- RUN62I confirms 05f840ce92's instructions work: settings.list/get/set and
  approval.request.decide are invoked without another confirmation question.
- Row17 run_4da01f0f-f086-498e-91cc-25a96d912e2c settings.set effect
  stream_a12e6688-1b94-45b6-a1e7-dfe7999e069a:effect:0 returns cancelled;
  independent read remains short. Row3 ON run_9858e62d-478f-498a-a93b-02f3ddf27c12,
  stream_4413cefc-8efe-4a0f-a0f4-f7c3e9f241bd:effect:0 also returns cancelled;
  request baf5f14c-ddd1-828b-a0da-c6723414a4b9 remains open.
- Approval OFF returns present_user_required correctly. No permission fix needed.
- Native carrier logs show narration preceding the mutations. Daemon logs show
  TTS start/cancel/replacement at 00:15:13.294/.837/.842Z and
  00:18:17.994/18.780/18.783Z; STT sender runtime_unavailable follows each.
- Row3's observed Action return precedes the daemon cancel by18ms. These logs
  cannot identify the failed host stream or prove sender failure caused it.
- Raw scoped reads: .project/tmp/voice-local-actions-1102/62i-tts-overlap-log.jsonl,
  62i-daemon-action-context.json, 62i-carrier-invocation-windows.jsonl,
  62i-loaded-action-logs.jsonl. Replay proofs: evidence/final62i/row17-{proof,lifecycle}.json
  and row3-on-* under the Voice program directory.

Reproduced owner defect and fix:
- sendVoiceTextTurn owns both queued model narration and host read-back playback.
  runVoiceAgentTurnWithTools filters final model speech when an Action owns the
  outcome, so queued narration can remain active when playHostText starts.
- The playback controller replaces its current target when another chunk starts.
  A queued narration chunk can therefore stop pending host audio before its first
  callback; executeSpokenAction then returns cancelled without mutating anything.
- playHostText now awaits the existing streamed-turn drain before starting host
  audio. Existing abort/epoch and spoken-confirmation authority remain canonical.
  No Voice catalog, approval policy, queue, lifecycle state or timeout was added.
- Constructed RED drives the real Local sendVoiceTextTurn -> native streamed
  output -> catalog discovery -> Action -> speech/playback composition, scripting
  only the model/transport and OS speech boundaries. Both settings and approval
  return the exact cancelled envelope before the fix; afterward settings persists
  Balanced and the approval executes with decidedVia=voice.
- spokenActionOutcome consumes the canonical typed failure parser and reports
  "The operation was canceled." Successful canceled request status stays distinct.
  Both direct and action_execute routes consume this owner; all12 locales updated.

Validation (.project/tmp/voice-local-actions-1102/):
- 62i-execution-red.log: 2 intended failures, both exact cancelled envelopes.
- 62i-execution-green.log: 14 passing /11 unselected, exit0; includes OFF,
  refusal, barge-in/end/no-audio/failure and unrelated-speech read-back cases.
- 62i-presentation-red.log: 6 intended failures /35 passing.
- 62i-presentation-green.log: 3 suites /55 passing, exit0.
- 62i-entry-loads.log: requested current-source entry loads7/7 PASS, exit0.
- 62i-coherence.log: single wrapped check; verdict and CAS commit recorded there.
  Private index contains own hunks only; no package typecheck.
- Earlier followup-cli-unattributed-diagnostics.json remains an unattributed
  baseline (1265 diagnostics), not evidence for this change; no rerun requested.

Self-review: one playback owner orders narration/read-back; shared Action owners
still decide admission and effect. Native/realtime adapters are retained distinct
transports, not policy copies. Neighbor interruption/OFF/refusal cases selected.
Net mechanism delta: checks +1/-0 (typed cancellation presentation); playback
ordering +1/-0 (reuse existing drain); states/errors/timers/retries/files +0/-0.
Docs/actions.md already specifies the intended behavior; no contract changed.
No stack lifecycle, process kill, shared-index staging, branch change or push.

Residual risk: constructed RED proves the reachable overlap, not its occurrence
in RUN62I; logs alone do not distinguish a stopped pre-start host stream from
other host-speech failures. UI-only change: reload the UI; no daemon reload needed.
Renew Local Voice and replay row17 and row3 ON/OFF on the loaded runtime, requiring
persisted Balanced, executed approval, accurate failure speech and OFF refusal.
