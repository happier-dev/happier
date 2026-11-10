READY FOR RELOAD — #111 recovery/withdrawal owner fixes GREEN; current-source entry-loads13/13.

O-DEPLOY: reload the named daemon after the committed RESULT, then have
QA-HEALTH-PUBLISH-1109 replay up → down → recovered → observation removal through
both widths and public service Actions. No loaded success for these fixes is
claimed. No typechecks ran; typecheck left to the package wave.

Observed loaded basis: #111 source23:18:00.650Z, prior publisher54da234df1;
HTTP200→up and stop→down PASS, but recovery/removal retain down/current.
Machine eadc2422-b42b-478d-97b1-af9b530d5f08, service
d2c77738-2a18-4515-8556-9ef22faad499. Evidence: QA-HEALTH-PUBLISH-1109.md
and .project/tmp/QA-HEALTH-PUBLISH-1109/r111-*; fixture was cleaned by QA.

Recovery owner: packages/plugins/machine-services/src/healthObserver.ts.
Observed source suppressed finite probes whenever the cursor retained an
unsettled Event. Constructed composed RED uses the real SDK runner, adopted
source, saved HTTP host, publisher and P30 row owner: up→down, admission held,
HTTP restored200, row incorrectly remains down. Fix runs already-due reads
while replaying the retained Event, preserving its identity/payload/first clock;
transition reduction resumes after settlement. No approval bypass or default
change. Raw health updates before any new recovery Event is admitted.
Loaded incident attribution remains derived: QA retained no observer failure
code/request id. Ordinary approval_request_created becomes retryable
admissionUnavailable at the SDK owner; it uses the person's existing period.
Explicit nonretryable refusal still parks by the existing policy.

Withdrawal owner: automationEventAdoptedDefinitionSet.ts commits its adopted
snapshot before notifying the registry. Previously the broker invalidation
reconciled health against the old snapshot and adoption never reconciled again.
The internal onAdopted callback is forwarded through Host and automationAssembly;
the registry reconciles both service and Domain owners after adoption. Initial
reconciliation follows consumer construction. The premature broker subscription
and its disposal are removed. Dynamic incumbent service owner selection remains.
The regression drives actual Home HTTP source revision2 adoption; it never calls
refresh/reconcile directly and retains unrelated service and Domain health.

Deciding AUTO evidence under .project/tmp/:
- VA-REC4-ARMED-r111-recovery-probe.log: terminal0, direct down→up1/1 on old code;
  disproves a plain publisher replacement defect, not the pending Event case.
- VA-REC4-ARMED-r111-pending-recovery-RED-corrected.log: terminal1, intended
  down-versus-up row failure at recovery while original failed Event is pending.
- VA-REC4-ARMED-r111-pending-source-RED.log: terminal1, pending replay prevented
  the due probe after reload; original Event identity remains asserted.
- VA-REC4-ARMED-r111-recovery-GREEN.log: terminal1,20 passed/1 failed;
  producer6/6 and source14/14 pass; restart fixture substituted obsolete HTTP
  request instead of current requestStream, yielding unknown before admission.
  Corrected that transport boundary; recovery-GREEN-final.log terminal0,21/21.
- r111-withdrawal-recorded-red.log: terminal1 after revision2 adoption; removed
  source still down/current. Earlier no-knownRevision attempt is superseded.
- r111-withdrawal-green-adjacent.log: terminal0,49/49 across registry regression,
  adopted Host/DefinitionSet and configured activation. Final recorded-shape
  r111-withdrawal-recorded-green.log: terminal0,1/1, retains unrelated health.
- VA-REC4-ARMED-r111-entry-loads.log: terminal0,13/13 (required7/7).
- QA-HEALTH-PUBLISH-1109/r111-sdk-status-falsifier.log: terminal0,2/2;
  real SDK keeps next finite observation through catalog/source reporting throws.
  r111-sdk-observer-suite.log: terminal0,35/35. No SDK production change.
- Wrong-config RED attempt64913: NOT RUN, cancelled while queued; corrected
  existing vitest.config.ts command above supplies the meaningful RED.

Same-shape sweep: pending admission suppressing finite health reads — one live
adapter site, corrected; SDK owns admission/backoff, not health status. Health
withdrawal before adoption — one registry listener, replaced for both P30 service
and Domain projections. Other pending arrays found by the sweep are unrelated
parser/Agent/SCM state. Sweep: VA-REC4-ARMED-r111-same-shape.log and
r111-withdrawal-sweep.log; final sweep: r111-same-shape-final.log (same lane prefix).
Compatibility health-status and failed/recovered Events
continue through one adapter. UI and public Actions already consume one P30 row;
no UI or Action-specific health inference was added. Docs: plugin-platform.md.

Self-review: tests reject skipping pending probes, replacing pending Event evidence,
and clearing all health on adoption. Equal results still suppress row pushes and
cursor writes. SDK status failure was falsified rather than patched.
Net mechanism delta: +1 internal adoption notification /−1 premature broker
subscription; one pending-probe suppression replaced by Event-custody preservation;
+0 authority checks, states, error codes, timers, retries or persisted fields.
Files:5 production owners,5 tests,1 canonical doc,1 designated report.
File delta:+1 regression/−0; no new runtime modules.

Residual risk: fresh loaded recovery/removal replay is still required after
ORCH-TOP reload. Exact #111 admission failure is unmeasured; do not equate the
constructed pending-admission RED with a logged cause. Approval delivery remains
APPROVAL-DELIVERY-1109's corridor. No Stack lifecycle or Account settings changed.
