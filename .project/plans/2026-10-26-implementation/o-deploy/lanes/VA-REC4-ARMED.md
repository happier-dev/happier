READY FOR RELOAD — #83 review/Health/preset/title checks pass; integrated types and loaded QA deferred.
Commit efc4f89bd8faa9e1a0e2ebb940aaaf205d304846; READY posted18:10 to O-DEPLOY/ORCH-TOP/UI refinements.

Observed current source:
- GuidedAutomationSetup consumes buildGuidedAutomationReadBack before Agent choice;
  describeGuidedAutomation removed. Reads exact Event/filter, Source/Environment,
  controller/availability, pending configuration, effective profile and destination.
- Shared SubjectTriggersSection→Guided seed preserves both Environment and Machine
  service health subjects. Canonical plugin refusal of an absent subject remains.
- Failed-deploy habit carries exact Home/Environment/controller through the existing
  Event editor/setup owner. Guided mode hides known watcher, source and payload fields;
  seeded form submits through the canonical Action controller. No one-off composer work.
- Guided and saved-trigger rows share formatTriggerSummary and the existing localized
  Event declaration presenter. No-label Health Event reads “When Health check failed”.
  Unknown declaration metadata remains generic; cold catalogue demand is not yet proven.
- No styling. docs/deployment.md describes this unreleased owner behavior.

Deciding #83 evidence (all /tmp unless another path is shown):
- RED29486: rendered review lacked filter/Source/controller/profile:
  VA-REC4-ARMED-r83-review-RED.log.
- RED29016: Environment used runtime Machine; both health subjects lost; no-label
  title missing:4 failed/3 native controls passed. VA-REC4-R83-guided-bound-starters-RED.log.
  Earlier62684/35205 health fixture errors are noncausal and excluded.
- Integrated21651: review2/2, setup41/41, read-back7/7, summary17/17, editor3/3,
  localized title presenter3/3 passed: VA-REC4-ARMED-r83-integrated-GREEN.log.
- Composed23980:6/7 passed, including both rendered bound Health paths, declared title
  and3 native controls. Environment controller/seed/hidden-field assertions passed;
  setup Action submission stayed empty at fixture:186. Diagnostic61011 terminal1:
  candidate is offline (legacy activeAt=1); current presence owner correctly refuses it.
  Fixture now publishes presenceProtocolVersion:1 through applyMachines; deciding86543
  terminal0,1/1 passes through real setup dispatch, editor completion and named review.
  No production availability change. Other6 cases were unchanged and passed23980.
  VA-REC4-ARMED-r83-{composed-GREEN,deployment-diagnostic,deployment-final}.log.
- Adjacent content first case times out even alone (33177); attribution unresolved.
  List locale2 failed alone (13866): public locale preload missing in fixture; corrected
  test uses existing preloadTranslations, final95573 terminal0,10/10. Logs r83-editor-adjacent,
  r83-locale-attribution and r83-list-final under VA-REC4-ARMED- prefix.
- Entry16679 AUTO terminal0,7/7 passed: VA-REC4-ARMED-r83-entry-AUTO.log.
  Prior15385 failed4/7 and composed collection failed on foreign eager lazy-schema
  initialization. T2 repaired deployment operations; successful retry supersedes them.
- UI package typecheck explicitly deferred to T2-RECEIPT-1107's single integrated wave
  (O-DEPLOY18:10); UI97061 running at18:17, .project/tmp/T2-RECEIPT-1107/typecheck-*.log.
  No package/delta PASS claimed. Systemic baseline pointer:
  .project/plans/2026-09-28-systemic-deep-audit/lanes/pkg-typecheck-wave-1107.md.

Existing committed verticals retained:
- 2f96085a1fb8: UI Link completion uses canonical completeLink/H4 enrollment; RED68461
  →60/6026490, plain/E2EE/Team routing. No UI enrollment copy.
- c94804ebd89c: typed H4/H6 read-back and private Event Action parity.
- 98e1d5f8e994: r82b requester projection retains admitted private Account executor.
  Causal RED27766→4/486200; existing admission preserved. Entry51703 terminal7/7.
- C7 e1847f913a45 cleanup /91525e9c327e H4 retained. Target-deletion pause RED58107
  →1/176020 +14/14 adjacent (.project/tmp/ODEPLOY-COMMIT-7/deleted-target-pause-*).
  Pure pause uses cleanup admission; mixed saves/re-enable use authoring admission.
- #82 first failure overlaps guest refresh; post-refresh r82b08:22 still failed.
  Reprojection defect fixed above; live watch success remains QA-owned evidence.

UI↔Action parity / canonical owners:
| Read/control | Existing Action |
| --- | --- |
| Exact private Event/filter | workflow.trigger.list({automationId,triggerId}) |
| Source/Environment/controller | environments.get / machines.list |
| Effective approval profile | actions.policy.get |
| Event declaration / setup | plugins.list / contributed setup Action |
| Enrollment / pause / removal | targets.link / trigger.update / trigger.remove |
Event filters/enablement decide waking work; notification channels remain destinations.
No new Action id, severity owner, all-project enrollment or timer/default.

Self-attack: removed competing sentence presenter and automation-list raw Event-id
presenter. Shared seed fixes both entries; existing observer selection owns eligibility.
Concrete remaining gap: formatter cache imports reach a broad UI/transport cycle and
cold saved rows have no demonstrated catalogue demand; follow-up diagnosis is active.
Mechanism delta for #83:+1 shared seed,+1 shared title projection,+2 one-shot guided
setup/completion refs;−1 sentence presenter,−1 raw-id presenter;0 new persisted states,
Actions/error codes/timers/retries/limits. Existing editor/Action lifecycle is reused.

Reload recipe (ORCH/QA owns stack agent-qa-servers-deploy): load committed source,
record selected==loaded, open failed-deploy habit from Environment, then verify named
review; open Health from Environment and Machine service and verify bound forms;
inspect no-label Health row. Current reload84 source16:33 predates these changes.
Residual: cold saved rows can remain generic until Event catalogue acquisition;
normal-editor timeout unattributed; integrated types/live QA unrun. Native approved
Action recipe's deleted-target pause gap was separately routed08:58, not claimed fixed.
