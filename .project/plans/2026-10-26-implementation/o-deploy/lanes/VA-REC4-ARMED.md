READY FOR RELOAD — #113 recovery and misleading removal refusal fixed; loaded replay pending.

O-DEPLOY: reload the matching daemon/readers, then QA-HEALTH-PUBLISH-1109 replays
up → native stop/down → restart/HTTP200/up while the failure Event awaits approval,
then withdrawal, at both widths and through public Actions. Source checks pass;
loaded success is not claimed. Broader Workflow checks have 7 unattributed failures;
docs check finds 2 stale generated API pages. No typechecks ran;
typecheck left to the package wave. O-DEPLOY/Systemic: route normal declaration
and generated-reference refresh to the integration wave; no lane compiler ran.

Observed #113 basis: ad265db371, source2026-11-10T03:08:55.044Z; up/down/withdrawal
PASS. Machine eadc2422-b42b-478d-97b1-af9b530d5f08; service
01d36db6-e765-4773-a8c0-3810d53e233a. QA evidence: QA-HEALTH-PUBLISH-1109.md
and .project/tmp/QA-HEALTH-PUBLISH-1109/r113-*. Its fixture was cleaned.
Exact retained daemon: nl3, agent-qa-servers-deploy/cli/logs/
2026-11-10-04-29-54-pid-2720953-daemon.log (log clock UTC+1).

Observed: final health transport03:55:51.686–.688Z; approval.wait03:55:52.597Z,
executionRequestId c000746a-35fb-43dc-9f46-33abe7fd3871:automation.event.admit:62,
artifact55aaa2e9-4092-85c5-aea2-febfa3bf09b7. Zero health transport attempts
follow the native restart03:56:37Z through04:14Z, despite HTTP200 at04:02:32Z.
Sanitized evidence in .project/tmp/VA-REC4-ARMED-r113-daemon-probe-summary-v3.jsonl,
daemon-last-probe-stages.jsonl and daemon-approval-proof.jsonl (same lane prefix).
Earlier v1/v2 correlation extracts are superseded.

Canonical cause: checkpointedObserver.ts awaited retained Event admission inside
its observation loop. ad265's pending-cursor fix could resume only after admission
returned; the real Action retained its input while waiting for approval.
The SDK now owns one in-memory pending attempt for an explicitly opted-in adapter.
Health opts in; its existing period keeps publishing raw results while original
Event evidence/identity/checkpoint stay retained. Settlement saves the original
candidate serially after any outstanding observation. Removal/cancellation drops
late save effects. Immediate buffered work parks rather than spinning.
No approval bypass, new timer, poll, period, default or consumer coordinator.

Same-shape sweep: triage may replace a pending cursor on signature change, so it
cannot safely observe during admission. Retained-fact, deployment, triage, GitHub
and SDK example adapters retain their original awaited path. Only health opts in.
UI and public service Actions continue consuming the same P30 health row.
Sweep: .project/tmp/VA-REC4-ARMED-r113-observer-consumer-sweep.log.

Separate removal-read cause: recorded agent workflow.trigger.list {automationId,
review:true} requests private legacy-conversion review, refused before storage
at workflowTriggerActions.ts:618. Its existing present_user_required code was
missing from WorkflowActionFailureV1Schema and became storage_unavailable.
The canonical Workflow vocabulary now admits that existing refusal; its full enum
derives the no-details subset. Authority is unchanged. Ordinary trigger detail
uses automationId + triggerId. This is distinct from the health approval wait.
Matching unpublished0.3 readers reload together; no persisted format/epoch changes.

Deciding AUTO checks (all terminal; paths under .project/tmp/):
- VA-REC4-ARMED-r113-recovery-red.log: exit1; returned-unsettled passes, held
  approval leaves last raw result181000 instead of recovery241000.
- VA-REC4-ARMED-r113-sdk-red.log: exit1; blocked schedule and late removed save.
- VA-REC4-ARMED-r113-recovery-green-final.log: exit0,22/22 across saved health,
  source and restart suites, including held approval/native recovery/withdrawal.
- VA-REC4-ARMED-r113-sdk-final-full.log: exit0,42/42; serialized original save,
  one admission, cancellation/removal, no spin, typed rejection and default wakes.
- QA-HEALTH-PUBLISH-1109/r113-agent-review-red.log: exit1, storage vs refusal.
  r113-agent-review-focused-green.log: exit0,1/1; r113-agent-review-green.log:
  Workflow schema45/45 and Action schema26/26 pass; total168pass/7fail.
  Unattributed: workflowAccountActions.test.ts:63,70,115,157,173 and legacy host
  approval expectations:179,183. No A/B or unrelated authority edits.
- VA-REC4-ARMED-r113-entry-loads.log: exit0,13/13 (required7/7).
- VA-REC4-ARMED-r113-docs-check.log: exit1, only generated plugins/api/surface.mdx
  and host-actions.mdx stale; no changed-guide/link failures. Left untouched.
Interim SDK spin/OOM and default-wake regression were fixed and covered by final42;
first composed GREEN had stale native-reason push counts, corrected in final22.

Self-review rejected generic concurrent observations because triage overwrites
pending evidence; the optional capability preserves that sibling's old contract.
Net: +1 SDK capability/+1 in-memory pending-attempt owner; +0 timers/retries/new
error codes/persisted fields/runtime files. One existing refusal gains schema
membership; duplicated vocabulary entries are removed. Three production owners,
three tests, five docs and this report. Tracked API export census unchanged;
signature reports are ignored/generated by the normal package build.

Residual risk: loaded recovery with a real pending approval still needs the named
reload/replay. No new daemon/browser/Account mutation or lifecycle change was run.
The broader Workflow and generated-doc failures remain unattributed, not green.
