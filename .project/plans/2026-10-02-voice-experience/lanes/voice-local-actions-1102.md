STATUS: IMPLEMENTED_NOT_VERIFIED — RUN62H reproduced; pending loaded replay after reload

Outcome: corrected the shared Voice instructions actually delivered by the daemon.
The settings action definitions were already present in the failed real turn;
this follow-up does not claim a missing catalog registration caused RUN62H.

Loaded evidence (read-only nl3, restart90 daemon c348df0431567d85):
- Carrier cmvzrzt8d003dmciqyvzq2jf9, runner1488451, startup marker revision4.
- Codex state_5.sqlite and its retained rollouts identify row17 thread
  01a19e2f-56fc-7b62-95f4-93adc2669477 / run_72088825-c629-4046-92e0-4c721f9b6995.
- Row3 ON: thread01a19e36-01f6-7493-9573-fda4628a031c /
  run_e576b18d-368e-4942-8423-2824bb349c80.
- Both actual first-turn prompts contain settings_list/get/set/reset/invoke,
  approval_request_list/get/decide, their schemas, and the Voice action channel.
- Both also contain the obsolete unconditional instruction to read the request,
  ask the person, and follow their answer before deciding. This contradicts the
  10-30 spoken-confirmation ruling and the neighboring action workflow guidance.
- Actual row3 output emits list and get action blocks, then asks again; no decide.
  Actual row17 emits no action and falsely says settings actions are unavailable.
- Native Codex logs show Happier MCP active and a rejected execution_run_wait
  schema, plus unrelated PostgreSQL startup failures; no settings rejection.
  The complete native model tool allowlist is not retained in these rollouts.
- Saved projections/raw reads: .project/tmp/voice-local-actions-1102/
  loaded-turn-composition-evidence.json, loaded-real-turn-items.json,
  loaded-real-prompt-and-tools.json, loaded-row17-tool-inventory.json,
  loaded-session-persisted-input.json. No credentials were printed.

Cause and correction:
- Observed approval cause: stale shared base/global custody instructions compete
  with the action's correct confirmation guidance. One shared rules constant now
  serves global, Local and realtime prompts: spoken approval confirms; self-
  initiated decisions still ask; OFF preserves the owner's tap-required refusal.
- Observed settings boundary: the model refused before any action or lookup,
  despite receiving the definitions. Its internal reason is not observable.
  The canonical Local output contract now explicitly distinguishes these routes,
  requires the action attempt and typed result before claiming unavailability.
  This response remains unverified against the real model until live replay.
- Global startup revision5 makes existing carrier renewal consume the correction.
  No separate Voice catalog, permission check or tool allowlist was introduced.
- Producers remain canonical Action specs -> shared prompt -> daemon composition.
  Native MCP and Voice action blocks retain distinct invocation/authority routes.

Regression and validation (.project/tmp/voice-local-actions-1102/):
- followup-prompt-red.log: 1 intended confirmation-rule failure / 28 passing.
- composition-channel-red.log: all4 real ExecutionRunHostBridge/native factory
  compositions fail on missing action-channel availability instruction; real MCP
  settings inventories pass before the delivered-prompt assertion.
- followup-prompt-final-green.log: 29 passing on the final shared prompt.
- followup-composition-green.log: all4 actual SDK/native composition cases PASS.
- followup-startup-consumers-green.log: FAIL, 67 failed/34 passed, 6 unhandled
  errors; untouched carrier/admission paths, unattributed to this lane.
- followup-action-owners-green.log: 24 PASS including setting/approval/OFF/refusal;
  1 unrelated send-error failure: expected dispatch_ambiguous, got send_failed.
- followup-agents-typecheck.log: public package check PASS, zero diagnostics.
- followup-cli-typecheck.log: stopped own client PID3501454 per Coordination
  RULING2026-11-02 18:27Z; exit1 after cancellation, no package-green claim.
  1265 observed diagnostics are unattributed; complete file:line:code list:
  followup-cli-unattributed-diagnostics.json (none in the changed files).
- followup-entry-loads.log: requested current-source entry-load command7/7 PASS.
- followup-coherence.log: single wrapped check PASS, new0/unowned0; CAS commit
  05f840ce9214. Earlier wrong-filter invocations selected no tests, not PASS.
- Owner execution tests do not prove real Codex chooses actions; RUN62H refuted
  that claim. No prompt-only assertion is reported as a successful spoken replay.

Self-review: real prompts refute a registration-only diagnosis. Removed duplicate
custody text; no competing catalog or delegation decision added. Existing UI
marker consumers use the exported revision. Docs/actions.md already describes
this intended behavior; no documentation contract changed. No stack lifecycle,
process kill, shared-index staging, branch change or push performed.
Mechanism delta: +1 shared instruction constant / -1 duplicate rule set;
+1 Local transport-availability instruction; +0 runtime checks/states/errors/
timers/retries/catalogs/files. Test assertions inspect actual native SDK input.

Residual risk: model behavior is not certified by prompt assertions. Reload the
CLI/daemon runtime and UI shared prompt producer, renew Local Voice, then replay
row17 and row3 ON/OFF on built-in Codex gpt-6-luna. Require saved Balanced, an
executed approval without another question, and OFF's typed disabled/tap reason.
Keep IMPLEMENTED_NOT_VERIFIED until that loaded replay passes.
