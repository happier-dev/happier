STATUS: DONE — source repair RED→GREEN, focused 6/6, entry-loads 7/7; adjacent 13 red; live replay blocked by controller access-denied.

# MACH-SBX-CARD

Request: Docker Sandboxes' Not installed card must reach its declared repair flow.

Observed:
- The plugin's `install-docs` Action already declares `ui` and `plugin` surfaces.
- Its existing `activate` export registers that Action and opens the sbx installation documentation.
- Live card press on `agent-qa-servers-deploy` reproduces the neutral failure.
- The dispatch receives the correct Action and a loadable `clientContribution` bundle.
- `resolvePluginUiClientActionRegistration` returns null for that exact Action.
- The AppShell ambient projection omits that Action; reading the controller projection alone does not publish mounted executable demand.
- Account A 5e3a0581, Home alias :3033, source UI :19364, controller 5964761d.
- Browser `mach-sbx-card` was closed through its foreground controller after diagnosis.

Derived cause: managed provisioner presentation reads repair declarations but never
feeds their mounted demand into the existing AppShell client executable owner.

Scope: shared mounted-demand publication plus both consumers of managed repair
(picker and configuration); existing targeted plugin surfaces retain the same owner.
Cua and Lima have no analogous declared client repair; no surface declarations need changing.

Implemented: extracted `useMountedClientActionDemand` from targeted mounts and reused
it for the two repair surfaces. AppShell still owns activation; the existing runtime
projection owner retains Artifacts. Display-only consumers do not demand activation.
Docker labels now say `Needs sbx` / `sbx installed` at the plugin copy owner.

Validation: real repair callback through AppShell/Artifact/registration/dispatch
RED exit1 (ready controller, failed dispatch) → GREEN exit0, 1/1. Logs:
`.project/tmp/MACH-SBX-CARD/{red,green}.log`. Only transport boundaries replaced.
Entry-loads 7/7 passed (`entry-loads.log`). Picker/configuration repair 5/5 and
the new dispatch regression pass in both adjacent runs. Final focused command
also exits0, 6/6 (`focused.log`). The other activation tests fail 13/13 before
expected targets/registration; one existing withdrawal test fails independently
with the new regression skipped (`adjacent-isolated.log`, exit1, zero targets).
Its fixture does not enter managed repair or the extracted mounted-demand hook;
the adjacent failure's cause remains unattributed, not claimed fixed here.
`adjacent.log` and `adjacent-rerun.log` both exit1. A speculative cache-reset
teardown change did not help and was removed.
Integrated package typecheck remains with Systemic
per COMMIT-FAST-0830; no separate typecheck/build gate was queued by this lane.
Private-index/CAS commit includes required concurrent mounted Action lifecycle,
projection-retention and activation-fixture hunks. SHA is in the board RESULT.

Self-review: targeted mounts retain their prior lease/publication lifecycle; no second
activation path or authority decision. Picker/configuration use one repair owner;
marks, headers and presets retain display-only demand. No documentation contract changed.
Net own mechanism delta: authority checks/states/error codes/timers/retries +0/−0;
one existing publisher extracted, one repair demand purpose added; production files +0/−0.
Live replay: source UI :19364 loads the extracted hook and displays `Needs sbx`;
Account A 5e3a0581 restores successfully against Home :3033. Controller
5964761d-2877-45f3-89f0-83aa71805967 / installation
0a3dcc64-01cf-49d2-aa2c-c6ea1168f2a0 matches its current machine row.
Its projection settles `error: access-denied` with a current routed lifetime;
repair returns `controller_unavailable` before Action dispatch. This replay is
[blocked] until the stack/controller owner restores projection access. Evidence:
`.project/tmp/MACH-SBX-CARD/live-replay.{json,png}` and `signin.log`.
The lane's browser was closed through its own foreground controller.
Risk: successful live documentation navigation remains unverified; O-MACH /
MACH-REPLAY-85 must replay once controller projection access is available.
