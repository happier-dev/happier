IMPLEMENTED_NOT_VERIFIED — committed fixes; live Lima/disclosure verification and integration-owned UI typecheck remain owed.
| Gap | Owner reused | RED → GREEN | Live |
| --- | --- | --- | --- |
| SH-UI-WAKE | buildMachineDestinationModel destination eligibility | owner/list 95/95 after correcting shared Session fixtures to include admitted newSessionWake | QA B connected; requested Lima absent |
| MachineSelector bypass | same eligibility result and worker-fact description; canonical list availability | four intended asleep/starting list/dropdown failures → selector 10/10 | no matching Lima row to select |
| FIRST-LAUNCH-UI | machineDefaultDirectory classification; existing preparation-on-Send | prior lane RED retained; composer 2 passed, 45 filtered skips; directory/chips 27/27 | launch intentionally not exercised |
SH-PC-PURPOSE CLOSED: unchanged production purpose policy, per 2026-11-03 owner ruling superseding plan41:560–563; stale refusal tests corrected.
Commits: `4b1a0ece161a` canonical wake owner + two tests; `928da557c156` first-launch owner/presentation/locales/tests.
Selector + this report are committed by this lane's final commit (see Git history); no push.
First-launch hook/composer changes already present in captured HEAD were retained; remaining patch committed, including compatible shared-file hunks named in commit messages.
Touched selector paths: apps/ui/sources/components/sessions/new/components/{MachineSelector.tsx,MachineSelector.offlineDisable.test.tsx}.
Inherited patch paths: GAP-PICKER.md and FIRST-LAUNCH-UI.md inventories; actual commit pathsets are authoritative.
Evidence root: `impl-C/qa-shots5/gaps/gap-picker2/` (relative to this review directory).
Logs: picker-green.log; selector-red.log; selector-green.log; first-launch-rerun.log; folder-green.log; entry-loads.log.
Entry-loads: 7/7 passed against current source; no unattributed entry-load failures, so Coordination's 17:38Z exception was unnecessary.
Composer emitted an SCM boundary warning; selector emitted act warnings; assertions passed. No whole-suite or whole-package green claim.
Live: canonical stack agent-qa-l12-c, Home :3039 / Expo :19364; observed READY reload115 before navigation; QA TH B connected via canonical stdin-only key flow.
New Session composer picker listed own targets and unrelated shared targets; searching Lima returned no machines. All Machines showed only qa-usage-visuals-owner shares, no C Lima 72d1f17a.
Evidence: live-picker.txt/png, live-lima-search.txt, live-all-machines.txt/png. These establish absence, not the requested selectability or disclosure.
[blocked] Live Lima selection + “How shared machines work”: prerequisite is C's existing shared Lima being visible to QA B on this Home; integration owner should restore/confirm the fixture, then repeat without Send.
No Send, resource lifecycle action, shared settings change, or fixture mutation; own browser closed and forwarding handle exited.
Split-brain audit: removed dropdown's presence-only wake veto and default list adapter's independent availability override; ordinary presence and explicit administrative offline opt-in remain intentional.
Caller audit: preview route/modal and Voice Session consume Session eligibility; Workflow/Workspace activation and Embed selectors consume their existing purpose through the same owner; no purpose policy change.
Self-attack: absent admission remains refused by owner tests; ordinary offline rows remain disabled; selection returns original Machine identity; no layout change or new transport/subscription.
Net mechanism delta: independent presence-only decisions +0/−2; canonical first-launch classification +1/−0 and chip state +1/−0 prevent the reproduced preparation deadlock; checks otherwise replaced in place.
Error codes/timers/retries/new production files +0/−0; requested report +1/−0. Twelve locale copies reuse the existing folder translation owner.
No documentation contract changed: this projects existing admitted wake and deliberate preparation behavior through existing UI owners.
Residual risk: UI typecheck is deferred to Fork C's integration wave; full light/dark 1440/390 matrix and native/device QA were not run; unavailable shared fixture prevents the requested live proof.
