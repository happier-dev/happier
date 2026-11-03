STATUS: PARTIAL — live registry fixed; entry-load gate blocked (2/7).

Lane VOICE-PROVIDER-REGISTRY-LIVE-1103; 2026-11-03; current moving checkout.
Live basis: agent-qa-voice-dev, borrowed Expo on 19364, restart92 daemon/server;
Account 5e3a0581-6f3d-4e73-bf40-383db0be6c3e; Home/global Actions in owned tab.
No stack restart/stop, secret-value inspection/mutation, or push.

Observed cause: raw Voice declarations omit executionOrigin, while installed
packages and generated Voice bundles carry the same development sourceRef origin.
The direct-machine executable resolver read only the declaration stamp, compared
null against the stamped bundle, and silently produced zero activation targets.
Both Codex and xAI bundles were loaded/loadable; neither contribution activated.
The first Start refusal was voice_start_unavailable, before microphone capture.
Prior tests assumed development bundles were originless; that assumption was false.

Fix: projectionOrigins owns current-occurrence package-origin inheritance, extracted
from the existing union owner. Both union and direct executable consumers use it.
Explicit stamps retain precedence; absent/mismatched/disabled installed occurrences
cannot supply an origin. No provider-specific registration or second activation path.
AppShell remains the Account activation owner; the external registry is its output.
Originless bundled contributions and portable union materializations remain supported.
No wire/persistence/SDK/gate/platform change; documented activation behavior restored.

RED: real mounted AppShell development-package fixture with an unstamped Voice
entry and stamped package/bundle failed at registration()==null with the original
direct-origin call. Only that owned call/import was temporarily bypassed; restored
onto current bytes afterwards. Existing originless case remains in the same test.
GREEN: final deciding composed run passed 2/2, including the development case.
Broader focused run: 83 passed / 1 failed / 87 skipped across five files.
Failure: pre-existing offline client Action artifact-retention assertion at
AppShellPluginUiProjection.test.tsx:2002, also recorded by the predecessor lane.
Resolver and union/identity suites passed, including zero unchanged-selection
recomputations and large-catalog origin cost contracts.
Initial remote test collection failed in unrelated Protocol Action initialization.

Live after one tab reload: new origin-owner export present; GPT adapter registered.
Selecting its existing connected-account reference lets Home Start create
voice-attempt:1, then fail downstream provider_setup_required / agent unavailable.
This proves admission/adapter dispatch, not provider signaling or successful audio.
xAI adapter registered; existing Grok Saved Secret reference bound through the public
setting operation; canStart=true. Home Start created voice-attempt:2 and reached
api.x.ai /v1/tts/voices and /v1/realtime/client_secrets: HTTP 200 for both.
It then failed provider_error during connection; no successful-audio claim.
Settings restored through scoped canonical persistence: both Voice projections and
a fresh server settings read return differences=[]. Owned xAI Session deleted.

Entry loads: 2/7 passed (preparation, UI catalog); 5/7 failed in unrelated Protocol
initialization: MACHINE_SERVICE_ADOPT_SPEC / MachineProvisionersListResultV1Schema.
[blocked] 7/7 gate needs those Action import cycles corrected by their owning lanes.
Single private-tree coherence PASS: changed=4 roots=84 new=0 unowned=0 (120.2s).
Commit: this scoped packet via private index + commit-tree + CAS; no push.

Evidence: .project/tmp/voice-provider-registry-live-1103/ — live-red-projection.json,
live-candidate-facts.json, live-xai-origin.json, live-red-start.json,
live-after-settle.json, live-green-{gpt,xai}-start.json, live-gpt-after-start.json,
settings-persisted-verification.json, live-xai-after-start.png, red-composed.log,
green-composed.log, green-focused.log, entry-load.log, coherence.log.
Self-attack: no competing activation owner, origin equality weakening, new cache,
retry, timer, gate, or provider special case. Existing union package-origin checks
are shared rather than copied. Net checks/states/errors/timers/retries +0/−0;
files +1/−0 (this requested report); four existing UI files changed.
No package typecheck run; the requested single coherence check owns this slice.
Residual risk: GPT provider signaling, xAI connection/audio, and physical mobile
capture remain unverified; downstream failures and the blocked entry gate persist.
