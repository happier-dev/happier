STATUS: IMPLEMENTED — VOICE-RECONNECT-LIVE-1102; coherence gate [blocked], live replay pending.

Outcome: preserve the Connected Services owner's reconnect diagnostic at Send/Run startup.
Observed basis: voice-ship-journey.md, “Final call replay run 62G”, row R;
evidence/final62g/r89-row-r-* (Start succeeded; Send failed generically).

Cause: the prior test threw the raw profile-action error inside createRuntime.
The live daemon materializer first converted that error to a blocked result with text only.
The daemon HTTP response, client parsing and Run credential error then lacked uxDiagnostic;
Voice's raw-owner-error adapter consequently fell through to VOICE_AGENT_START_FAILED.

Fix: executionRunMaterialization delegates to buildConnectedServiceCredentialSpawnErrorResult.
The existing typed diagnostic crosses materializeContract → controlServer → controlClient →
ExecutionRunConnectedServicesError → voiceAgentStartError → existing terminal UI presenter.
The HTTP refusal, handler result and rejected-start parser share the failure schema.
No Voice reconnect classifier, message matching, credential reads, retries or stack changes added.
Generic fallback remains for errors the Connected Services owner does not classify.
Direct carrier-creation errors still delegate to that same owner; no competing decision-maker.

RED: daemon-red.log, controlClient.executionRunTimeouts.test.ts regression:
a real owner-produced profile-action refusal over daemon HTTP became VOICE_AGENT_START_FAILED.
GREEN: cli-green.log — client/Voice Run suite 22/22, Run env 28/28, Run errors 4/4.
Initial materializer fixture failures were invalid legacy bindings/missing declared purpose;
corrected to qualified binding and existing Codex contribution, not counted as valid RED proof.
materializer-green.log — 30/30, including real needs_reauth resolution through Fastify HTTP 403;
asserts reconnectCause=listed_needs_reauth, profile identity and retryable=false survive serialization.
Client/Voice regression also asserts one materialization and its release, with no retry.
ui-presentation.log — existing terminal presentation suite 6/6.
entry-loads.log — source entry loads 7/7, exit 0.
Evidence logs: .project/tmp/voice-reconnect-live-1102/.

Coherence: the one allowed local allow-local-compilation invocation refused the private tree
with two new test diagnostics: uncommitted launch-helper import and missing contribution-lease
identity method. Corrected both: call the existing spawn owner directly for this profile-only
test and supply the required lease method. Not rerun per the user's once-only instruction;
[blocked] successful post-correction coherence evidence requires a newly authorized invocation.
coherence.log retains the failed verdict; no failed check is treated as passing.
materializer-final.log — corrected profile/HTTP regression passed (1/1; 29 deselected).
Private slice includes only this fix, required schema consolidation and regression tests.
Unrelated quota/currentness and other shared edits remain outside the commit.

Self-review: traced producer, HTTP schema/projection, client, native/Voice Run error consumers
and existing UI presenter. No new UI behavior or public documentation contract introduced.
Net mechanisms: checks +0/−0, states +0/−0, error codes +0/−0, timers +0/−0, retries +0/−0;
source files +0/−0; report +1/−0. One optional diagnostic field prevents observed typed-reason loss;
one canonical failure schema replaces repeated failure-field definitions.

Residual risk: RUN62G row R has not been replayed against reloaded processes.
Owner must reload daemon and Session runner from source, then repeat direct Codex needs_reauth
Start → Send and observe the reconnect presentation. Stacks were not touched; no push.
Linux source tests only; Windows/macOS runtime replay not performed.
