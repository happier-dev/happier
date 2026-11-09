READY FOR RELOAD — #109 Home-identity publication fix; health6/6 and entry-loads13/13 GREEN.

O-DEPLOY: after commit/reload, rerun the same-Machine saved-check journey with a
fresh eadc service. No loaded health success is claimed yet. No typechecks ran;
typecheck left to the package wave. Approval delivery is outside this change.

Observed incident: QA-HEALTH-PUBLISH-1109 #109, source21:11:45Z, service
6d6375ac-3a3c-4d1a-bf45-6af1f3dba203 on eadc2422-b42b-478d-97b1-af9b530d5f08
remains running/unknown despite the saved HTTP check. Watcher and subject are the
same Machine. Editing/reopening passes at both widths in that loaded run.
Evidence: .project/tmp/QA-HEALTH-PUBLISH-1109/r109-check-before.json,
r109-check-after-phone.json, r109-service-final-public.json and
r109-agent-edit-request.json. The last records a local profile distinct from the
canonical Home id. Its earlier fixture-log capture predates check enrollment and
does not prove a post-enrollment probe. QA removed that fixture afterwards.

Observed source: api/machine/machineServicesBinding.ts admits service handles with
resolveServerProfileHomeIdentityId(profileId). The runtime registry supplies the
saved-health host with configuration.activeServerId (local profile). Its old raw
serverId comparison silently skipped the canonical handle. The reader already
uses isServerProfileHomeIdentity, so this was a publication binding defect.
Derived incident cause: this mismatch explains the recorded same-Machine shape;
a fresh loaded replay must establish that no additional producer issue remains.

Fix: deployments/healthChecks/publishServiceHealth.ts is the extracted production
publisher, consumed by resolveExecutablePluginRuntimeRegistry.ts. It uses the
existing server-profile identity owner, then publishes against the admitted
handle's Home id. Machine/service/generation selection and the row owner's exact
binding/currentness/retirement guards stay authoritative. No new identity list,
transport, UI inference, observer, timer or poll. Dynamic incumbent owner selection
remains at callback invocation. docs/plugin-platform.md documents this binding.

Deciding constructed evidence (AUTO, terminal results):
- .project/tmp/VA-REC4-ARMED-r109-health-RED.log: terminal1, one intended failure;
  HTTP200 completed but service health was unknown instead of up when admitted
  profile id differed from Home id. Earlier tests bypassed this real publisher.
- .project/tmp/VA-REC4-ARMED-r109-health-GREEN.log: terminal0,6/6.
  Same regression now proves up/down, another Home refused, no clock-only pushes,
  and source withdrawal. Retirement regression also consumes the real publisher:
  native-down priority, invocation completion, replacement and retirement hold.
- .project/tmp/VA-REC4-ARMED-r109-entry-loads.log: terminal0,13/13 current-source graphs.
- Earlier publication-sweep attempt exited2 for an incorrect target filename;
  final corrected sweep completed0 (r109-publication-sweep-final.log).

Same-shape sweep: production service health has one onServiceResult binding and
one publishHealthResult owner. Machine read/disclosure/project declaration paths
already consume the canonical profile/Home helper. The row projector deliberately
compares normalized admitted targets exactly. Domain health publishes its admitted
Environment/target records through currentDomainEdgeObservation; it does not bind
service handles by local profile. Both Machine and Project handle collections use
the same extracted publisher. Internal test bypasses in the two touched cases were
removed; only HTTP, Action IPC and native lifecycle boundaries are substituted.

Self-review: removing normalization reproduces RED; accepting every Home would
fail the wrong-Home assertion. No live timing/currentness authority moved. Net:
+1 extracted source module/−0; +1 canonical Home comparison/−1 raw profile equality;
+0 states, error codes, timers, retries, persisted formats or dependencies.
Existing reader/projector/currentness owners remain the single authorities.

Production publisher/wiring were swept into54da234df1865523f6aaf1e39a272e0849bf47b9
while validation ran; current filesystem blobs match HEAD. This lane commits the
remaining regression and report with private index/CAS; shared index untouched.

Prior deliverables retained: saved-check editing38dcb02b04 and typed save diagnostics
7d55fea336; #109 loaded editing passed. Retirement cleanup51dc9d6c95 is retained.
Earlier full cohort23919 and entry32496 passed but did not prove this publication
binding, because their callback sent health directly to the row owner.

Residual: loaded replay requires O-DEPLOY reload and a fresh same-Machine service:
create/save check, HTTP200→up, fail/stop→down, recover→up, remove/retire→withdraw;
compare UI and public service Action results. Cross-Machine observer delivery to a
remote handle remains outside this local publication correction and needs its
P50/P30 transport owner. It is not the cause of #109's same-Machine mismatch.
No Availability or approval-delivery files changed. No package diagnostics claimed.
