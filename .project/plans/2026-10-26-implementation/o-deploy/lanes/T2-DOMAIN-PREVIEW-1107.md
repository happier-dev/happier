READY FOR RELOAD — owner/UI gates and entry-loads7/7 GREEN; committed through private index.

Observed contract and ownership
- Domain facts reuse saved HTTP/certificate checks, DNS health and `deployments.health.current`.
  No read-triggered probe. An outside observation requires the controller to be separate
  from active serving members and ingress; a serving Machine's check stays local.
- Reference addresses belong to actual build/runtime launch materialization and its receipt.
  Deploy review compares its already-resolved addresses with its existing serving receipt.
  No page-time cross-Environment read or new admission remains authorized.
- Runtime secret revisions reuse the running generation's approved input basis and
  requester-visible saved-secret metadata. Missing evidence stays unknown; values stay private.
  Agents reuse authorized Environment/content/receipt reads. Explicit pins: editor selects
  latest → existing bindings.set Save → Deploy (14:33/15:22 rulings); no automatic latest.
- GitHub preview read/publication share receipt, current-head provenance and Domain readiness.
  The Environment query owner selects exact preview kind, PR and repository.
  One PR read preserves all matching templates; an unavailable child retains its siblings.
- Preview template uses existing Environment update `patch.previewTemplate` (null removes),
  canonical host content preparation, private Artifact writer and existing native input proof.
  Generic Artifact creation refused this private kind; the proposed UI wrapper was removed.
  One template schema serves authored/private content. Home's storage patch excludes it;
  the full input digest binds it, while the existing metadata digest binds remaining leaves.
- P44 automatic close/merge producer not established; no manual bulk Action. Compose J6/P8
  removed. Existing failed/denied per-preview teardown retry retained; O-DEPLOY owns the gap.
- Screens: L-C Domain/Variables, L-D Settings, L-G existing PR Overview per DEPLOY-COMPOSE-1107;
  DOMAIN-READINESS picker untouched.

Deciding evidence observed (all logs under `.project/tmp/T2-DOMAIN-PREVIEW-1107/`)
- Domain demanded-read controller RED→GREEN45; retained owner GREEN1;
  projection/controller GREEN54; Action/Resource producers GREEN4;
  demanded UI adapter GREEN1 (`domain-*-green.log`). Temporary resolver failure RED→GREEN1
  (`domain-resolver-unavailable-{red,green}.log`), classified unknown rather than unreachable.
- Secret comparison: intended RED then GREEN 3/3 (`secret-revision-facts-{red,green}.log`).
  Real metadata owner RED→GREEN 1/1 (`secret-metadata-unit-{red-admitted,green}.log`);
  serving-generation projection GREEN 1/1; adjacent controller GREEN 45/45.
  Mounted push GREEN 1/1 (`secret-revision-push-green-action-cost.log`); setup failures are not RED.
  Existing Variables page notice → existing Deploy GREEN1 (`secret-variables-page-ready.log`).
- Preview readiness: intended RED; current focused GREEN 30 passed
  (`preview-final-green.log`), including superseded active receipt and forged URL refusal.
- Registered preview Action GREEN40 (`preview-operation-green.log`), receipt operation included.
- Real ready publication → registered PR read → L-G Overview passed 1/1 (`preview-ui-green.log`).
  Operation missing-field RED has six failures; canonical four-value union follows 15:28 ruling.
- Exact PR/repository HTTP query: intended RED then GREEN1 (`preview-query-*.log`).
  SQLite indexed EXPLAIN GREEN1 (`preview-index-selector-red.log`, terminal0 despite name).
  PostgreSQL provider GREEN14/14 (`../T2-RECEIPT-1107/postgres-green-2.log`), exact partial index valid.
- Multi-template collection RED→GREEN4 (`preview-collection-green.log`), including unavailable sibling.
- Actual runtime launch capture RED→GREEN 1/1; architecture build capture GREEN 1/1.
  Private-reference materialization GREEN 2/2; review owner and real runtime wiring GREEN 1/1 each.
  Review notice renderer RED→GREEN5 (`reference-renderer-{red,green}.log`), without addresses.
- Template owner RED12 → GREEN18 (`template-patch-final-green.log`); UI RED4 → GREEN4
  (`template-update-ui-green.log`); proof GREEN36; private storage GREEN3.
  Combined adjacent run has two unattributed ERR_BAD_RESPONSE/null expectation failures;
  our template patch does not change error projection. Failed scope/Artifact wrappers were discarded.

Open gates and coordination
- Receipt operation cold-load defect fixed with concrete projection of its sole enum.
  Template storage eager-on-lazy defect fixed by deferring its complete composition.
  Fresh CLI version0.2.10, storage3/3, cold GitHub contracts/full entry and entry-loads7/7 pass
  (`lazy-final-entry-loads.log`). Earlier unattributed voice SyntaxError did not recur.
  Canonical generated DTO publication passed (`template-batch-generation.log`).
  Withdrawn SDK method removed; canonical generated-Action freshness passed after regeneration.
- Cross-Environment admission proposal WITHDRAWN, never applied; protocol batch complete.
- T2-RECEIPT owns package diagnostics after commit (13:48); SEC-ODEPLOY-84 reviews next reload.
- Loaded UI/runtime verification awaits O-DEPLOY's matching participant reload; no loaded
  screen success, stack lifecycle action or push is claimed. Commit uses explicit private-index paths.

Net mechanism delta (production files; regression files also added)
- Actions +1/−0: exact GitHub PR preview read; all writes reuse existing Actions/executor.
- Owner checks +5/−3: Domain health, launch address, secret revision, shared preview readiness,
  template preparation; two obsolete pointer refusals and unconditional ready/URL refusal removed.
- Projection states: Domain availability+3/certificate+5, secret+4 (five reasons), preview
  outdated/unavailable; existing persisted lifecycle+0, error codes+0, admissions+0.
- + private receipt address field and exact PR query/indexes; secret receipt basis reused.
- Cross-Environment read/admission and generic template wrapper withdrawn; no new proof field.
- Files: +1 schema, +1 preview read, +1 secret comparison, +1 PR section, +3 index migrations;
  old modules −0. Timers/retries/caps/probe paths/retained maps each +0/−0.

Residual risk: T2-RECEIPT owns package diagnostics; loaded L-C/L-D/L-G
and distinct outside-controller topology need reload QA.
P44 automatic close/merge producer remains an explicit O-DEPLOY gap; no manual bulk Action added.
