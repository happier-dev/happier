# Lane 12.52 — Managed retention, controller custody and accepted-input wake

Status: **APPROVED 2026-10-08 — slices implemented with focused GREEN; Main's composed lifecycle/integration and loaded-runtime evidence remain open (see §11 status)**
Contract revision: **r9.4**  
Date: **2026-10-06**  
Plan-writing owner: **PE1**. Implementation approval: none.

Supersedes: [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) retained-resource power/idle/wake/cleanup
portions; [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md) the generic
retention/controller algorithms. Provider-native implementations remain 50/53–56. 
Extends: `50-managed-resources-and-enrollment.md` 50s2/50s3 persisted desired intent/observation/cleanup through the
same row writer; consumes the shared reversible daemon `admissionDrain` first extracted by
`31-finite-worker-admission.md` s1 in W2, and extends it in 52s1/W3 with unused-stop reason/custody. 
Consumes: `50-managed-resources-and-enrollment.md` 50s1 native role/capability schema and Lima IO, 50s2 durable
row/current controller/admission, 50s3 recovery detail; `51-managed-presets-and-creation.md` 51s1 selected policy and
51s2/3 receipt/composer; `31-finite-worker-admission.md` s1–s3 actual accepted queue/preparation/reservation/exit;
`22-project-services-and-surfaces.md` s1/s3 supervisor-owned service lifetime; `32-service-placement-and-relocation.md`
s1/s2 actual current service worker; `41-machine-sharing-and-project-terminals.md` s1–s3 signed MachineAdmission/current
grants and real PTY custody; `42-requester-sessions-and-work-visibility.md` s1/s2 current requester Session/pending
recovery; `25-devcontainer-child-machines.md` s1/s3 closed native rebuild specialization;
`70-shared-ui-and-plugin-presentation.md` s1/s4 status/step/phone anatomy;
`71-action-placement-and-parity-integration.md` s1–s3 normal approval and answering-client parity. 
Consumes: FIN finalization `03-account-actions-library-and-live-state.md` §§5.3/6.5 and
`06-human-review-and-draft-results.md` §6.3; ORC `.project/plans/2026-09-27-orchestration-workstreams/PLAN.md` §3.2;
INT `.project/plans/2026-09-29-unified-agent-work/PLAN.md` §3 context-slot and I3 rows. Server delivery is the wake
producer; runtime-derived WorkerUpdate is not. Actual released work holds and current requester authority remain binding.
Provides: 52s1 the internal `LiveWorkInventoryV1` producer to 42s3 and supported intent/retention/unused-stop extension
of 31s1's reversible drain to 50s2, 25s3 and `53-local-lume-and-cua-providers.md` s1–s3 /
`54-hetzner-digitalocean-and-fly-providers.md` s1–s3 / `55-docker-modal-and-crabbox-providers.md` s1–s3 /
`56-cua-byoc-and-fleet-providers.md` s1/s2; 52s2 same-resource/same-Session wake and withdrawal to 42s2, 51s3,
`60-bots-session-identity-and-pins.md` s2/s3 and `62-bound-voice-instructions.md` s3 (Talk stays non-waking); 52s3
dependency/erasure preflight to 50s3/51s2 and existing Account/plugin/credential owners.

Authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,5–10; `SYNTHESIS.md` D1–D42. The
Machine row/normal pending queue remain their existing/50 owners; this plan owns intent algorithms and their consumed
daemon boundary, not another persistence authority.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE1 names the managed-resource core plan-writing lane (plans 50–52).
- ORC is `.project/plans/2026-09-27-orchestration-workstreams/PLAN.md`; it owns agent-start policy, turn facts and host-context consumers.
- FIN is `.project/plans/automation-workflows-and-steps/`; it owns workflows, claims, delivery, completion and lifecycle triggers.
- INT is `.project/plans/2026-09-29-unified-agent-work/PLAN.md`; it owns context-slot contracts, status and glossary.
- Finite scripts are Lane 12 plans 21/31; ORC WorkerUpdates are runtime-derived, not server-persisted wake requests.
- B25 refers to plan 25, Devcontainer child Machines.
- C31 refers to plan 31, finite worker admission.
- B22 refers to plan 22, Project services.
- C32 refers to plan 32, service placement.
- D41 refers to plan 41, Machine sharing and Project terminals.
- W2 and W3 are implementation waves defined in the program index; they do not introduce separate owners.
- E2EE means end-to-end encryption; DEK means data-encryption key.
- PTY means pseudoterminal; PTYS refers to pseudoterminal sessions.

## 1. Outcome and user value

- **RT-R1:** choose Keep using D21 descriptor-billing category defaults and user preferences, explicitly selected unused interval/effect, or reviewed
  interrupting deadline; distinguish Happier policy from native provider expiry and continued storage billing. 51 derives finite-only Ends as the sole lifetime
  control.
- **RT-R2:** Start/Stop/Suspend/Resume/Delete/End now are truthful supported native intents on the same resource. Command acceptance is not observed stop,
  absence or saved storage. Unknown/incomplete cleanup stays visible.
- **RT-R3:** unused shutdown never interrupts accepted/preparing/held work, execution/workflow/trigger runs, retained PTYs,
  services, transfer/handoff custody or unknown activity. Temporary drain
  is reversible and cannot dispose the plugin runtime.
- **RT-R4:** category-default or explicitly selected wake-on-accepted-message/run restores the same resource, ordinary requester Session and native thread
  from retained disk through normal pending custody; no passive read/pin/Watch/Talk wake, second queue or automatic replacement after loss.
- **RT-R5:** one exact controller installation owns native custody. Cloud reassignment is explicit and uses the same accessible credential, disclosed pending native
  effects and current admission for future dispatch. No automatic failover; physically local resources do not move.
- **RT-R6:** missing controller/plugin/credential and erasure display exact resource/cost/manual responsibility, preserve emergency revoke, and never falsely
  declare deletion or invent escrow.

Labs: final lab `.happier/design-lab/lane12-final/` (D27): `m-config A/Ap`, `m-detail A/Ap/B/B2/Bp`, `m-defaults A/Ap`, `m-life A` lifecycle and billing truth;
`b-wake A/Ap/S` accepted-wait → start → connect → resume plus phone/error/detail.
`m-life W` supplies Boards/run waiting-wake-failure states; `b-inbox I/Ip` supplies same-owner recovery attention.
Prototype timeouts and click-to-replay progression are visual scaffolding, not lifecycle. D21 supersedes prototype-specific default selection;
the same descriptor-fact resolver applies across local and cloud leaves.

## 2. User-facing flows and exact copy

**D21 Settings → Machines:** the final `m-defaults A/Ap` surface is reached through a top-of-list “Defaults” row → “Machine defaults” page, NEW
`/settings/machines/defaults` route (Home-qualified, using the existing settings navigation owner). 52s3 owns the route, Machines row and shared desktop/phone
body; Back returns to the same Machines list and retained selection. Add four small category controls: “Local virtual machines”, “Cloud
billed only while running”, “Cloud billed while stopped”, “Billing unknown”. Each uses51's shared Keep/wake control,
shows current category default and Reset to default, with “Stop after 1 h unused” / “Until I delete it” and “Wake on the
next message or run”. Save writes the canonical Account preference through existing settings.get/set; per-preset and
per-machine editors visibly offer inherited category versus explicit override via51/50 rows. No instance list, cost
quote, idle timestamp or status is persisted in settings. **D23 controls:** on actual session-created/task-created
managed detail offer “When this session is archived: Keep / Stop / Delete” or “When the task finishes: Keep / Stop / Delete”, default Keep (D42). Pending
busy/unknown displays “Waiting for work to finish” and retains selected scope/effect. Existing selected machines do not
get this creation-scoped control. “Keep” means no scope-end rule: leave retention/wake policy unchanged and create no Automation binding; choosing Keep for an
existing rule clears that binding through the existing Automation owner, without a power effect. Phone uses the same fields/sheets, consent and focus return.

“Nothing runs” includes execution/workflow runs, queued/preparing/held material work and active trigger occurrences,
not just Sessions/scripts/PTYs. A parked hold counts while its owner retains material work; a released parked run or a future trigger definition alone
does not keep the Machine busy. Unknown producer coverage cannot establish inactivity.

Desktop/detail: Machines managed row → 50 pre-enrollment detail, or existing
`app/(app)/machine/[id]/index.tsx#MachineDetailScreen` after enrollment (saved managed route redirects there) → same
receipt/current work from 51 → live Keep policy + “Wake on the next message or run” → supported power menu → Delete review.
Inspect/Check now is read-only. Power controls display native support and desired versus observed state, retained
storage and billing; confirmed absence/expired/volume missing is not a grey “offline” row. When a deadline can interrupt
active work, review that explicitly with effect/time/resource/dependencies and normal approval.

Settings/preset: 51 uses these exact Keep/wake schemas/defaults for future launches. Changing the preset is not
`retention.update` on an existing allocation. Acquired detail updates current policy on exact id/expected revision;
policy conflict retains the edit and asks for current review. Disabling creation does not hide retained resource
controls/cleanup.

Phone: detail push → Keep choice push/explicit time/effect input → consequence review; power/cleanup/controller in
existing Overlay menu/sheet; wake uses 50s3's shared managed-progress badge in AgentInput's existing status row beside ordinary pending input;
detail opens actual
Machine/controller/operation. Back preserves draft and selection; close/back never powers off or withdraws.
Keyboard/safe areas remain usable, actions accessible beyond the badge icon. Phone is a viewing/approval surface, not
presumed executor.

Wake: send under normal Session input authority; if explicitly selected wake policy and current power authority permit
it, existing pending row remains canonical and controller receives content-free target authorization. Inline
stage/Avatar/ordinary Machine detail use the same derived projection: Waiting → Starting → Connecting → Resuming. Only
observed facts advance it. Original pending bubble remains queued until real pending delivery owner settles it;
animation cannot label Delivered. Withdraw invokes the exact ordinary pending removal owner and restores original draft
only after confirmed removal and while that composer context still applies. Already delivered/uncertain input has a
distinct response, not “Moved back”. An already submitted native Start cannot be unsent; removing its last queued
message does not automatically kill/start-delete the resource.

Offline controller is named and leaves accepted input pending; repair/Check now may resume authorized same intent, never
choose another controller. Missing native resource/storage explains recovery and ordinary draft/handoff options; no
automatic new allocation/Session. Explicit Start without message follows normal power Action; repeated inspection,
navigation, Session pin/roster, Watch and Talk do not Start.

Controller: managed detail → Managed from → explicit cloud Move to an admitted qualified Machine installation that can
reach the same custodian-held credential, by the owner or current Manage actor through 41. Review pending native effects
and current target; pending/unknown effects and possible cost are disclosed, not an indefinite Move refusal (D42). Local controller displays
why it is fixed; no transfer promise. Reassign only future dispatch custody; existing resource/Machine
identity and history stay.

Plugin/credential/account removal: existing remove/revoke/erasure front door lists affected managed ids/native recovery
links/controllers and current cleanup/cost. User may attempt approved cleanup through the actual owner or explicitly
retain manual responsibility under RT-D1; emergency revoke always proceeds. Unknown cleanup never says free/deleted.
UI/CLI/Agent/MCP/Voice have the same preflight/result and cannot bypass human approval by choosing a shortcut.

New English keys under host translations (existing generic Retry/Cancel/Delete/Back reused):

| Key | English string | State / next action |
| --- | --- | --- |
| `managedRetention.defaults` / `.defaultsTitle` | “Defaults” / “Machine defaults” | Machines list row and `/settings/machines/defaults` page |
| `managedRetention.scopeKeep` | “Keep” | No archive/task-finished binding; existing retention/wake remains |
| `managedRetention.untilDelete` | “Until I delete it” | D21 stopped-billed/unknown default; no timer |
| `managedRetention.unused` | “{effect} after {duration} unused” | D21 local/running-only default or explicit override |
| `managedRetention.deadline` | “{effect} at {time}” | Explicit deadline |
| `managedRetention.interrupts` | “This deadline can interrupt work on this machine.” | Reviewed consequence |
| `managedRetention.nativeExpiry` | “{provider} ends this resource at {time}, even if it is working.” | External native fact |
| `managedRetention.wake` | “Wake on the next message or run” | D21 resolved category default or explicit override |
| `managedRetention.wakeHelp` | “Accepted messages or runs can start this same machine. Viewing it won’t.” | Current supported policy disclosure |
| `managedRetention.busy` | “Keeping it running while work is active.” | Actual positive busy |
| `managedRetention.activityUnknown` | “Activity couldn’t be confirmed. It won’t stop for inactivity.” | Unknown; Check now/repair |
| `managedRetention.draining` | “Finishing accepted work before stopping.” | Real reversible drain |
| `managedRetention.conflict` | “The policy changed. Review the latest policy before saving.” | Expected-revision conflict |
| `managedPower.unsupported` | “{provider} doesn’t support {effect} for this resource.” | Typed unavailable, never substitute |
| `managedPower.stopPending` | “Stop requested. Stopping hasn’t been confirmed.” | Pending/unknown native result |
| `managedPower.stoppedStorage` | “Stopped · storage retained” | Both facts observed |
| `managedPower.storageUnknown` | “Storage couldn’t be confirmed.” | Unknown, not lost |
| `managedPower.resourceAbsent` | “This resource no longer exists.” | Confirmed native absence |
| `managedPower.expired` | “This resource ended at its provider time limit.” | Confirmed expiry |
| `managedPower.volumeLost` | “Its stored workspace is no longer available.” | Confirmed loss; no silent new machine |
| `managedWake.waiting` | “Message queued · waiting for {controller}” | Offline controller |
| `managedWake.starting` | “Starting {machine}…” | Native current Start |
| `managedWake.connecting` | “Connecting {machine} to {home}…” | Native running, daemon not yet ready |
| `managedWake.resuming` | “Resuming this session…” | Normal runtime recovery, same identity |
| `managedWake.refused` | “This message can’t wake the machine with your current access.” | Refused; retain actual pending status |
| `managedWake.unavailable` | “The machine couldn’t wake. Your message is still queued.” | Only if owner confirms queued |
| `managedWake.agentStartFailed` | “{machine} is awake, but {agent} couldn’t start. Your message is still queued.” | Only confirmed queued input; Retry uses the existing same-Session recovery owner after inspecting current launch/pending status, never reacquires compute or blindly repeats an ambiguous launch. |
| `managedWake.runFailed` | “Couldn’t start {machine}: {reason}. {script} didn’t run.” | Definite pre-execution failure only; Try again is available after the retained operation failed/canceled, never an automatic replay. |
| `managedWake.withdraw` | “Move back to composer” | Confirmed removable pending request |
| `managedWake.alreadyDelivered` | “This message has already been delivered.” | No fake withdrawal |
| `managedWake.deliveryUnknown` | “Delivery hasn’t been confirmed. Check its pending status before sending again.” | Fenced/uncertain owner state |
| `managedController.move` | “Move management to {controller}” | Cloud explicit Action |
| `managedController.fixedLocal` | “This machine is stored on {controller}. Management can’t move to another computer.” | Physical local custody |
| `managedController.pending` | “A provider action may still finish after you move management. Charges may continue.” | Move review; retain native handle/unknown recovery |
| `managedCleanup.pending` | “Deletion hasn’t been confirmed. Provider charges may continue.” | Unknown/incomplete cleanup |
| `managedCleanup.manual` | “You’ll need to manage this resource directly with {provider}.” | Explicit responsibility disposition |
| `managedCleanup.archiveReview` | “Hide this resource from the list? It may still be billed. You can reopen its recovery details.” | Non-destructive archive with manual responsibility; never claim absence |
| `managedCleanup.eraseReview` | “Review these resources before erasing the account. Erasing Happier data won’t delete them at the provider.” | Exact preflight |

Error copy reads truthful typed outcome, not a catch-all Failed which discards queued/accepted/unknown distinctions.
Forbidden views reveal no protected content. Missing credentials/plugin uses 50 keys/real repair Actions; stale
observations remain dated.

## 3. Current owners and change map

**D21/D23 owner additions:** canonical Account preference registry, declared settings Actions and existing Machines
settings page own category declarations. Existing Automation CRUD/trigger and `automationSessionLifecycle.ts`
sessionArchived/durable run-terminal facts own scope bindings;52 extends only the intent/idle/drain consumer. No
managed-row scope field, archive watcher or settings backdoor writes resource/binding state.

Observed 2026-10-05 on moving source, HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`. 50's row/native contracts are
proposed prerequisites, not already landed.

| Verified path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `apps/cli/src/daemon/lifecycle/createBeforeShutdownDrain.ts:43` closure; disposal `:55,132,141,169`; `startDaemon.ts:679` `isDaemonQuiescing` | CONSUME / EXTEND | 31s1 extracts NEW `admissionDrain.ts` in W2 as the first finite consumer; 52s1/W3 adds unused-stop reason, preserving final shutdown's once-only disposal/budgets |
| `apps/cli/src/daemon/startDaemon.ts:725,735` tracked sessions/drain; `:1678,1682` Local Services routes/summary | EXTEND | Wire actual producer observations and shared admission, not Session-count heuristic |
| `apps/cli/src/daemon/startDaemon.ts:679,705` `isDaemonQuiescing`/lock-handoff quiescence; `apps/cli/src/plugins/daemon/changeService.ts:609,637` quiesce/read | REFINE / REUSE | Compose existing fresh-admission causes at one owner; preserve reason-specific publications and plugin approval custody, never call handoff quiescence as unused-stop drain |
| `apps/cli/src/daemon/sessions/trackedSessionActiveTurn.ts:10` | REUSE | Exact tracked turn evidence; null is not proven idle |
| `apps/cli/src/daemon/startup/providerInputAdmissionRuntime.ts:23,80,133` input call/tracker/retry | REUSE / REFINE | Fresh admission/currentness joins reversible boundary without another retry/deadline owner |
| `apps/server/sources/app/session/pending/pendingActivationAuthorization.ts:75,142` arm/removal | EXTEND | Existing authenticated accepted request/activation carrier; add managed target authorization, reconcile on withdrawal |
| `apps/server/sources/app/session/pending/pendingMessageService.ts:2178,2232` delete/activation reconcile | REUSE | Pending withdrawal wins only before fenced delivery; no E message deletion table |
| `apps/server/sources/app/automations/automationRunAdmissionService.ts#admitAutomationRunTx/admitAutomationRunsTx`; `automationRunService.ts` retry; `workflows/workflowRunService.ts#completeWorkflowInvocationReview/#resumeWorkflowRunBoundary` | EXTEND | Committed assigned/parked/retried run delivery targets the current controller through existing content-free publication; assigned guest alone claims |
| `apps/server/sources/app/workflows/workflowRunService.ts#reconcileWorkflowRunAttentionAndHintTx`; `apps/server/sources/app/automations/automationClaimService.ts#runAssignmentClaimWhere` | EXTEND / REUSE | Committed deliverable input/terminal delivery may arm wake; attention-only cannot. Preserve AccountChange publication and exact assigned guest claim |
| `apps/cli/src/daemon/sessions/pendingSessionActivationRecovery.ts:27,62` recovery/loop | EXTEND | Existing reconnect path to exact managed controller with current requester authority; no alternate wake scheduler |
| `apps/cli/src/daemon/sessions/activatePendingInactiveSession.ts:32` | EXTEND | Same Session/native resume after actual native Start/daemon serviceability, not new Session |
| `apps/ui/sources/components/sessions/shell/SessionView.tsx:6040` `handleEditPendingMessage`; `sessions/pending/PendingMessagesTranscriptBlock.tsx:378/:390/:397` delete/discard | REUSE / REFINE | Exact pending edit/document/draft and delete/discard owners; wake Withdraw consumes their qualified result/currentness rather than another draft restoration implementation |
| `apps/ui/sources/sync/domains/pending/pendingQueueWake.ts:34` | REFINE | Distinguish runtime consumer recovery from managed power; passive calls cannot admit Start |
| `apps/ui/sources/sync/ops/sessions.ts:512,521` resume/ensure pending consumer | REUSE / REFINE | Current same-Session resume/custody and target handling, consume 42 foreign-Machine changes |
| `apps/server/sources/app/plugins/data/accountDataErase.ts:584,591` erase/preflight | EXTEND | Exact managed dependencies/manual responsibility before ordinary erasure, emergency revoke separate |
| `packages/protocol/src/actions/actionSpecs.ts:822,11825`; `actionIds.ts:82,169,190` pending catalog | EXTEND | Managed intents and narrow missing withdrawal spec, generated eligible projections |
| `apps/stack/scripts/utils/managed_lima/lifecycle.mjs:124,153,167` | CONSUME / REFINE (50) | Inspect/start/stop native semantics; command return is not an observation |
| `packages/plugin-ui/src/components/State.tsx:354`; `packages/plugin-ui/src/components/Step.tsx:33`; `apps/ui/sources/components/ui/motion/motionTokens.ts:4` | REUSE | Freshness/observed-step composition and motion, not new status engine |

Existing deciding suites: CLI `daemon/lifecycle/createBeforeShutdownDrain.test.ts`,
`daemon/sessions/{pendingSessionActivationRecovery,activatePendingInactiveSession}.test.ts`; server
`app/session/pending/{pendingActivationAuthorization,pendingMessageService}.spec.ts`,
`pendingMutationAuthority.sqlite.integration.spec.ts`, `pendingMessageService.sharedSession.integration.spec.ts`; server
`app/plugins/data/accountDataErase.sqlite.integration.spec.ts`; UI `sync/domains/pending/pendingQueueWake.test.ts` and
Machine collection/ordinary pending tests. 31/22/41 own their actual finite/service/PTY producers. 52s1 composes them
once into internal `LiveWorkInventoryV1`; retention and 42s3 owner-or-current-Manage counts are its distinct consumers.
The public numeric summary is not full idle truth and never feeds the inventory.

## 4. Split-brains contracted here

50's single managed row mutation service remains desired-intent/revision/controller/cleanup authority. 52 algorithms
execute through it. Operations are observations, not power truth; UI cannot derive Stop from “daemon offline” or delete
custody from a closed sheet. Native adapters report strict facts; no provider-specific retention daemon.

One daemon admission boundary serves finite worker and managed temporary drain; final shutdown wraps the same boundary
then performs irreversible final disposal. Refine the existing `isDaemonQuiescing` admission consumers and lock-handoff
causes rather than add an independent retention Boolean beside them. The observed plugin `quiesceForHandoff` retires
awaiting plugin decisions and pauses publication; it is **not** a safe generic unused-stop helper. Keep its
plugin-change exclusion/custody owner and compose its real handoff cause; temporary retention drain must preserve
pending plugin decisions and the live observation/publication needed to decide activity. Remove duplicated reject logic
at overlapping live launch/input paths; use reason-specific admission/publication decisions at the one lifecycle owner.
Existing provider turn custody, finite reservation, Local Services supervisor, PTY/transfer owners remain their own
domain authorities; they feed activity through the shared lifecycle composition instead of another activity store. Do
not treat failure to query one as zero work.

Existing pending message/activation/removal/current requester owner wins over E queue, Bot inbox or a server wake
service. UI runtime wake helpers and daemon reconnect both consume its accepted authorization and the same managed
intent, never independently submit purchases/start intents from `pendingCount > 0`. 42 owns shared requester credential
routes; no wake path substitutes custodian credential for the requester's Session. Remove draft
`managedMachine.*`/End-now special power bypass aliases; B25's real rebuild remains one closed specialization.

## 5. Contracts, settings, persistence and routing

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 — binding category defaults (52 is the sole resolver):** local VMs →
`{kind:'unused',afterMs:3600000,effect:'stop'}` + wake on next accepted message/run; cloud charged only while running →
the same Stop after 1 h unused + wake; cloud charged even when stopped → Until I delete it; unknown stopped-billing fact
→ Until I delete it. Determine local/cloud from validated descriptor facts and the cloud category from its explicit
stopped compute billing fact, never provider IDs/titles. Retained storage charges are separate disclosure; Fly remains running-billed (D42). NEW small canonical Account preference `machineRetentionDefaultsV1`
contains only per-category retention/wake overrides for `local/running-only/stopped-billed/unknown`; omitted entries use
those binding defaults, with wake false for the Until-delete categories unless explicitly chosen. Resolution: explicit
per-machine override in 50 → explicit per-preset override in 51 → user category preference → D21 category default.
Snapshot the resolved creation policy on 50's row; later global/preset edits affect future choices, not existing
machines. Native expiry remains a separate disclosed ceiling. Finite runtimes that cannot stop-and-keep use 51's
single control **Ends after 1 h unused**, showing the reviewed end effect and native expiry; Modal and Docker Sandboxes
need no further sign-off. Never label deletion retained Stop or promise same-resource wake after expiry/deletion.
Disclose unavailable wake before acquisition; durable routes retain Stop after 1 h unused and supported same-resource
wake. No silent native lifetime extension or replacement compute.

The sole resolver first chooses the billing-category policy, then qualifies the native capability: a finite no-keep
route resolves the one-hour unused end to `RetentionV1`'s existing delete/end effect, shown and reviewed as Ends. It
never advertises retained wake after destruction; the receipt carries that actual resolved policy. D23's explicit
Stop still refuses where Stop is unsupported, rather than silently becoming Delete.

**D23 — existing Automation binding (52 owns idle/effect admission):** configure existing `sessionArchived` lifecycle or
durable run-terminal trigger at the Automation CRUD/trigger owner after actual Session/run and created Machine
admission. Stop invokes `machines.managed.power.set`; Delete invokes canonical `machines.managed.delete`, consuming
their §6 `after-idle` mode and fire-time approval. Pin the trigger's executing Machine/installation to the resource's
controller, never the managed guest: a scope-end workflow running on the guest would itself prevent positive idle.
Keep leaves no scope-end binding and clears an existing selected binding through the incumbent Automation CRUD owner; it never means a new
Until-delete policy. Scope/binding lives at the existing trigger, not a managed-row field, archive watcher or extra
reconciler. Process-local finite Action operations are not durable run IDs: no persistable task-finished binding without
a demonstrated canonical durable-run owner extension. Selection affects only the newly created resource, never all Bots
or an existing Machine. 52's one inventory/drain waits visibly on busy/unknown, then rechecks current
trigger/actor/policy/resource; unarchive/clear before dispatch retires pending trigger through its owner. Submitted
native effects stay observed. No scope job/table/timer/lifecycle feed.

**Optional creation binding (52s2, consumed by 51s3/60s2):** offer Keep / Stop / Delete, default Keep (D42). Keep
writes no trigger. For selected supported Stop/Delete, after current enrollment and ordinary Session/run acceptance,
use `packages/protocol/src/workflows/triggers/workflowTriggerActionsV1.ts#SessionTriggerAddRequestV1Schema` and
`session.trigger.add`/`workflow.trigger.add` with the inline canonical power/delete Action in after-idle mode. The
selected unused interval reuses RetentionV1, not an automatic archive default. Pin execution to the controller through
FIN’s trigger owner; a later controller Move updates that execution context there. Canceled/replaced creation cannot
write; failed/unknown selected binding stays visibly incomplete and is repaired at the same owner. Voice consumes it.

**Stored category preference:** register the small fixed-category schema/definition once in canonical Account settings;
read it via createStoredReadSchema while strict settings.set/row/retention request envelopes remain closed. Plain
Account stays keyless, E2EE preference sealing remains incumbent settings transport, and mode mismatch is typed refusal.
Resource/session/run IDs, recency and activity never enter this preference. Finite-command wake retains 21/31’s current cancellable Action operation across wake, then dispatches once; durable workflow wake consumes FIN's committed assigned delivery
and existing guest claim. Both dispatch only content-free managed target intent; no message queue or retry/acquisition
owner is invented. Unsupported same-resource native resume remains typed unavailable before any
replacement.

**Reader/input classification:** Persisted/stored: 50's managed
intent/revision/RetentionV1/wake/ValidatedProviderObservation/expiry/cleanup row fields and existing retained pending
activation/wake target records. Input/wire/event: ManagedIntentInput, ManagedIntentResult, ManagedWakeTargetV1 at invocation/report; LiveWorkCategoryV1,
LiveWorkItemV1, LiveWorkInventoryV1 and ActivityDecisionV1 are transient host-internal contracts; provider
reports/events remain strict.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

Consume 50's tolerant stored-reader/canonical-writer `ManagedMachineV1`, `RetentionV1`, `SupportedNativeIntent`, current
revision and safe native observation schema; no second model. Proposed additions at **NEW**
`packages/protocol/src/machines/managed/managedIntentV1.ts` contain only transported intent/result/decision schemas. Inventory/item/attribution types stay at the daemon owner, with existing qualified
Home/Account/Machine/installation/Session/request and Action reference carriers selected from their canonical schemas.

```ts
// Internal types live at daemon/lifecycle/managedActivity.ts, not Protocol exports, a public ABI or a persisted store.
type LiveWorkCategoryV1 = 'session' | 'finite' | 'terminal' | 'service'
  | 'transfer' | 'handoff' | 'sync' | 'setup' | 'input' | 'execution_run' | 'workflow_run';
type LiveWorkItemV1 = Readonly<{
  category: LiveWorkCategoryV1;
  ownerRef: ExistingProcessOrOperationReference;
  attribution: RequesterWorkAttributionV1 | { kind: 'unknown' };
  state: 'active' | 'settled' | 'unknown';
  associatedTerminal?: ExistingTerminalReference;
}>;
type LiveWorkInventoryV1 = Readonly<{
  items: readonly LiveWorkItemV1[];
  coverage: 'complete' | 'unknown';
  idleSince?: number; // present only when all applicable producers prove settled
}>;
```

Only the following decision projection is transported, with its strict schema at managedIntentV1.ts; internal owner references/items stay private.

```ts
type ActivityDecisionV1 =
  | { kind: 'busy'; reasons: readonly ExistingSafeActivityReason[] }
  | { kind: 'unknown'; reasons: readonly ExistingSafeActivityReason[] }
  | { kind: 'idle'; since: number };
// Extend 50's sole observation schema in place; reuse this exact canonical name.
type ValidatedProviderObservation = Readonly<{
  observedAt: number;
  existence: 'present' | 'absent' | 'unknown';
  power: 'running' | 'stopped' | 'suspended' | 'unknown';
  storage: 'retained' | 'lost' | 'unknown';
  daemon: 'connected' | 'disconnected' | 'unknown';
  billing: ValidatedBillingCapabilities;
  nativeExpiry?: ValidatedProviderExpiryFact;
  nativeOperation?: ValidatedNativeOperationReference;
}>;
type ManagedIntentInput = Readonly<{
  homeId: HomeId; managedId: string;
}> & (
  | Readonly<{ when: 'now'; expectedRevision: number; intent: SupportedNativeIntent }>
  | Readonly<{ when: 'after-idle'; intent: 'stop' | 'delete';
      afterMs?: Extract<RetentionV1, { kind: 'unused' }>['afterMs'] }>
);
type ManagedIntentResult =
  | { kind: 'accepted'; managedId: string; intentRevision: number;
      operation: ExistingActionOperationReference }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'refused'; code: ManagedRefusalCode };
type ManagedWakeTargetV1 = Readonly<{
  managedId: string; enrolledMachineId: string;
  controller: ExistingQualifiedMachineInstallation;
  origin: // matching existing qualified carrier from trusted initiator, never a body actor
    | { kind: 'session-input'; session: ExistingQualifiedSessionAddress; pendingRequestId: ExistingPendingRequestId }
    | { kind: 'finite-command'; actionRequestId: string } // admitted request before guest operation exists
    | { kind: 'workflow-assignment'; runId: ExistingDurableWorkflowRunId; assignment: ExistingWorkflowAssignmentReference }
    | { kind: 'context-delivery'; session: ExistingQualifiedSessionAddress;
        delivery: ExistingCommittedWorkflowStepInputReference };
  reason: 'admitted-work';
}>;
```

The observation example extends 50's chosen `ValidatedProviderObservation` schema **in place**, not a competing
observation parser. Internal owner/process/operation/terminal references reuse their actual registry record types at
implementation; `RequesterWorkAttributionV1` comes from 42s2. They never cross the public summary or plugin seam.
Providers may refine kind-specific facts (unsupported power/native expiry/owned volume) through declared strict schemas,
not pretend universal retention support. Power/storage/connectivity/billing are independent; `nativeExpiry` cannot be
manufactured from an offline daemon. ExistingSafeActivityReason denotes the minimal nonsecret reason projection selected at that transported owner, not a new registry. Reasons are not Session ids/content/names; privacy projection is
admitted separately from internal activity.

Persistence remains only 50 row's desired intent/revision/retention/wake/current observation/cleanup and existing
pending activation fields. Record selected deadline/unused policy; no durable per-stage bootstrap journal, native
polling table, wake job or copied message. Existing authenticated request correlation/idempotency and intent
revision/CAS protect currentness; no generation/lease/claim added by default. Submitted native request can outlive a
revision and must reconcile by exact native identity, not be waved away as stale.

Implementation placement: **NEW** `apps/cli/src/machines/managed/managedIntentReconciler.ts` consumes native family/50
row transport; **NEW** `apps/cli/src/daemon/lifecycle/managedActivity.ts#readLiveWorkInventory` composes actual owners
once. `ActivityDecisionV1` and 42s3's privacy-filtered summary consume this same read. **NEW**
`apps/cli/src/daemon/lifecycle/admissionDrain.ts` is first extracted/refined by **31s1 in W2** from `startDaemon.ts`'s
quiescence consumers and shutdown hook; **52s1 in W3** extends that exact owner, never creates a replacement drain. Its
reason-specific decisions retain existing handoff/final-shutdown semantics while temporary drain leaves needed
producers/publications and awaiting plugin decisions alive; no second quiescence registry. Keep ordinary runtime core
turn/Session authority untouched. Existing daemon transport/Action front door carries authenticated exact installation
and current request, not a body-declared actor. Add managed target to the **existing** pending activation authorization
carrier/ingress; if signed actor carrier is already sufficient consume it, otherwise extend only required non-content
target fields at its owner with 42. No new public power endpoint bypasses MachineAdmission/approval.

Inventory comes from: admitted turn/pending input/startup custody; C31 queue/reservation from accepted through
preparation/setup/copy/run/cancel-pending/real exit; B22 running/starting/stopping services on C32 actual worker; D41
retained PTY/control custody; existing transfer/handoff/Sync setup owners. Entries include their category, authenticated
requester attribution (or explicit unknown), actual owner reference, active/settled/unknown state and real operation↔PTY
association; a linked finite PTY is attributed once. This is a read composition over incumbent lifecycle state, not a
second liveness or attribution writer. An installed but unavailable material producer makes observation unknown. A
settled producer's idle transition supplies `since` at the daemon lifecycle; no heartbeat-derived idle history table.
Aggregate idle begins when all applicable producers are positively settled. 42s3 filters this same inventory to
Session/finite/standalone-terminal counts and strips internal refs/content; it cannot enumerate registries again. Its
absent categories are not proof of idle. Producer unknown/settled transition and associated PTY dedupe are tested once
here and through both real consumers. Absent domain producer is inapplicable only when its real capability/lifecycle
owner establishes absence, not because a read failed.

Execution-run inventory consumes `daemon/executionRunRegistry.ts` with the real start/budget owner
`daemon/executionBudget/ExecutionBudgetRegistry.ts#tryAcquireExecutionRun`. Workflow inventory consumes
`daemon/automation/automationWorker.ts#startAutomationWorker` (`activeExecutions` and `claimClient.claimRun`) and
`daemon/workflows/coordinator.ts` in-flight leaves. `daemon/workflows/worker.ts` supplies claim types only, not the
claim loop. Accepted/queued/preparing/held material work blocks idle; a parked run whose real owner released all
material work does not. Missing coverage is unknown. 42s3 maps attributed script/execution/workflow work to its
existing numeric active-work column with dedupe, using 42's aggregate “active” label and canonical breakdown words.
Active trigger occurrences are those same workflow/execution owners, not another registry/category; future bindings alone are not live work.

Retention timer: reconcile on current policy/activity/native operation/controller reconnect; arm one nearest
**selected** user deadline in the resource owner. Until I delete it arms none. No global poller/default timeout/cadence/retry
budget. On daemon reconnect/restart inspect exact resource and recompute elapsed selected policy; stale/missing guest
activity blocks unused stop, while reviewed deadline remains explicit interrupting intent. Native async observation uses
only the provider's characterized operation contract/existing lifecycle budgets.

Server mutations use 50's row admission/Tx/afterTx; no native effects in Tx. Only necessary fields are migrated through
canonical multi-provider Prisma schema/deploy and retained-db reconciliation. Withdrawal's existing pending
state/version remains source of truth. Public get/inspect reads safe derived activity/stage, not internal prompt/key/PTY
bytes.

**D20/D24 administration:** consume [41 §5](41-machine-sharing-and-project-terminals.md#5-contracts-persistence-routes-and-events).

### Current policy and owner decisions

- **RT-D1 — SETTLED — 52's existing erasure/dependency owners and D19/D20 (central here):** emergency credential revoke is unconditional. Ordinary
  erasure/removal preflight presents exact retained resources/cost and explicit cleanup or manual-responsibility disposition. No indefinite Account hostage and
  no escrow. 52s3 pins actual surviving Home/Account dependencies and minimum nonsecret recovery view; consumers reference this settled contract rather than
  inventing their own removal policy.
- Consume 50 **MR-D1** metadata census/minimum visibility, **MR-D2** acquisition setting and **MR-D3** no new acquisition/handoff topology; 51 **MP-D1/MP-D2**
  optional cap/audience. D19 access loss follows 41/42: deny fresh inputs/reads/streams and cancel that actor's Session/finite/queued/preparing/PTY/service work
  through incumbent owners; a remaining valid grant cancels nothing. Resource retention does not become a second cancellation owner.
- **D21 — Retention defaults:** §5 owns descriptor billing categories, fixed local/running-only one-hour Stop + wake defaults, stopped-billed/unknown Until I
  delete it, small per-category Account preference and preset/machine overrides. No pending retention-default decision remains. Native support/expiry
  qualification is empirical and never a provider-ID default.
- **SETTLED — D21 wake resolution owner:** resolved local/running-only default enables wake on next accepted message/run; stopped-billed/unknown defaults
  leave wake off unless selected. Legacy row without a wake fact never fabricates authorization; creation/live policy writes establish the reviewed resolved
  policy.

## 6. Actions, approval and parity

**D21/D23 Action parity:** existing settings.list/get/set use declared category preference anchors and canonical
mutation/approval. machines.managed.retention.update changes only live retention/wake at plan 50's sole row owner. Configure
triggers through existing Automation CRUD/trigger Actions; if a reached UI operation lacks an Action, extend that same
typed domain owner. Trigger dispatch invokes machines.managed.power.set or machines.managed.delete with current
approval as specified below. No retention.settings/scope-power alias or direct settings patch.

`power.set` and `delete` have `when: 'now' | 'after-idle'` at the one intent owner. `now` keeps expected-revision
admission and the immediate effect, and rejects `afterMs`. `after-idle` optionally carries the existing unused-retention duration as selected `afterMs`,
admits the exact resource's current revision at fire time, then persists desired effect/timing/interval on 50's row through the same CAS.
Never capture a future revision at creation. Without `afterMs`, only positive idle is required; a selected interval uses that same idle/deadline owner.
The trigger's authenticated FIN Action context supplies actor/custody; a caller cannot self-declare a trigger grant.
The leaf settles at accepted intent, not after guest idle; its controller run therefore does not hold guest work.

**Fire-time approval:** the receipt reviews the future rule but does not pre-approve its later power/delete effect.
Current Actions policy governs dispatch; Ask first enters FIN's existing `waiting_for_approval`/Inbox hold. An
explicitly allowed policy may proceed, still under current grant/resource/trigger checks. No approval bypass or new
grant store. After consent, busy/unknown remains Waiting for work to finish; clearing/unarchive/revoke before native
dispatch retires the pending effect. Task-finished controls require a real durable run that created this Machine.

Approval and eligible surface parity consume the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog); native role admission consumes 50 §6.

| Action | Input → output | Effect / default |
| --- | --- | --- |
| NEW `machines.managed.power.set` | exact id + supported intent; `now` requires expected revision; `after-idle` permits Stop only, optional selected unused `afterMs`, current fire-time revision → intent/operation/refusal | Native effect/Ask; same idle/deadline owner; no substitute or acquire |
| NEW `machines.managed.retention.update` | id/expected revision + 50 RetentionV1/wake live override → current policy/revision/deadline projection | Title: Change when a machine stops; potential interruption/cost/Ask; Keep machine/Keep running select Until I delete it, no new id |
| NEW `machines.managed.delete` | exact id + reviewed dependencies; `now` requires expected revision; `after-idle` carries optional selected unused `afterMs` and current fire-time revision → intent/cleanup observation | Destructive/Ask; positive idle plus selected interval; End now uses `now` |
| NEW `machines.managed.controller.update` | id/expected revision + qualified own target installation → updated same-row future custody with pending-effect disclosure, or actual credential/local unsupported refusal | Authority/effect/Ask; cloud same credential, no copy/failover |
| NEW `machines.managed.retire` | id/expected revision + reviewed archive/manual responsibility → archived live-list disposition | Mutation/Ask; retain history/recovery/possible cost; unknown resources still count toward optional cap |
| `machines.managed.rebuild` (25 owner) | exact Devcontainer id/revision/reviewed native config → closed same-resource operation | Destructive/Ask; not Start-as-rebuild or E native Docker fork |
| Existing `session.message.send` / normal accepted pending input | ordinary current Session input → canonical accepted pending result | Existing policy; selected wake authorization separately bounds power |
| NEW narrow `session.pending.withdraw` at pending owner | exact Session address/request id/current authentication → existing pending mutation result or delivery conflict | Mutation/Ask; no fake deletion of consumed input; expose through current Session catalog |
| Existing normal Session resume/spawn/stop | unchanged admitted Session target → same Session/runtime outcome | Existing owner/policy; 42 requester custody consumed |
| Existing plugin/connection/secret revoke/remove and Account erasure front door | current owner dependency preflight + selected exact disposition → typed result | Dangerous/Ask for ordinary mutation; emergency credential revoke unaffected |

51/52 distinguish drain reasons at the incumbent owner: a user worker toggle returns `not_accepting` with 30/31's worker
copy; temporary unused-stop returns `draining` with `managedRetention.draining`. Clearing the unused-stop cause does not
clear an independent user refusal, handoff or final-shutdown cause; those lifecycle policies retain their own
publications and effect scope.

The current catalog contains pending next/reorder/interrupt operations but the inspected Action ids/specs do not expose
exact pending deletion/withdrawal. Add only its semantic adapter to `pendingMessageService.deletePendingMessage` and
existing activation reconciliation. UI entry is `SessionView.tsx#handleEditPendingMessage`'s existing qualified pending
composer document/edit owner, with `PendingMessagesTranscriptBlock`'s
`sync.deletePendingMessage`/`sync.discardPendingMessage` removal paths; preserve their structured mentions/attachments,
drain hold and Account/Home currentness. Refine this same owner for confirmed move-back, rather than create a wake-only
draft copier; do not introduce E message text persistence. Existing deletion returns success for already absent rows, so
the Action/UI must derive delivery/removability from actual owner status/custody rather than mislabeling that idempotent
response “restored draft”. No second authority guesses consumed from UI bubble animation.

Explicitly selecting wake policy reviews its supported Start/cost effect and authorization; a later deterministic
accepted-input wake uses that admitted policy, rechecks current grants/intent/credential, and never fabricates a human
decision. If current policy requires a fresh power approval, show pending approval and leave input queued; do not bypass
it. Retries of the same admitted intent retain its authorization only while current scope remains valid. Changed
target/effect requires new approval. UI command views/sheets use 71 answering client; headless reads/intent APIs work
without UI, pure local presentation has no fictitious CLI callback; concrete app navigation needs an answering client.

The 51 creation receipt reviews the resolved D21 policy, including default wake and any selected D23 Stop/Delete scope
effect, through this same admission/approval owner; inherited defaults are not an authorization bypass. Archive state
comes from `apps/server/sources/app/session/archive/transitionSessionArchiveStateInTx.ts` and its incumbent
publication/Session reader, not a Bot flag or consumer-owned archive event. Consume those actual acknowledged facts
through existing transport; do not add another archive writer or lifecycle automation store.

## 7. Plugin extensibility and closed host authority

Use 50s1 `machineProvisioners` descriptor/native roles, standard `definePlugin` → catalog/projection → `activate(api)`
declared registration/currentness. Provider optional-power and destroy return strict supported native outcome/operation
ref/unknown; never mutate host desired policy, queue a message, mint requester credentials or claim a Session resumed.
Native facts require actual versioned success/fail/cancel/recovery evidence from each 53–56 leaf; unsupported is
first-class.

Reuse managedDependencies/Exec/private credential-file and existing process lifetime/native IO seam. No plugin-owned
retention service or general register-machine-runtime API. Public UI consumes shared `Step`, `Status`,
`State`/freshness, `Overlay`, `Item`/`ItemGroup`, `Form` inputs and normal `executeAction`; public-author fixture uses
supported power Action/result and missing/unknown recovery. Raw activity producers/drain/turn controls/Account
keys/bearers/pending content remain closed. Computer/capture/Voice variations are F consumers of ordinary enrolled
Machine, not resource-provider viewers.

## 8. UI composition and motion

```text
50 pre-enrollment ManagedMachineDetail OR incumbent enrolled MachineDetailScreen
  51 same receipt/current work + 41 Sharing + 42 owner counts + 30 worker policy
  ItemGroup: live Keep / wake Toggle / exact controller
  Overlay: reviewed policy, supported power, delete dependencies, controller Move
  State + FreshnessLine: unknown/offline/refused/missing/cleanup
ordinary Session/composer/pending list
  existing pending bubble and input custody
  50s3 managed-progress AgentInputStatusBadge + observed-stages popover
    waiting → starting → connecting → resuming
  Avatar/roster/Machine detail consume same observation, not own lifecycle
  withdraw Action → actual pending result → current composer draft recovery
```

Shared progress derives from resource/pending/runtime observations; no fake percent. Activity/elapsed label is
informational and cannot advance stages. Use existing `motionTokens.inPlaceMorph` for badge/popover disclosure, standard
status/presence/motion owner for Avatar, Overlay tokens for phone sheet. Lab 1400/4200/5600/7000ms timers are rejected;
ordinary existing tokens govern visual transitions only. Reduced motion immediately/crossfade reflects the same fact;
interrupted transitions retain last observed state, not replay acquisition on click. Restore focus on dismissed
sheets/badge action; stages announced politely when changed, not every elapsed tick. Shared row metrics remain 52/40 and
section 28 through public page owner; no global lab 56/48/30 replacement. Keep input/voice/watch target stable; Talk
neither wakes nor selects a different Session to make wake succeed.

## 9. Lifecycle, cancellation and recovery algorithms

**D23 lifecycle consumer:** consume existing Automation binding/currentness and canonical stop/delete Action path in §5;
no second scope observer, field or idle decision.

**Intent admission:** exact actor/Home/managed id/revision/current grant/controller installation/current credential and
native support → same 50 row intent revision + operation → sole controller's existing authenticated transport. Serialize
only per resource in the owning daemon; existing daemon single-instance/custody applies. Before native dispatch recheck
current row/effect/admission. A stale undispatched intent is retired; a submitted native effect is observed and
reconciled even when policy changed. No claim can unsend native HTTP/CLI work.

`after-idle` uses §6's fire-time current revision and approval rule; only the accepted row effect/timing/selected interval is retained.
Busy/unknown or an unelapsed selected interval waits; fresh guest idle/drain confirmation decides dispatch, not the controller workflow's completion.

**Unused policy:** while positive busy or unknown, do not stop/delete for inactivity. When positively idle for selected
duration, close fresh admission at actual spawn/input/finite/service/PTY, execution-run start and workflow claim/start
boundaries via shared reversible drain;
allow already accepted work to settle. Re-read policy/revision/native identity and all applicable activity immediately
before stop/delete. Work already admitted/new accepted pending that wins current custody cancels unused stop; reopen
admission and recompute. Calls arriving during drain return existing truthful draining/pending result without dropping
accepted work; no hidden rerun. Cancellation/policy edit/native refusal reopens drain when safe, without disposing
registry or deleting pending custody. Native Stop begun cannot be reversed by clearing a Boolean; report stop-pending,
inspect to settlement, then admitted same-resource Start if current intent requires it. Unknown native stop does not
prove idle/absence or justify a replacement.

**Explicit deadline:** UI reviews exact time/effect and interrupts=true. Deadline does not inherit unused activity
guard; it may stop/delete while busy under its admitted effect. Preserve/report accepted input/delivery uncertainty
through normal owners. Changing/removing deadline before dispatch suppresses old effect; afterward reconcile submitted
outcome. Vendor TTL is independent and may expire despite busy; make known expiry visible. D21 selects one hour only for
unused local/running-only policy; no interrupting deadline is selected by default, and no generic shorter cutoff
competes with underlying operations.

**Wake:** validate actual admitted initiator intent at its existing owner before stopped-guest acceptance, ordinary
current requester Session input right, selected wake policy, current managed power right and exact target. Pending
activation authorization contains only allowed controller target/reason—not prompt bytes, key, Artifact or custodian
Session settings. 42s2 supplies requester subscription, refresh/switch, Team direct/brokered and billing-subject
custody through reconnect/resume; the same selected subject resumes after wake. Its conditional fallback is not new E
guest enrollment authority. Controller offline preserves actual pending row; on reconnect existing recovery inspects
native same id. Start only supported retained present resource; after actual native running+normal daemon connectivity
call ordinary `ensure_pending_consumer`/inactive recovery. Preserve ordinary Session id/native thread and directory; no
promise of preserved RAM/PID. Native absence/storage loss produces typed unavailable; ordinary explicit
new-compute/recovery choices need new approval.

**Withdraw:** exact pending owner authorizes/removes and reconciles activation in transaction before delivery fence. If
current request truly removed, restore original content to current requester draft using existing message/draft owner,
not controller disclosure. If consumed/fenced/uncertain return appropriate status and do not resend. Remove unused wake
authorization when no valid accepted request remains before native submission. Already started power remains a resource
policy issue, not implied destructive rollback. Later new message is a new ordinary request; no E receipt/dedupe store.

**Controller movement:** local remains unsupported; cloud target needs current same-credential access without
transferring material. Review pending native handles/unknown results and possible cost, then replace future dispatch
custody through 50’s row revision transaction (D42). Old undispatched work fails currentness. Already submitted native
effects remain observable by their exact handle/identity; Move cannot unsend them and must not replay them. No new
election/fencing/lease or automatic failover. Do not redeploy/re-enroll or create another Machine/Session.

**Delete/retire/dependencies:** delete reviews owned resource plus separately owned native disk/volume/claim disposition
supplied by strict leaf facts; native adapter deletes only exact admitted identities. Archive/hide is an explicit non-destructive list disposition even while existence/billing is uncertain (D42); retain
history, cleanup, native handles/recovery links and possible cost. Archive never proves absence or frees the optional
cap. Native Delete and confirmed absence remain separate facts. Do not confuse
Forget local metadata with destruction. Credential/plugin removal warns but cannot claim native cleanup; emergency
revoke remains unconditional. Normal erasure implements RT-D1 at existing Account/Team/Home dependency owner, not a
cleanup service that outlives it. Retained metadata access follows actual surviving Home ownership; if no surviving
authority exists, review explicit manual-responsibility and nonsecret native recovery facts **before** erasure rather
than creating escrow or secretly retaining deleted Account data.

## 10. Compatibility and predecessor basis

Current sibling HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`, inspected 2026-10-05 with targeted status/diff for CLI
auth/key/API Machine/server Prisma/SDK/catalog empty. Deep-E's older HEAD and remote-terminal enrollment paths are
stale: those modules are absent in current 0.2. Actual ordinary Machine key reader
`../0.2/apps/cli/src/api/client/encryptionKey.ts:35`, Prisma Machine/AccessKey and current normal pending carriers—not a
guessed managed lifecycle—supply prospective inputs. 40/42 own their released and predecessor key/AccessKey directions;
52 consumes them and preserves current Session/native id.

Read 0.2-created ordinary Session/pending/target/disk data through those canonical adapters. New power/wake targets
require producer+consumer negotiated support; older daemon cannot falsely accept a native Start/foreign requester route.
Degrade managed operation to typed unavailable while ordinary connection/read/Session flows continue. New strict
mutation/identity/authorization unions follow `docs/compatibility.md#sdk-protocol-evolution`; safe read projections may
omit optional new facts only when their actual released reader can ignore them. Unpublished 0.3 drain/managed draft
grammar refactors directly with all callers; no dual row, legacy wake queue, reverse-dev rollback or new
force-client-update floor. Recheck sibling and immutable deployed publication basis during 52s1/2 before relying on a
compatibility exception.

**52s2 / 52s3 focused UI and recovery checks:** extend `pendingSessionActivationRecovery.test.ts` / `activatePendingInactiveSession.test.ts` and the adjacent
NEW `managedWakeProjection.test.ts` for native Start confirmed + Agent start refused with the original input still queued; the distinct agentStartFailed state
appears and Retry rechecks that same Session/pending owner rather than allocating again. 52s3 extends the existing Machines settings navigation/body tests and
NEW `ManagedMachinePolicySection.test.tsx` for Defaults→Home-qualified page→Back and category Reset, co-landing NEW `app/(app)/settings/machines/defaults.tsx`
with the existing Machines settings declaration/search owner and shared body. Extend the existing `automationSessionLifecycle` / `automationRunLifecycle`
binding tests for Keep→no rule, Stop/Delete→rule, and rule→Keep→cleared with no native effect.

## 11. Ordered slices, tests and completion gates

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**D21/D23 deciding RED (52s1/s2/s3):** extend proposed `machines/managed/managedIntentReconciler.test.ts` plus Protocol
Account settings/declared settings Action suites. Defaults use billing facts for two different provider IDs, unknown
defaults Until I delete it; exactly59min59s positively idle does not stop, one hour eligible idle does, current
activity/unknown coverage blocks, and changing category preference/preset never rewrites an existing allocation. User
category/preset/machine precedence and reset are real canonical logic. Next accepted message/run wakes the same
retained resource under resolved reviewed policy; passive reads do not. Archive/actual finite finish arms only its
linked machine; active service/queued work or unknown coverage delays Stop/Delete; settlement then fresh idle dispatches
once through the existing intent owner. Unarchive/policy clear before dispatch cancels intent, different Session/task
and existing selected Machine remain untouched, unknown native result never marks gone/replays. Scope binding updates
existing Automation owner, not managed-row field or Account settings/history; category update deliberately uses the
canonical real preference/history owner. NEW `ManagedMachinePolicySection.test.tsx` checks actual creation scope
controls/visibility, pending wait, inherited/override controls and same Action approval. No tests claimed run here.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

**52s1 — Same-row intent and reversible real admission (RT-R1–R3/5).** Consumes 50s1/2 + actual 31/22/41 producer
interfaces. Provides native power/retention/controller algorithm, single live-work inventory to 42s3 and unused-stop
extension of 31s1's already-consumed W2 reversible drain. The inventory RED includes active service/transfer with zero
public Session/task/terminal counts (retention stays busy), unknown producer coverage (never idle), and
operation-associated PTY de-duplication; 42s3 separately proves the owner-or-current-Manage projection, never another
census. Drain RED clears retention while an independent user `not_accepting` cause remains and proves admission stays
refused until that cause clears. 52s1 is W3; 31s1 must not wait on this later slice or introduce an interim toggle
drain. Files: NEW Protocol `machines/managed/managedIntentV1.ts` for transported intent/result/decision only; internal inventory types at CLI `daemon/lifecycle/managedActivity.ts`; 50 row mutation/service and Action specs; NEW CLI
`machines/managed/managedIntentReconciler.ts`, `daemon/lifecycle/managedActivity.ts`, and EXTEND 31s1's
`daemon/lifecycle/admissionDrain.ts`; existing createBeforeShutdownDrain/startDaemon/provider input and concrete
31/22/41 effect admission hooks; native leaf roles through plan 50. RED: extend 31s1's `daemon/lifecycle/admissionDrain.test.ts`
with real in-process acceptance/producer logic + extend `createBeforeShutdownDrain.test.ts`—temporary drain
cancels/reopens then a new admitted effect actually executes, registry still usable; final shutdown disposes only at
final phase. NEW `machines/managed/managedIntentReconciler.test.ts`—queued/preparing finite work, running
service/retained PTY or unknown material producer prevents unused stop; selected explicit deadline may dispatch reviewed
effect; policy edit before dispatch prevents old stop; command acceptance/unknown native result never marks
stopped/absent; local Move/same-resource unsupported Start refused. Mock only native OS/network/clock/process boundary,
not activity aggregation/CAS/admission or internal services. GREEN exercise actual Action→row→controller→native leaf and
existing real producer events. Run focused+adjacent CLI finite/service/pending/drain suites; public CLI/Protocol/Server
typecheck/build; Stack/cli-common lanes if shared native IO changes; 50 DB contract if persisted shapes changed.
Complete with every real material effect boundary consuming one drain, no plugin disposal on temporary mode, unknown
fail-closed, no native shortcut or competing row. Interface prep/native adapter work can parallelize after 50 agreement;
active policy cannot precede producers.

**Actual producer and drain prerequisites:** extend one inventory at real `daemon/executionRunRegistry.ts`,
`daemon/executionBudget/ExecutionBudgetRegistry.ts#tryAcquireExecutionRun`,
`daemon/automation/automationWorker.ts#startAutomationWorker` (claim loop / `activeExecutions`) and coordinator owners
for execution runs/background work, accepted/queued/preparing
assignments, held worker/coordinator claims and in-flight leaves. A parked claim whose owner released all material work
is not inherently busy; missing producer coverage is unknown and blocks unused stop. Inventory adapters reuse owners,
not liveness DB/global poller; inactive retention creates no watcher.

Consume 31s1's proven `daemon/lifecycle/admissionDrain.ts` predicate and execution-run start/workflow claim/start wiring,
including its consolidation of startDaemon.ts/controlServer.ts isDaemonQuiescing decisions. 52s1 adds only the unused-stop cause,
the complete activity inventory and guest/controller observation. Handoff/final shutdown and reversible unused-stop
retain distinct semantics. RED: zero public Sessions/task/PTYS but active execution-run/workflow claim blocks stop; real
start/claim during drain refuses/pending; canceled drain admits again; released parked work no longer busy; unknown
coverage never zero. 42s3 maps attributed finite/execution/workflow work to the `tasks` numeric active-work column with
dedupe, never a second census or a scripts-only interpretation.

**Consumed seams:** `startAutomationWorker` / claimed coordinator work — FIN finalization
`02-execution-results-and-recovery.md` §§4.1/6 coordinator/claim ownership and
`06-human-review-and-draft-results.md` §6.3 park/wake; material holds count until actually released/settled,
while parked/released work is not busy. INT PLAN §3 execution/status rows retain the canonical glossary/projection.
31s1 owns `admissionDrain.ts` and its execution-start/claim call sites; 52s1 consumes that wiring and adds its unused-stop cause,
inventory and guest/controller observation without restructuring their loops or adding a competing quiescence check.

**Guest/controller observation bridge (52s1):**

At `apps/cli/src/api/apiMachine.ts` and `api/machine/rpcHandlers.ts`, extend the existing registered/signed Machine RPC
transport with proposed private `managed.activity.read` and `managed.admission.drain.confirm` payloads under the one
`machines/managed/managedIntentV1.ts` schema owner. The first returns the guest's content-free current decision; the
second routes reversible drain and fresh idle confirmation to 31/52's actual admission/inventory owner. These responses
are the guest→controller observation bridge, not an invented daemon-state idle Boolean. Controller dispatch uses the
current managed intent and exact guest/controller installation through 41 admission; no caller-supplied actor or public
raw-RPC power shortcut. Extend real ApiMachine registration/transport and managed reconciler integration tests for
work-arrives-after-read, revoked access, changed policy/controller and reopen-on-refusal before native dispatch.

Controller reads at selected deadline/policy evaluation. Publish actual busy→idle/unknown→known decision edges
through the existing Machine update/RPC transport so a waiting selected policy re-arms; no global scanner. Return
canonical idleSince; unknown/offline cannot establish idle. Fresh drain confirmation immediately precedes native effect.
The real bridge test starts busy, settles work, observes the edge and dispatches only after the selected idle interval.

**52s2 — Accepted pending-input wake and truthful withdrawal (RT-R4).** Consumes 52s1 + 50 row/resource + 42s1/2 principal/current grant + real pending owners.

Provides same-resource/same-Session resume with non-content controller
target and canonical withdraw Action/draft recovery. Files:
pendingActivationAuthorization/pendingMessageService/transport carrier; CLI
pendingSessionActivationRecovery/activatePendingInactiveSession + reconciler; UI pendingQueueWake/sessions.ts, existing
`shell/SessionView.tsx#handleEditPendingMessage`/pending document owner and `pending/PendingMessagesTranscriptBlock.tsx`
qualified delete/discard paths; Protocol Actions and generated DTOs, 51 composer progress. RED: extend server
`pendingActivationAuthorization.spec.ts` and `pendingMutationAuthority.sqlite.integration.spec.ts` with real
access/DB—only actual admitted matching requester input/finite/workflow/context intent + current managed power policy
arms exact controller; revoked actor/passive read cannot; remove before fence retires authorization, delivered/fenced
cannot restore/resend. Extend CLI
`pendingSessionActivationRecovery.test.ts`/`activatePendingInactiveSession.test.ts`—offline→native present Start→normal
reconnect resumes same Session/native id, missing storage/resource never acquires/spawns replacement; wrong installation
rejected; prompt/key absent from controller carrier. UI `pendingQueueWake.test.ts`, existing
`PendingMessagesTranscriptBlock.test.tsx`/`PendingMessagesTranscriptBlock.exactHomeAuthorship.test.tsx` and NEW adjacent
`managedWakeProjection.test.ts` exercise the real pending edit/removal owner: pin/Watch/Talk/inspect do not create power
intent, confirmed withdrawal preserves original display text/mentions/attachments in the current draft, changed
Account/Home or fenced delivery cannot restore/resend, and existing draft is not overwritten after context retirement.
Real internal logic, mock only DB where its harness requires or real integration DB, native
network/process/clock/platform boundaries. GREEN actual pending→signed ingress→native Start→daemon→same runtime/delivery
and headless withdraw through exact owner. Run server pending/access/foreign-requester integrations, CLI pending/native
intent, UI pending/composer suites; public Server/CLI/Protocol/UI typecheck/build for coherent batch. Complete with no
second queue/scheduler/custodian credential substitution, same native id and actual delivery deciding evidence, all
UI/CLI/Agent/MCP/Voice eligible handlers real.

**Pre-guest wake and observation bridge:** admit Session input, finite command, workflow assignment or persisted
server-visible delivery at its canonical initiator **before** stopped guest acceptance. ORC WorkerUpdate is built in
the lead's runtime and cannot wake that stopped runtime. Derive
requester/origin comes from ORC/FIN custody, not a user-only body or passive read. Finite commands keep the live
admitted Action operation pending across wake; after actual Running, recheck actor/target and enter 21/31 FIFO once.
Cancellation retires undispatched work; process loss or unknown delivery exposes recovery without automatic replay. Workflow retains real durable
run/assignment; context refers to FIN's committed input/delivery fact, not a fabricated WorkerUpdate row.
Matching origin arms selected exact resource/policy/controller,
then original owners resume same work.

Extend existing authenticated Machine RPC/update/Action carriers with strictly content-free guest→controller
ActivityDecision observation and reversible drain/confirm-idle request/response.52s1 remains sole inventory/drain
decision; controller cannot infer idle from disconnection/public counts. Before native effect recheck exact controller
installation, row/revision/policy/native id and current guest decision; stale/unknown/offline refuses or waits.
Refusal/cancellation/policy edit reopens existing drain; no poller lease/new authorization owner. RED traverses actual
controller read→guest response→drain→fresh confirmation, injects work/policy/controller change and prevents stop
without current confirmed idle. Wake RED starts offline finite/workflow/context intent without guest acceptance, proves
native awake **and actual same runtime work delivered/resumed**. Launch failure clears Waiting with truthful retry;
unknown delivery never blindly resends.

**Server arming producers (52s2):** extend
`apps/server/sources/app/automations/automationRunAdmissionService.ts#admitAutomationRunTx` / `admitAutomationRunsTx`
at the queued-run/assignment commit and its existing `afterTx` Machine publication. Extend
`apps/server/sources/app/workflows/workflowRunService.ts#completeWorkflowInvocationReview` and
`resumeWorkflowRunBoundary` at parked/paused→queued transitions, and `automationRunService.ts`'s retry→queued
transition. `automationClaimService.ts#runAssignmentClaimWhere` remains the assigned guest's pull authority; the
server routes a content-free target to the exact managed controller, never asks the stopped guest to originate wake.
Reuse 50's Home-qualified row/current-controller resolution and existing authenticated pending-activation/AccountChange
carrier; no durable wake job or copied input. Cancellation/revoke/unassignment suppresses stale dispatch.

For origin-session delivery, extend `workflowRunService.ts#reconcileWorkflowRunAttentionAndHintTx` alongside its
existing `markAccountChangesForSessionAccounts` publication when a committed `workflow_step` input is deliverable
or a delivery-requested run becomes terminal. Attention-only hints stay non-waking. The private wake reference is
the real committed invocation/run revision + qualified origin Session; the runtime still pulls/acks through FIN's
delivery owner. `ExistingCommittedWorkflowStepInputReference` denotes that current row reference, not a new store.
Cross-machine deliveries already sent as pending messages use `session-input`; no ORC WorkerUpdate transport.

For finite commands, extend `apps/cli/src/daemon/actionOperations/actionOperationRunner.ts#createActionOperationRunner`’s
existing async execution/AbortSignal/progress lifetime. Controller receives the admitted request id before guest
acceptance. Keep that operation pending through wake, then dispatch once under fresh guest admission/actor/target.
If a specific transport cannot retain this lifetime, characterize that route and report its explicit recovery; do not
impose universal re-invocation. No durable finite queue, restart replay or forged pre-acceptance guest operation.
RED at the real 21/31 Action boundary invokes Run once on a stopped guest and observes actual same-resource execution;
cancel during wake dispatches nothing, and unknown post-issue delivery is never resent.

**Consumed seams:** FIN finalization `03-account-actions-library-and-live-state.md` §§5.3/6.5 (inline trigger and
server-visible pull delivery), `06-human-review-and-draft-results.md` §6.3 (parked run wake), ORC PLAN §3.2 /
INT PLAN §3 context-slot row (host context remains runtime-derived). Controller wake carries no content/new authority.

**Origin RED:** extend `automationRunQueueService.test.ts`, `automationRunService.integration.spec.ts` and the
existing workflow-run review/delivery integration suite at the real committed owners: queued/retried/resumed parked
assignment on a stopped guest routes wake to its controller; committed deliverable input/terminal origin delivery
does likewise, while attention-only/pure WorkerUpdate/passive hints do not. Wrong assignment, revoked requester or
changed controller cannot wake; original claim/input is consumed only by its real owner after reconnect.

**Post-wake RED:** extend `activatePendingInactiveSession.test.ts`, `pendingSessionActivationRecovery.test.ts` and
`api/session/pendingActivationTransport.test.ts` if present, otherwise its adjacent boundary suite. Native Start and
daemon connection succeed, but Agent/auth/resume refusal flows through `activatePendingInactiveSession` and
`reportPendingSessionActivationFailure`: Waiting ends with truthful failure/Inbox state; the original pending input
is kept, never called delivered. Separately, spawn ACK followed by turn-not-accepted does not settle pending delivery;
the existing turn/pending owner reports definite failure or unknown. Retry observes the same Session/pending
authorization before an effect; no repurchase, new native identity or blind input replay.

**Durable trigger slice:**

Use `session.trigger.add/update/remove` and `workflow.trigger.add/update/remove` from the existing Action owner;
`workflows/triggers/workflowTriggerActionsV1.ts`, `automations/automationSessionLifecycle.ts` and
`automations/automationRunLifecycle.ts` own trigger binding and `runLifecycle` condition `terminal` for actual
execution_run/workflow_run sources. Reuse the existing inline Action target/FIN dispatch, no scope engine.
For finite Action operations consume 21/71's per-spec accepted-versus-settled completion/Wait observation; an accepted
response is not exit, cancellation request is not settled, and process-local handles are not durable trigger sources.

52s2 owns only the selected optional creation binding from §5 through FIN’s trigger mutation owner after real 50/51 continuation.
51s3/60s2 consume it once for ordinary Session/Bot creation; 62 never duplicates it. No ephemeral operation id. Canonical trigger/terminal integration RED
proves archive/finished cannot bypass busy/unknown, same-resource stop/delete waits then uses approved Action,
unarchive/clear/revoke before dispatch retires binding, unrelated/existing Machine untouched. No new scope
watcher/store.

Extend the real Session-trigger mutation/creation suite with a reviewed new-machine preset: default Keep performs no trigger write; explicit Stop/Delete gives only the
admitted Session the controller-pinned after-idle rule and selected interval; Keep clears a selected existing rule, existing targets are untouched,
unsupported Stop refuses, canceled/replaced creation cannot write, and failed/unknown trigger write remains visibly incomplete.
At the same 52s1/52s2 idle boundary, active execution/workflow/trigger runs and retained holds block stop even with no Session/script/PTY;
released parked work does not. Selected interval not yet elapsed waits; elapsed but unknown/busy activity still waits, and a new run resets canonical idleSince.
Use the existing nearest-selected-deadline owner and real FIN trigger/Action dispatch; mock only DB/native/clock/network boundaries where the harness
requires them.

Trigger RED pins execution to the controller: the guest's last live run can settle before after-idle dispatch, and
the trigger run never appears in guest inventory. Receipt alone does not authorize dispatch: Ask first yields the
existing approval hold; allowed policy still rechecks grant/trigger/resource and busy/unknown. Clear/unarchive while
held or waiting prevents native effect. No creation-time expected revision is reused.

Power/wake presentation consumes INT `2026-09-29-unified-agent-work/PLAN.md` §5.3/I3 through `resolveWorkStatusTone`:
Asleep for retention-stopped/wakeable, Starting for observed wake, needs-you for definite failure, and Stopped/unknown per that table.
70s4 threads the same fact through workflow `machineReachable` presentation and Boards cards; 30 uses it in Run-on/Workflow target selection.
Extend the real wake/destination/run-presentation tests: stopped-but-wakeable never reads Offline, native Start alone never means run delivery,
and definite pre-execution failure uses §2's runFailed copy while pending/ambiguous execution retains its actual owner status.
50s3's badge/observed-stage popover is the composer projection; no separate wake strip or consumer timer.

**Consumed seams for 52s3:** `resolveWorkStatusTone` — INT PLAN §3 I3, one managed power/wake projection;
Inbox attention — ORC PLAN §3.2 / INT PLAN §3 Inbox row, definite launch failure never masquerades as Waiting.

**52s3 — Retained-resource controls, dependencies and erasure (RT-R2/5/6).** Consumes 52s1/2 + 50 detail + 51 receipt +
current Account/plugin/secret dependency owners. Provides power/Keep/controller/delete/retire/refused/unknown surfaces
and manual-responsibility preflight. Files: NEW UI
`components/settings/machines/managed/ManagedMachinePolicySection.tsx` alongside50/51, existing normal pending
status badge/phone sheet and locales; existing server accountDataErase and actual plugin/Connected Account/Saved Secret
remove/revoke preflight; generated specs/current UI execution. RED: extend `accountDataErase.sqlite.integration.spec.ts`
with real retained resource relations—unreachable cleanup is exposed before normal erase; explicit disposition does not
claim native deletion; emergency revoke not held for cleanup; no data retained outside allowed surviving owner. NEW
`managed/ManagedMachinePolicySection.test.tsx` with real Action/receipt policy—unknown stop/delete never claims gone or triggers replacement; reviewed archive hides only the row while retaining recovery/capacity; cloud Move during unknown effect changes only future custody with disclosure; refused local Move never looks executable; preset edit versus live policy stays separate;
Ask denial preserves source/draft. Boundary mocks network/native/OS only. GREEN one current preflight→approval→same
row/native result→ordinary erase pipeline, explicit recovery/cost and phone control surfaces. Run relevant
erase/dependency/managed/UI suites plus touched packages' public typecheck/build and current composed QA. Complete with
all consumers/eligible Actions and no hidden resource/escrow, cleanup accurate after plugin/credential removal.
Presentation prep may parallelize 52s2; erasure completion waits canonical result/policy, not a fake stub.

Extend 50's real row-mutation integration test for cloud Move during unknown submitted effect: new revision owns future
dispatch, old undispatched work refuses, retained native handle/unknown recovery survives and no allocation is replayed.
Archive/hide under reviewed manual responsibility retains authorized get/archived-list recovery and possible-resource
capacity; it does not claim absence. This owner test supplies mutation evidence to the policy UI test above.

**Settings, status and deletion preflight:** extend `components/settings/catalog/settingsPageDeclarations.ts`, existing
machines defineSettingsPage declaration/search catalog and `settings/shell/SettingRow.tsx` anchors. Declare four
category preference rows plus preset/live rows linked to their actual mutation owners; Settings holds preferences,
resource effects remain Actions. `components/work/status/resolveWorkStatusTone.ts` and existing
WorkStatus/StatusPillVariant own operation and managed power/wake projection, no raw-color/status matrix. Failed costly
install/unknown cleanup enters existing Inbox attention. Deletion preflight consumes canonical reference census for workflows/assignments/pools/profiles/Board targets;
show affected references and preserve normal missing-target outcomes. An explicitly approved Delete is not permanently
refused merely to protect user-owned references; never silently retarget them. RED proves Settings search→anchor→owner mutation, recovery status and reviewed dependency-bearing
delete through real internal logic.

52s1's required neighboring RED also extends `apps/cli/src/plugins/daemon/changeService.test.ts` with real pending
plugin decisions and existing native preparation boundary fixtures: temporary unused-stop drain must preserve awaiting
decisions and the observation publications needed for activity, canceled drain resumes valid admission, while actual
lock handoff still retires decisions through its existing owner. Exercise the actual `startDaemon` lifecycle composition
at its nearest testable owner, not a mocked `isDaemonQuiescing` return. This distinguishes one coherent reason-specific
admission owner from either a competing retention flag or reuse of destructive handoff quiescence.

Package checks route through public scripts/`./apps/stack/bin/hstack-exec`; never `*:local` or finite TypeScript
implementation tasks. Schema editors follow retained-db reconciliation from server/Stack AGENTS; planning does not
mutate DB. Each focused RED must fail for the missing contract, not mocked internal helper/fixture setup. Final
integration gate requires current source applicable checks, not registered-but-uninvoked code or a still-running
command.

**D20 proof:** consume 41’s canonical admission/credential non-disclosure suite. This slice adds only its discriminating managed mutation/credential-currentness cases; no repeated omnibus access matrix.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 52s1 | IMPLEMENTED (focused GREEN) | `71e10f8f39`, `92c476ae05`, `0cb95bb680`, `7ef13082ec`, `e9a3f844cf`, `f1bf5fbff7`, `53b3fb93f9` | [C52P](../../reviews/2026-10-02-lane12-replan/impl-C/C52P.md) supplies the pure resolver; [C52L](../../reviews/2026-10-02-lane12-replan/impl-C/C52L.md) and later [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) provide focused inventory/drain/reconciler GREEN, superseding the old transport-blocked pure-lane status. [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md)/[FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md) consume [CD12/CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) selected finite capability facts at the single policy owner. | Common gate; real guest→controller activity/drain bridge, all applicable busy/unknown producers and nearest selected policy deadline; measured cold/idle daemon behavior and supported cloud Move with pending native effects. | Native Stop/retained-disk/expiry and platform process behavior; vendor billing/storage, physical devices and signing. |
| 52s2 | IMPLEMENTED — open items | `0cb95bb680`, `646b36d73c`, `a3a7b70d11`, `e9a3f844cf`, `53b3fb93f9`, `1122a710fb` | [C52L](../../reviews/2026-10-02-lane12-replan/impl-C/C52L.md) records creation binding and pending wake source GREEN; [FX8](../../reviews/2026-10-02-lane12-replan/impl-C/FX8.md) removes the historical foreign finite-wake refusal with requester policy plus installed-controller custody; [FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) cover mounted wake/failure/retry/withdraw. [CD4/CD5](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) keep FIN bindings owner-only on shared controllers. | Common gate; accepted Session/finite/workflow/committed-delivery wake before stopped-guest acceptance, actual same-resource/Session work delivery, withdraw versus fenced/unknown, and controller-pinned FIN fire-time approval/idle settlement; C42 current requester custody checks remain open. | Actual native resume/expiry/storage and vendor billing-subject continuity; physical devices/platforms and signing. |
| 52s3 | IMPLEMENTED (focused GREEN) | `92c476ae05`, `8a9eec3d81`, `ee62fef68b`, `53b3fb93f9`, `422f7143ad`, `1122a710fb`, `327e8df613`, `68d2fb8f9a` | [C52L](../../reviews/2026-10-02-lane12-replan/impl-C/C52L.md), [FX4](../../reviews/2026-10-02-lane12-replan/impl-C/FX4.md), [FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md), [FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) and [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) record controls/removal/archived discovery/Defaults/current qualification GREEN. [CD9/CD11–CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) shape honest cleanup, deadlines and FIN detail. [FX17](../../reviews/2026-10-02-lane12-replan/impl-C/FX17.md) closes RVF-3/FX15's unloaded source gap: valid Keep/archived/other-Home RED → 3 UI suites/64 tests GREEN; unloaded Keep/Stop/Delete use addressed existing Session/FIN readers and the same FIN editor without publishing source Sessions locally. | Common gate; loaded addressed other-Home rule editor, archived reopen, unknown cleanup/Move/manual responsibility and erasure preflight live. No Account erase or retained DB reset is implied. | Exact vendor cleanup/billing and native controller/platform loss; physical controls/safe areas and signing. |

## 12. Live QA segment and release boundary

Append to umbrella's one composed existing-stack journey: record Home, current controller/guest installation, loaded
UI/daemon/native provider version; create/retain resource from 50/51 → Until I delete it (no timer) → select unused policy →
queue real finite preparation/service/PTY and show retained running → cancel/settle actual work → native stop observed →
passive inspect/pin/Watch/Talk (no Start) → explicit opt-in wake → accepted owner/shared requester message → offline
controller waiting → reconnect exact controller → Start/daemon/recover same Session/native id → actual message delivery.
Exercise true withdrawal before delivery and fenced/uncertain response, not lab timers.

At the same journey boundary, commit a queued/parked FIN run for the stopped guest and observe controller wake before
guest claim. After native Start, refuse actual Agent/auth/native resume and observe the existing activation-failure
report, truthful Inbox attention and undelivered pending input; retry keeps the same resource/Session and never buys or
replays. A controller-pinned scope-end trigger obeys fire-time Actions approval and waits on fresh positive guest idle.

Then inspect stop/delete unknown, missing plugin/credential, selected interrupting deadline/native expiry, local Move
refusal and cloud explicit pending-effect disclosure/reassign path when actual provider supports it. Use erasure **preflight**, not
destructive erase of user/development data; real DB isolated integration tests own erase mutation. Verify dated
storage/billing/native facts and normal retained recovery. Compare `b-wake A/Ap/S`, `m-life A` and `m-detail A/Ap/B/B2/Bp` at
desktop/390px/light/dark, screen-reader/keyboard/large text/reduced motion/phone keyboard. Measure progress/Avatar
subscription locality without refreshing every Session/Machine. Surface CLI/Agent/MCP/Voice intent and read proofs
through real approved front door; no passive wake or self-approved mutation.

Native macOS/real cloud tenant/physical platforms belong umbrella's named release checks with prerequisites
(contribution/tool/image, private carrier, retained disk, provider billing, native lifecycle), listed once for the
program; they are not repeated activation ledgers/archive gates or excuse to omit provider implementation. This
authoring task ran no tests, typechecks, builds, live wake/provider calls or erase mutations.

## 13. Economy notes

**D21/D23 economy:** retain only the fixed category preference in Account settings; allocation overrides/retention
intent lives on50, preset overrides on51 and scope bindings at existing Automation owner. Existing live-work
inventory/reversible drain and canonical archive/completion facts serve both triggers. No retention map by provider ID,
scope table, second idle rule, wake queue or lifecycle feed.

No second durable message queue, server wake service, distributed controller election/failover, cleanup
principal/credential escrow, handoff replacement topology, global poller/default timeout/idle CPU heuristic,
Session-count idle guess, generation/lease/fencing registry, lifecycle journal or native-specific viewer. One exact row
revision/current controller and owner-local serialization suffice unless a discriminating native duplicate-effect
failure proves otherwise; post-request ambiguity always remains an observation/recovery fact. Selected nearest deadline
is justified by real user policy, not unattended hypothetical scheduling. Reversible drain refines existing real
lifecycle; it does not become a new host turn owner. Unsupported native Suspend/Stop never maps to another effect.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Empirical owners: 52s1 verifies every real busy/admission producer and supported native success/fail/cancel/recovery,
actual deadline/clock ownership and submitted-effect observation after cloud Move; 52s2 proves current pending delivery/withdraw fence,
non-content carrier, restricted requester runtime and same native thread recovery through plan 42; 52s3 verifies existing
erase/dependency front doors and retained resource privacy/recovery. Unsettled native effects do not block an informed cloud Move (D42); characterize their retained observation and
report uncertainty. Real missing target credential/local reachability remains typed unavailable, not a settlement gate.

Residual risk: full busy aggregation/admission has not been proved, actual guest/pending carrier and native
thread/storage recovery remain empirical, and native Stop/wake support remains to be qualified; settled erasure requires
real dependency integration.

History: see archive-r8.4 and the review folder
