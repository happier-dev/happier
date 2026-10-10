# Machine sharing and project terminals

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**  
Date: **2026-10-06**  
Owner: Lane 12 / PD; approval record: none. Binding inputs: D2, D6, D8, D15, D16; D18/D19/D20/D24 and settled PD-LEAVE in
§5 govern policy; D41/D42 govern this r9.4 simplification.

- **Supersedes:** the deferred Machine-sharing portion of `../machine-pools-capacity-and-shared-machine-access.md` only (advanced Team pools/capacity remain
  deferred); [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) §“One shared-Machine access result”, the
  recipient-delivery portion of §“Full Machine key and requester Session lifecycle”, and the D6 Project-terminal contract. That draft has no numbered
  execution slices; provider/acquisition semantics remain with `50` –`56`.
- **Extends:** existing Machine discovery/admission, membership, signed transport, Machine-terminal and PTY owners;
  `../teams-lane-11-machine-pools-and-exact-dispatch.md` / `../teams-lane-11/01-personal-pools-and-exact-selection.md` exact dispatch and owned pool membership.
  Preserve `workspace-sync/PLAN.md` revision 2; the projection change in 41s2 must preserve its authorized status/conflict contracts.
- **Consumes:** `40-machine-content-key-lifecycle.md` s1–s3 for resource mode/key lifecycle; `10-workspace-identity-and-sources.md` s1 for `WorkspaceAddressV1`
  /resolution; `11-agent-free-project-open.md` s1–s3 for accepted Project roots; `20-project-manifest-native-and-trust.md` s3 for setup approval;
  `24-native-execution-environments.md` s2 for final host invocation; `70-shared-ui-and-plugin-presentation.md` s1/s4 for existing neutral anatomy;
  `71-action-placement-and-parity-integration.md` s1–s3 for normalized public discovery/approval.
- **Consumes:** INT `.project/plans/2026-09-29-unified-agent-work/PLAN.md` §3, I2 share-sheet row:
  `ShareSheet` / `ShareSheetAdapter` own role choices, legends, grant rows and responsive navigation; no Machine-only sheet.
- **Provides:** **41s1** audience/grant/readiness and accessible projection; **41s2** one current `MachineAdmission` across every reached carrier/effect/read,
  plus share-safe Machine publication; **41s3** requester-owned standalone Project shells and disclosure. `42` s1–s3, `11` shared s3, `31` shared s3, `32`
  shared starts/moves and `50/52` shared resource consumers use these exact seams.

Observed basis: 2026-10-05, current HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`, moving dirty checkout. **Observed**
source anchors below were checked; **Target** types/UI/Actions are proposed. No test, grant, key delivery, database
operation or live QA ran while writing this draft.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PD names the Lane 12 resource-key, sharing and requester-Session corridor (plans 40–42).
- INT is `.project/plans/2026-09-29-unified-agent-work/PLAN.md`; §3 owns shared sheet, context-slot and status contracts.
- ORC is `.project/plans/2026-09-27-orchestration-workstreams/PLAN.md`; it owns Agent-start admission, WorkerUpdate/host context and Inbox.
- FIN is `.project/plans/automation-workflows-and-steps/`; it owns workflow claims/delivery/completion and lifecycle triggers; plans 21/31 own finite scripts.
- C30 refers to plan 30, finite execution target policy.
- E2EE means end-to-end encryption; DEK means data-encryption key.
- PTY means pseudoterminal; PTYS refers to pseudoterminal sessions.
- DTO means data transfer object; CAS means compare-and-set.

## 1. Outcome and user value

Share an existing trusted Machine with a person, all current Team members or a Team group. A recipient sees it in the
ordinary Machine picker and can open a terminal in an admitted Project without creating an Agent Session. The owner
edits access in the existing Machine page. A shared Machine never grants another person's Session history, Source
catalog access or API credential/key reads; D24 discloses same-user access to local credentials and Account encryption keys; Manage includes
owner-equivalent infrastructure rights under D20.

Reference concepts: final lab `.happier/design-lab/lane12-final/` (D27): `m-share A/Ap/S/Sp/R/Rp/SS` owner panel/sheet/revoke/states; `m-pick A/Ap/S/Sp/W/Wp`
picker/trust/purpose filtering;
`m-share T/Tp` terminal without Agent; `m-pick Aprog` creation progress. `m-detail A/Ap` content rows
remain own-work only; foreign work becomes `42`'s identity/count section. No separate picker algorithms.

- **MS-R1:** one Machine-owned current access result enforces audience lifetime, effective role, availability, exact installation and resource mode across
  REST, socket RPC, external Actions/protected V2, streams and direct/peer routing.
- **MS-R2:** Plain Machine → any admitted Account is permission-only; E2EE Machine → current eligible E2EE recipient is envelope-based; E2EE → Plain is
  refused. Pending/envelope existence never equals permission.
- **MS-R3:** owner/manager sharing, recipient discovery/leave and phone navigation are reachable through existing routes and canonical Actions.
- **MS-R4:** standalone Project terminal create/reuse/list/read/input/resize/close/stream/reconnect uses authenticated requester attribution and root
  admission. Guessed ids/keys cannot access another requester's terminal.
- **MS-R5:** share-wide Machine content contains only permitted host/readiness facts. Private relationship/work paths remain at admitted domain owners; all
  current authorized status consumers preserve freshness and conflict invalidation.
- **MS-I1:** actor is the requester, custodian is Machine owner; neither is substituted.
- **MS-I2:** Machine Use is neither Session authority nor
  source/root/provider/daemon administration authority; Manage grants owner-equivalent Machine administration through this one access owner, while private
  Session/Source authority and API credential/key reads stay separate.
- **MS-I3:** keys/tickets/cache observations cannot revive revoked access.
- **MS-I4:**
  commands run as the custodian's OS user; do not promise hostile-user isolation or deletion of already-held data.

The outer deciding checks are an actual cross-account terminal and next-operation/stream revoke denial, the full
carrier's actor/installation binding, and decryption of the recipient's entire Machine blob without private work
content.

## 2. User-facing flows, surfaces and exact copy

### Owner and manager sharing

Desktop Settings → Machines → existing collection/detail → Sharing `ItemGroup` → incumbent
`components/sharing/ShareSheet.tsx#ShareSheet` with NEW `machineShareAdapter.tsx` and the Machine access controller. The
adapter supplies trusted-OS disclosure, ready/pending/refused details and the two allowed levels: `view` = Can use,
`admin` = Can manage; `edit` is not offered or accepted for Machines. The sheet owns principal search, role controls,
remove confirmation and focus. Submit invokes `machines.access.grant.set` under Ask first; Remove and pending Cancel use
`machines.access.grant.remove`. Retry delivery invokes `prepareKeys` only when needed.

Put the D24 disclosure in the Machine adapter's `sections.leading`, reused by inline detail and full/compact ShareSheet presentations.
Use the existing locked `ShareLevelControlModel`/blocked candidate reason for E2EE→Plain refusal; never offer a pretend successful grant.
Per-grant Remove access expands `ShareRemovalModel` consequences naming the actor work that actually loses effective access:
Session runtime, scripts/runs, queued/preparing work, terminals and services. Confirm removal / Cancel stays in the same grant row.
Overlapping valid grants preserve admitted work and must not claim it stops. Owner/custodian integrity remains a locked reason, not an extra role.

Phone follows the same Machine route and mounts the same `ShareSheet` in its full/page presentation and incumbent
`SelectionList` step navigation. Back restores the sheet's search/selection/focus; the adapter's `renderGrantDetails`
supplies Machine-only key status/disclosure. No new grant-detail route or second person/role picker. The exact
Home/Machine remains captured by the controller; navigation alone authorizes nothing.

CLI/agent/MCP/voice use the same qualified Action input and grant outcomes. Search uses current Team/group/person option
resolution and safe identity projection; it cannot fabricate key readiness. Show disclosure in the review/confirmation
outcome, not just in the app panel. Readers without Manage see their own access and leave controls rather than the
entire audience census.

### Recipient selection and use

Extend existing Machines collection, Machine sync and new-Session destination model: Your machines / Created by Happier
/ Shared with you · {team}. `m-pick`'s New machine/presets is supplied by `50/51` and stays in this list. A shared
existing row selects the exact Home/Machine and preserves the current draft, root and previously explicit selection.
Offline rows remain visible; pending/refused rows explain why they cannot run. Sole eligible live candidate
auto-selection happens only when existing inventory/currentness is settled. Pending keys do not create a placeholder
Session or substitute another target.

Selecting a shared target adds one quiet trust entry to `AgentInput`'s existing status row. `42` owns scoped-versus-fallback sign-in
copy; this plan supplies D24 credential/key exposure disclosure before terminal/agent use and recommends dedicated team machines. Detail → Your access shows
owner/role, requester-history attribution and same-user exposure disclosure, direct Leave or inherited-access explanation.
“Move a session” consumes existing handoff only when its
source is reachable and still admitted; otherwise `42` shows retained history/resume guidance.

### Project terminal

Accepted Project → existing bottom terminal Open (desktop), the same scoped phone pane, or Machine detail Open terminal
with admitted root. `machines.terminal.open/read/write/close/restart` are canonical process effects; no fake Session.
Tabs, focus, split/reorder, label rename, detach, view resize and view close remain local presentation at the incumbent
terminal owner, not transported callbacks. OS resize uses authenticated approved attach/stream custody. Closing a
borrowed task-output view detaches without killing 21's process; interactive reconnect uses current PTY id/attribution.

All terminal roots come from `10/11` resolution and the existing filesystem/approved Sync target authority. A Machine
grant alone does not authorize arbitrary caller cwd or export the custodian's Account settings. Existing shell/process
budgets, platform helpers and final launch authorization apply. Shared setup consumes `20` policy; current owner's trust
cannot be borrowed.

### Localized state grammar

Proposed keys are exact additions to the existing UI i18n catalog. Generic Retry/Cancel/Remove labels reuse existing
generic keys where present; domain messages below are the English contract. CLI/Action consumers receive codes plus
equivalent user-readable explanations.

| Key | English string | State / recovery |
| --- | --- | --- |
| `machines.sharing.title` | Sharing | Stable owner/manager section. |
| `machines.sharing.description` | People and Teams you add can start sessions, run scripts and open terminals in workspaces on {machine}. | Pair with the single `machines.sharing.trustedOs` D24 disclosure before granting terminal or agent use; Plain Accounts have no Account encryption key. |
| `machines.sharing.trustedOs` | People with terminal or agent access to {machine} run as your operating-system user and can obtain your local credentials and Account encryption key, if present. No Happier API reads or exports owner credentials or keys; anything a shared shell prints can contain them. We recommend sharing a dedicated team machine. | Share UI, approval UI when presented, and configuring a waiver; Always allow adds no acknowledgement gate. |
| `machines.sharing.manageHelp` | People who can manage {machine} can also share it with others, giving them the same access. | Display with Manage selection, including its owner-exposure consequence. |
| `machines.sharing.empty` | Share {machine} so teammates can work here. | Empty; primary Share. |
| `machines.sharing.loading` | Loading access to {machine}. | First load, reserved section; do not flash empty. |
| `machines.sharing.readError` | Could not load access to {machine}. | Retry; last-known audience remains visibly stale. |
| `machines.sharing.offline` | {machine} is offline. Access changes are saved here. | Server audience edits remain possible; key delivery/effects wait. |
| `machines.sharing.denied` | Only people who can manage {machine} can change sharing. | Read own access; contact current custodian/manager. |
| `machines.sharing.use` / `.manage` | Can use / Can manage | Radio/segmented roles; Manage includes power/delete/controller/plugin/daemon/spend and granting Manage (D20), with no API credential/key read or original-custodian removal; D24 discloses same-user credential/key exposure before granting use. |
| `machines.sharing.allMembers` | All current members, including people who join later | Team-all-current audience. |
| `machines.sharing.pending` | Waiting for an authorized key holder to prepare access to {machine}. | Sharing client seals immediately when possible; later Team joiners wait for an online owner or current Manage key holder, including an authorized daemon. Exact pending Cancel, Retry. |
| `machines.sharing.incompatible` | {machine} is end-to-end encrypted and {person}'s account is not, so {person} cannot open it. | Inline refusal; Remove saved incompatible audience, or pick Plain Machine. |
| `machines.sharing.incompatibleHelp` | Share a machine that is not encrypted, or ask {person} to turn on end-to-end encryption in Account settings. | No automatic mode conversion. |
| `machines.sharing.plain` | Its data is not end-to-end encrypted, so the Home can read it. | Plain Machine fact; no recipient keys. |
| `machines.sharing.saved` | Sharing updated | Announce success once; no steady success banner. |
| `machines.sharing.yourAccess` | Your access | Recipient detail. |
| `machines.sharing.ownHistory` | Sessions you start here stay yours in Happier. People signed in to {machine}'s operating system can see their files and output there. | Recipient detail/composer link. |
| `machines.sharing.leave` | Leave this share | Removes own direct grant; Ask first. |
| `machines.sharing.inherited` | You still have access through {audience}. Ask its manager to change your access. | Direct leave/removal leaves overlapping inherited permission. |
| `machines.sharing.revoked` | {owner} stopped sharing {machine}. Your running work here is being stopped. Your sessions stay in your history; you cannot start new work here. | Revoke; source-admitted handoff or `42` resume guidance. |
| `machines.sharing.unavailable` | Access to {machine} could not be checked. | Fail closed; Retry, retain draft/history. |
| `machines.destinations.shared` | Shared with you · {team} | Existing picker/collection grouping. Direct person share uses existing owner label without fabricated Team. |
| `machines.destinations.owner` | {owner}'s · {platform} | Shared row subtitle, safely supplied identity. |
| `machines.destinations.pendingKey` | Waiting for secure access | Visible non-running target. |
| `machines.terminals.projectEmpty` | Open a terminal to work in this project. | Empty terminal host; primary Open terminal. |
| `machines.terminals.opening` | Opening a terminal on {machine}. | Pending ensure; no blank shell success. |
| `machines.terminals.sharedOs` | Commands run as {owner}'s machine user on {machine}. | Before open/input approval; trusted OS boundary. |
| `machines.terminals.denied` | You no longer have access to this terminal. | Clear sensitive active view/stream, keep own history navigation. |
| `machines.terminals.rootDenied` | This folder is not available for your project terminal. | Choose admitted workspace; no broadened filesystem policy. |
| `machines.terminals.offline` | {machine} is offline. Reconnect when it is available. | Retain own last-known bytes marked stale; disable input. |
| `machines.terminals.openUnknown` | The terminal could not be confirmed. Check existing terminals before opening another. | Observe exact request/key; never blindly spawn twice. |
| `machines.terminals.unavailable` | Terminals are not available on {machine}. | Honest unsupported/disabled owner result; no synthetic Session fallback. |
| `machines.terminals.failed` | Could not open a terminal on {machine}. | Retry only after definitive no-effect; retain target/root. |

Input, permission, unsupported, offline, pending and unknown outcomes are not collapsed to “failed.” Terminal
retention/reaper/error codes from current DTOs remain authoritative; adding authorization codes extends the same strict
union. Metrics/motion reconciliation is §8.

## 3. Current owners and change map

| Current path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `packages/protocol/src/teams/principal.ts` `PrincipalRefV1Schema`; existing `ShareSheetAdapter` | REUSE | Existing account/team/group vocabulary and current membership predicates; map Use/Manage to current share levels. No global principal extension. |
| `apps/ui/sources/components/sharing/ShareSheet.tsx:54` `ShareSheet`; `sharing/documents/documentShareAdapter.tsx:59` `createDocumentShareAdapter` | REUSE / EXTEND | Machine adapter/controller supplies domain meanings and key state; sheet/SelectionList owns search, directory, row details, removal and responsive navigation |
| `apps/server/sources/app/artifacts/artifactAccessService.ts:85/:318/:362` resolve/set/remove; `apps/server/prisma/schema.prisma` `ArtifactAccountGrant`/`ArtifactTeamGrant`/`ArtifactGroupGrant`/`ArtifactKeyEnvelope` | REUSE PATTERN | Machine per-kind grants + KeyEnvelope and one access service; idempotent principal set/remove, no grant edit revision or generic ACL service |
| `apps/cli/src/api/sessionAccessGrantEnvelopeHost.ts:83` `materializeSessionAccessGrantEnvelope`; Protocol `crypto/encryptedDataKeyEnvelopeV1.ts` `sealEncryptedDataKeyEnvelopeV1` | EXTRACT / EXTEND | The sharer's client seals the Machine resource key inside approved `grant.set`; adapt target/mode/currentness at the existing key-preparation seam, retain Session behavior |
| `apps/server/sources/app/teams/memberships/effectiveMembership.ts:47/:71` membership predicate/context | REUSE | Current Account/Team/member activity and membership lifetime; do not consume Session access-start horizon. |
| `apps/server/sources/app/teams/groups/effectiveGroupMembership.ts:58/:70/:112` effective group/context | REUSE | Current member Account binding/group state; overlapping audiences union. |
| `apps/server/sources/app/encryption/accountRecipientEnvelopeReadiness.ts:39` readiness derivation | REUSE | Authoritative Account mode and verified current public binding; Machine adapter does not infer readiness from a key's existence. |
| `apps/ui/sources/sync/encryption/prepareCurrentSessionDataKeyEnvelopes.ts:146` current Session preparation | EXTRACT | Reuse existing generic sealing/currentness work pass under Machine transport adapter; preserve Session wrapper and policy. |
| `apps/server/sources/app/api/routes/machines/machinesRoutes.ts:152` registration/routes | EXTEND | Existing list/detail project accessible resources; registration/administration mutations accept owner or current Manage through machineAccess; original custodian identity and private keys remain protected. Add Machine-owned access/envelope routes. |
| `apps/server/sources/app/api/socket/rpc/registerSocketRpcHandlers.ts:503` forwarding corridor | REFACTOR | Resolve one current Machine admission; route to custodian socket and bind authenticated requester separately through existing signed proof/currentness. |
| `apps/server/sources/app/api/socket/machineUpdateHandler.ts:781/:908` metadata/state handlers | EXTEND | Metadata, including Machine finite policy, requires owner or current Manage; daemon-state writes require the current custodian installation. Use plus a valid DEK/version is insufficient. Compose 40's envelope/version checks in the same mutation. |
| `apps/server/sources/app/api/socket/externalActionDispatcher.ts:134` dispatch | REFACTOR | Preserve principal Account; replace target equal-owner assumption with admission plus exact custodian installation. |
| `apps/server/sources/app/auth/externalActionExecutionAuthorization.ts:84/:145/:173` common/Machine verification | CONSOLIDATE | These currently query Machine with actor Account. Authenticate actor and installation independently via Machine admission, including final async currentness. |
| `apps/cli/src/rpc/handlers/externalAction.ts:113` actor equality guard | REFACTOR | Verify admitted signed actor/custodian context; delete equality-only rejection only after all producer/carrier/consumer tests prove the replacement. |
| `apps/cli/src/daemon/externalActions/executeExternalAction.ts:200` protected V2 execution; `packages/sdk/src/machines.ts:95` material resolver | EXTEND | Target-Machine crypto resolution for persistent shared target under existing protected input format; no Account/plain fallback. |
| `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts:36` policy; `apps/server/sources/app/api/routes/machines/peer/mediation/registerPeerMediationGrantRoutes.ts:256` `registerPeerMediationGrantRoutes` | EXTEND | Closed operation permission annotations; source-owned/target-admitted distinction. Shared carriers without current access verification stay `server_required`. |
| `apps/cli/src/api/machine/rpcHandlers.terminal.ts:173/:204` ensure/list/read handlers; `apps/cli/src/terminal/pty/sessions.ts:302` PTY manager | EXTEND | Admission-stamped requester/workspace; scoped terminal-key reuse and every raw/byte-stream operation. Keep actual PTY lifetime/read budgets/platform adapters. |
| `packages/protocol/src/daemon/terminal.ts:66/:93/:148/:160/:173` ensure/read/input/resize/close schemas; `actions/specs/machineConnection.ts:66/:131` terminal specs | EXTEND | Reuse daemon DTOs; add missing public read/write/close Actions, keep OS resize in authenticated attach/stream custody, expose requested Voice through policy. Never duplicate stream/process schemas. |
| `apps/cli/src/daemon/startup/createDaemonMachineBootstrapRuntime.ts:196` Sync publisher; `apps/cli/src/api/types.ts:406/:432/:461` nested daemon state | REFINE | Publish only safe host/readiness facts before wider key delivery; private full relationship status leaves this blob. Audit passthrough peer fields at actual publishers. |
| `apps/ui/sources/sync/store/domains/machines.ts:238` hydration; `sync/domains/sessionHandoff/applyWorkspaceSyncRuntimeEvent.ts:7` event apply | REFACTOR | Readiness still hydrates from Machine; authorized full status/conflict invalidation comes from existing relationship status/read/subscription, not disclosed Machine bytes. |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16`; `collection/MachineCollectionList.tsx:142`; `app/(app)/machine/[id]/index.tsx:162` `MachineDetailScreen` | EXTEND | Mount canonical ShareSheet with Machine adapter alongside work/worker/managed sections in this one enrolled detail. The lab name `MachineDetailView` is conceptual, not an observed production owner. |
| `apps/ui/sources/sync/engine/machines/syncMachines.ts:322`; `components/sessions/new/components/machineSelection/buildMachineDestinationModel.ts:117` | EXTEND | Hydrate accessible safe rows and group shared destinations within the existing model; settled auto-selection/current Home retained. |
| `apps/ui/sources/components/sessions/terminal/strip/SessionTerminalWorkspaceView.tsx` | EXTRACT / EXTEND | Bind its real pane/process anatomy to admitted Project scope; do not create another terminal manager or invent Session ids. |

Existing support/test paths in §§11–12 were independently inventoried. Direct grant route and terminal-view files are
verified files; line-less entries identify a corridor requiring its effect-specific symbol census within that slice, not
a fabricated precise anchor.

D19 cancellation source anchors verified for this revision:
`apps/cli/src/daemon/actionOperations/actionOperationRunner.ts#createActionOperationRunner` returns requested after
abort, not settled; `apps/cli/src/terminal/pty/sessions.ts#createTerminalPtySessionManager` owns close/output and 21
extends it with the existing `apps/cli/src/agent/runtime/process/killProcessTree.ts#killProcessTree` process-tree
boundary. `apps/cli/src/daemon/sessions/stopSession.ts#createStopSession` and `stopSessionContract.ts` own runtime
stop/incomplete outcomes; `apps/cli/src/plugins/runtime/invocation/services/managedServicesOwner.ts` owns native
`handle.stop`. 31's finite queue is proposed work inside its target admission owner, not an existing shipped queue. This
revision reuses these owners and adds no cancellation subsystem.

## 4. Split-brains contracted here

**Winner:** NEW `apps/server/sources/app/machines/machineAccess.ts` supplies one internal resource decision, reusing
effective membership. Transport owners enforce signed proof/currentness and domain owners enforce their additional
root/Session/service/provider rules.

Machine metadata and daemon-state socket writers consume that same admission: remove their equal-Account-only
authorization after replacement proof; never infer Manage from ciphertext validity. 40 retains key/version ownership.

- Migrate own-Account checks in Machine reads/socket forwarding/external authorization/daemon receiver/peer mediation to that decision. Remove consumer-local
  Use/Manage evaluations and equal-owner exceptions after producer proof; accept current Manage for registration/administration through that same decision;
  preserve original-custodian identity and private key custody.
- Accessible server projection feeds existing Machine sync/list/destination/CLI inventories. Delete any shared-only fetch, picker, grant cache or
  auto-selection implementation introduced while migrating; discovery is not effect authority.
- Recipient envelope adapter reuses canonical readiness/seal pass; no cloned Session grant resolver, Session history cutoff, second recipient queue or
  permission inferred from envelope rows.
- PTY remains the process/output/retention owner. All terminal id/key/raw-stream consumers migrate to requester scope; no new Project terminal store/fake
  Session/list-only privacy fix.
- Full private Sync status moves through the current relationship authority; remove the Machine publisher and Machine hydration reliance for private fields
  together. Keep content-free Local Services Machine count, actual Local Services inventory's own authorization, and authorized Sync status/conflict semantics.

Different domain authorities intentionally remain: Session access/history, root/source admission, provider spend/power,
installation custody and Account-mode migration. Use does not replace them; Manage satisfies the Machine
administration/power/spend role requirement through machineAccess, without granting private Session/Source content or
raw credential/key reads.

## 5. Contracts, persistence, routes and events

Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Daemon weight; `packages/protocol/src/json/storedReadSchema.ts#createStoredReadSchema` already owns lazy derivation and reuse.

**Reader/input classification:** Stored: relational per-kind grants/key envelopes, their JSON MachineAccessGrantV1/PrincipalRefV1 projections, accessible Machine content and retained requester PTY metadata. Strict input/event: MachineTargetV1, admission/role/access publication, grant mutations/results, key-preparation results, terminal/peer requests and stable events. Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts; relational columns need no fabricated extras fixture.

All NEW schema names below are proposals at the existing Protocol machines domain. Reuse current validated nonempty
id/qualified Home conventions and Audience display components; no arbitrary bag accepts actor or custodian. Every
authority/identity/mutation/nested outcome object at request or event ingress is **closed**; stored
grant/envelope/Machine records instead use tolerant readers + canonical writers. This is V1 wire epoch, independent of
package version. Presentation may drop bounded unknown optional labels under the existing owner policy; it cannot
preserve unknown fields into authority.

```ts
// Import the existing account/team/group PrincipalRefV1 from teams/principal.ts.
// Do not add a global principal arm or membership-lifetime grant table.
type MachineAccessRoleV1 = 'use' | 'manage';
type MachineTargetV1 = Readonly<{ serverId: string; machineId: string }>;
type MachineAdmission =
  | { kind: 'admitted'; actorAccountId: string; custodianAccountId: string;
      machineId: string; installationId: string; role: MachineAccessRoleV1;
      encryptionMode: 'plain' | 'e2ee' }
  | { kind: 'denied'; code: 'access_denied' | 'machine_unavailable'
      | 'recipient_encryption_incompatible' | 'recipient_key_pending'
      | 'encryption_material_unavailable' };
type AccessibleMachineAccessV1 = Readonly<{
  custodian: { accountId: string; displayName: string };
  role: MachineAccessRoleV1;
  resourceMode: 'plain' | 'e2ee';
  accessState: 'ready' | 'key_pending' | 'refused';
}>;
type MachineAccessGrantV1 = Readonly<{
  machineId: string; principal: PrincipalRefV1; level: 'view' | 'admin';
}>;
type MachineAccessGrantSetInputV1 = MachineTargetV1 & Readonly<{
  principal: PrincipalRefV1; level: 'view' | 'admin';
}>;
type MachineAccessGrantRemoveInputV1 = MachineTargetV1 & Readonly<{
  principal: PrincipalRefV1;
}>;
type MachineAccessMutationResultV1 =
  | { kind: 'saved'; grant: MachineAccessGrantV1;
      readiness: 'ready' | 'key_pending' | 'refused' }
  | { kind: 'removed'; effectiveAccess: 'none' | 'use' | 'manage' }
  | { kind: 'left'; effectiveAccess: 'none' | 'use' | 'manage' }
  | { kind: 'inherited_access_remains'; role: MachineAccessRoleV1 }
  | { kind: 'refused'; code: MachineAccessRefusalCode };
type MachineKeyPreparationResultV1 =
  | { kind: 'prepared' }
  | { kind: 'pending_holder' }
  | { kind: 'recipient_incompatible' }
  | { kind: 'unavailable'; code: MachineAccessRefusalCode };
```

`MachineAccessRefusalCode` is the closed denial code set above, extended only for actual existing lifecycle refusal
(stale grant/recipient binding/unsupported operation), not an open string. `AccessibleMachineProjectionV1` extends
incumbent Machine identity/presence/kind/current installation/content fields with `AccessibleMachineAccessV1`. It is
generated by server admission, never accepted from an author as proof. Custodian/self rows remain compatible with their
existing resource-mode validation; foreign Plain rows viewed by E2EE Accounts use resource mode, not the viewer's
Account mode. Unavailable readiness remains explicit without requesting fictional Plain keys.

**Persistence required by D2/D6:** extend the incumbent Artifact account/team/group grant + key-envelope pattern with
NEW `MachineAccountGrant`, `MachineTeamGrant`, `MachineGroupGrant` and `MachineKeyEnvelope(machineId,
recipientAccountId)` at Prisma and generated PostgreSQL/SQLite/MySQL schemas. Reuse existing PrincipalRef
account/team/group semantics; no exact-membership table or new global principal kind. Grants have normal FKs/timestamps
and one Machine/principal tuple; the canonical `machineAccess.ts` effective union owns idempotent set/remove and
rechecks authority. No grant revision, audience JSON parser, generic ACL service or stored canUse/pending flags;
ShareSheet revision is local invalidation only.

Envelope tuple records sealed current resource DEK, exact current Machine owner-envelope identity and recipient
public-binding identity, with normal tuple/currentness version if the existing commit owner requires it. Never store
plaintext key or let a caller choose a recipient binding. Effective permission and mode are rechecked before
projecting/conditionally committing an envelope. Plain has no recipient tuple. Historical tuples may remain inert after
revoke; they never authorize reads. Recipient readiness and worklist are derived from current grants/membership/key
binding, not an extra job table.

Migrations are future scope of 41s1 under `apps/server/AGENTS.md`: classify released versus development-exposed history;
generate/sync all three provider schemas/migrations, inspect SQL, test real constraints. If editing applied unpublished
migration bytes, reconcile the retained current-checkout database in place under `apps/stack/AGENTS.md`, deploy twice
and compare semantic schema/checksums/integrity. No reset, clone, backup ceremony or DB mutation is part of this
authoring task.

**NEW route adapter** `apps/server/sources/app/api/routes/machines/machineAccessRoutes.ts`, registered once by existing
routes:

- `GET /v1/machines/:id/access` : managers' safe audience census or recipient's own effective access; ordinary authenticated principal plus Machine manage/use
  rules.
- `PUT /v1/machines/:id/access`: strict idempotent principal/level set; current manager authority, no expected revision.
- `DELETE /v1/machines/:id/access` : strict exact-principal remove/cancel; own direct Leave delegates to this mutation with its self-only authorization.
  Repeated absent removal returns actual effective overlap.
- `GET/PATCH /v1/machines/:id/data-key-envelopes` : current authorized recipient work/projection and conditional envelope commit, adapting existing recipient
  pagination/encoded-byte boundaries instead of inventing a total recipient cap.

Approved `machines.access.grant.set` materializes the recipient envelope on the sharer's trusted client using the
existing `materializeSessionAccessGrantEnvelope`/`sealEncryptedDataKeyEnvelopeV1` seam adapted to 40's resource key.
Logical public input stays key-free; the private physical continuation rechecks current grant/mode/recipient binding and
owner-envelope before committing. Plain is permission-only; E2EE→Plain refuses. If the resource needs legacy conversion
or client lacks current material, grant remains pending rather than requiring an online daemon for every share. Online
daemon or authorized current key-holder clients (including Manage) service later Team joiners/current-key repair using
the same preparation/conditional-commit owner. `prepareKeys` is explicit Retry of that work, not a mandatory separate
approval after every Share; server never holds DEKs. Owner conversion remains `40`'s private transition. Existing
post-transaction Machine/Account-change and membership invalidations retire stale work; no key job/second sealing
algorithm.

**Transport contract:** current authenticated principal + exact requested Machine/method → `machineAccess` → existing
signed actor/custodian/installation context → exact custodian socket/receiver → current operation/root/Session check →
effect. Extend existing signed DTOs in place; do not add a parallel admission token. `MachineAdmission` stays internal
and non-author-mintable. Shared direct effects lacking current verification use the existing server-required policy and
typed offline unavailable, not a TTL.

**Terminal contract:** reuse `DaemonTerminal*` and current byte-stream DTOs. Extend ensure with an admitted Project
workspace reference where needed, using `10`'s schema; no caller `requesterAccountId`. Stamp
requester/Home/Machine/installation and accepted workspace on the actual PTY record from trusted host context. A
`terminalKey` is namespaced under that context; guessed reuse cannot return somebody else's terminal. Scope every
list/read/byte stream ack/input/resize/restart/close and existing relay publication. Session-backed terminals
additionally validate the actual Session. Existing stream/error unions gain strict forbidden/refused outcomes through
their canonical owners; no duplicate output storage or arbitrary new budgets.

Both `machines.terminal.close` and incumbent `session.terminals.close` resolve their admitted target into
`rpcHandlers.terminal.ts`'s `DAEMON_TERMINAL_CLOSE` → `TerminalPtySessionManager.close`, with one current
requester/root/Session policy. Pane/view close for a borrowed script output detaches only; process Stop remains 21's
operation cancellation owner. Raw resize is part of the existing approved attach/stream interaction custody and keeps
its authenticated canonical RPC; it is not a new standalone `machines.terminal.resize` business Action. 21's
execution-output reader resolves its associated terminal id then delegates to this same terminal read/byte-ring owner,
preserving operation authorization before delegation.

**Share-safe Machine content:** retain existing nonsecret host identity/platform/version/presence, explicit permitted
OS-home path facts necessary to canonical path handling, supported operation/readiness facts, safe transfer
capability/listener facts, and Local Services count/readiness. Remove private Sync relationship
ids/controller/path/status and foreign Session/operation ids/titles/commands/output from this channel. Audit
`DaemonPeerMediation*` passthroughs and actual publishers before recipient sealing: only declared nonsecret
endpoint/capability facts remain; tokens, private per-requester flow payloads or unknown native bags stay at their
authenticated domain owner. This is one safe Machine projection for owner and recipient, not selective UI redaction of
the same disclosed ciphertext. Full Sync detail remains at existing admitted relationship read/subscription; no new
status store/encryption framework.

### Current policy and owner decisions

Consume [index](../teams-lane-12-managed-environments-and-workspaces.md) §Outcome and binding decisions for D18/D19/D20/D24; §2 owns Machine-specific disclosure copy and §9 owns effective-loss fan-out. 20 retains Project trust, 41 the single Machine admission/effective-access union. D42 makes disclosure presentation, not an acknowledgement gate.

| Settled contract | Reason / dependent slices |
| --- | --- |
| **PD-LEAVE — SETTLED — effective-access union** | Direct Leave removes own direct grant; overlapping inherited access remains with existing membership/admin explanation. No resource deny override or implicit Team leave. 41s1/42s2 recovery. |

## 6. Actions (D16)

All business operations use the current Protocol `actions/actionIds.ts`, `actionSpecs.ts`, strict domain spec files and
schema-derived SDK generator. NEW Machine-access specs: `packages/protocol/src/actions/specs/machineAccess.ts`; extend
existing terminal specs in `machineConnection.ts`. Existing executor/controller supplies approval and placement; `71`
integrates surfaces rather than creating a second allowlist.

Ask first is the configurable D16 default, enforced by
`packages/protocol/src/actions/actionApprovalPolicy.ts#isApprovalRequiredByActionsSettings` / `resolveActionApprovalRouting`.
Show D24 disclosure in Share and any presented approval UI, including when configuring Always allow. A waiver uses that
same owner: no per-recipient acknowledgement, persisted consent, extra approval floor or app-credential restriction.
Recipient-key maintenance consumes the approved grant and current membership/binding/owner-envelope checks; it does not
require another human step for each recipient. Explicit Retry follows its configured Action policy.

| Action id | Input → output / placement | Safety / approval default / surfaces |
| --- | --- | --- |
| `machines.list` REUSE/EXTEND | Existing Home/filters → accessible safe Machine projections | Safe read; UI, CLI, agent, MCP, eligible voice. Selection is a target argument, not grant mutation. |
| `machines.access.grants.list` NEW | Qualified Machine → manager census or own level/readiness/principal explanation | Safe read, server placement; all five surfaces. No envelope or other work ids in output. |
| `machines.access.grant.set` NEW | §5 strict principal/level → saved/pending/refused | Danger; Ask first, server placement; all five. Current manage permission rechecked; trusted sharing client seals as the same approved continuation. |
| `machines.access.grant.remove` NEW | Target + exact principal → removed/effective overlap/refused | Danger; Ask first; all five. Pending Cancel uses this idempotent mutation; D19 loss of effective access cancels current/queued/preparing actor work through incumbent owners, overlap cancels nothing. |
| `machines.access.leave` NEW | Target + own direct account principal → left/inherited remains/refused | Consequential write; Ask first; all five. Delegates to grant.remove owner with self-only authorization; never leave Team silently. Session sharing already uses `session.access.grant.remove`; no named Session flow here requires a parallel `session.access.leave` verb. |
| `machines.access.prepareKeys` NEW | Target → prepared/pending-holder/recipient-incompatible/unavailable | Danger/key disclosure; Ask first, Machine placement; all five. No raw-key input/output. Earlier exact sharing approval may own the same continuation. |
| `machines.terminal.open` EXTEND | Existing ensure DTO + target/admitted workspace → incumbent ensure result | Danger; Ask first, Machine placement; UI/agent/MCP/CLI, extend eligible Voice. No Session required. |
| `machines.terminal.list` EXTEND | Target + existing list filter → only own attributed terminals/current unavailable | Safe read; all five, Machine placement. Owner count is `42`, not expanded foreign list. |
| `machines.terminal.read` NEW | Target + existing read/cursor DTO → existing terminal stream result | Safe read, own terminal/current use only; all five. Retained raw bytes obey existing budgets. |
| `machines.terminal.write` NEW | Target + existing input DTO → incumbent accepted/refused input result | Danger; Ask first; all five. UI interactive approval custody covers admitted typing session; no prompt per byte or unconditional keyboard bypass. |
| `machines.terminal.close` NEW | Target + terminal id → incumbent close/settlement result | Danger; Ask first; all five. Process close distinct from close borrowed view. |
| NEW `machines.terminal.restart` | Exact admitted terminal/root → canonical `DAEMON_TERMINAL_RESTART` / `TerminalPtySessionManager.restart`; no guessed cross-requester reuse | Dangerous / Ask first; mounted Restart delegates here |
| `session.terminals.*` EXTEND incumbent family | Existing closed pane intent; admitted Project-host scope adapter → current pane/process result | Preserve exact current presentation-versus-process safety. All eligible answering-client surfaces; headless client-only geometry unsupported. No new `project.terminals.*` aliases. |

Refresh repeats canonical list/read. Concrete Machine/Session/settings navigation consumes existing navigation Actions;
disclosure/help/Back/expand/focus/selector/clipboard remain local presentation and are not generic mounted-command
promises. Headless reads return data, not a fake clipboard/CLI Use. Grant and terminal business operations use listed
specs; raw RPC is not a public parity substitute. Arbitrary shell input remains dangerous under existing terminal/Action
policy and its configured waivers; no second shared-terminal approval policy or Agent self-approval.

Public SDK DTOs derive from their schema owner. Required business effects have real headless handlers; concrete app
navigation reports unavailable without its answering client. Pure local presentation has no cross-surface callback bus.
71 checks catalog → actual advertised tool → effect, including Voice/CLI, not flag presence.

## 7. Plugin extensibility and closed authority

Plugins consume safe accessible projections and canonical Actions through current SDK/Host API `executeAction`; existing
Agent host services receive the admitted actor/session context. Native provider family from `50` may consume this
admission but cannot mint it. No Machine-ACL/key/auth family, provider callback that decides Use, exposed signed
admission DTO, raw Account bearer or host internal import.

Public UI uses 70's verified neutral exports and existing terminal anatomy; host Sharing mounts the existing app
`ShareSheet`, not a newly claimed plugin-ui sharing export. A third-party fixture renders safe recipient status and
invokes `machines.access.grants.list` and `machines.terminal.open` through ordinary declared Actions; attempting raw
envelope/grant-proof fields fails strict validation. Core Sharing keeps permission inputs closed and persistence on
tolerant readers + canonical writers; any public share presentation extraction must reuse the incumbent owner with an
actual consumer.

## 8. UI composition, lab metrics and motion

Target tree (NEW names below are domain compositions, not claims of current exports):

```text
MachinesSettingsView / MachineCollectionList → MachineDetailScreen
  PageHeader / existing Machine identity facts
  ItemGroup: Sharing + disclosure + Share trigger
    existing ShareSheet (inline/compact desktop; full phone)
      NEW machineShareAdapter + domain controller
      existing SelectionList search/directory/role/remove/focus anatomy
      adapter renderGrantDetails: key state, Retry, trusted-OS consequence
  MachineWorkSummarySection (42s3)
  Existing workspaces/pools/containers and C30 worker-policy sections
New Session AgentInput → existing picker/list + shared disclosure status entry (42s2)
Project AppPaneScopeHost → admitted terminal workspace body → existing stream/input view
```

Phone detail uses existing navigation stack/subview and pane host, not hand-built CSS scrims/drawers. `70` § shared
anatomy supplies missing neutral capabilities; sharing adds no collection engine. Avatar/Team marks remain bare except
actual avatar circle. Sharing list uses short role/chevron beside title; two-choice controls move beneath labels as
necessary. Counts and menus are not links to foreign work.

Lab → app reconciliation: old lab section gap 30 → `HAPPIER_PAGE_METRICS.sectionGapPx` 28; illustrative 56/48 rows →
existing regular 52/compact 40 semantics. Preserve final hierarchy, contrast and hit targets; density is selected by
owner, not per-call raw pixels. Do not change global row metrics to reproduce one prototype. Desktop picker illustrative
350/392px → existing Popover available-space/clamp owner; 390px phone is a comparison viewport, not a product
minimum/cap. Existing safe areas and keyboard insets own visible terminal/input area.

Share expansion uses `ExpandableItem`/shared disclosure height+opacity; Enter focuses search, Escape/Back cancels only
unsent draft and restores trigger focus. Role selection responds immediately; persistence status waits for real result.
Picker uses current `motionTokens.overlay.popover` 140ms enter/120ms exit; staged frame growth uses existing
`inPlaceMorph` only when `50` actually acquires a resource. This plan adds no simulated allocation/key timers. Reduced
motion swaps immediately. Keep last-known rows and reserved state space; limit subscriptions to current
Machine/audience/terminal instead of whole Account lists.

## 9. Lifecycle, failure, cancellation and recovery

Idempotent grant.set under current manager authority → current recipient mode/readiness → 40 conversion if needed → safe
publication prerequisite → sharing client seal/conditional commit → ready projection. Client absent/current material
unavailable yields pending; an online owner/current Manage key holder or authorized daemon later delivers current
recipients through the same currentness owner, including when the custodian is offline. Current
membership/binding/owner-envelope are rechecked at commit. Account rotation yields repair/pending; E2EE→Plain refuses.
Post-transaction/membership invalidations preserve current access; no grant edit-conflict mechanism, persisted pending
job or local waiver.

A direct Account grant is independent of Team membership and remains until explicitly removed; Team/group grants depend
on their existing current effective membership. Team-all-current includes later/rejoining members under those semantics.
Overlapping Account/Team/group grants union role; loss of one audience preserves any independently valid access. Leave
removes only an own direct share and explains inherited access through existing membership/admin links.

**D19 revoke:** grant removal and membership loss recompute effective access at the single `machineAccess` owner. If
another still-valid grant grants access, cancel nothing. On effective access loss, deny fresh admissions/protected
reads/input/streams, evict access rooms and retire ciphers/caches, and cancel that actor's running work on this Machine:
requester-owned Session runtime (42), finite scripts/ad-hoc/setup operations plus queued/preparing work (21/31),
terminals they opened (41 PTY close/tree stop), and services they started (22 Local Services stop). Compose existing
cancellation owners, not a new kill subsystem or public revoked-user cancel bypass. Internal access-loss cleanup uses
authenticated existing host custody plus exact requester/owner references; it does not require the revoked actor to
regain Use. Requested stop is not completion: real settlement or explicit incomplete/stop-unconfirmed remains observable
and existing recovery retries that same owner. An offline Machine denies new work now and completes cancellation through
existing reconnect/currentness recovery before that actor can resume there. Their history and their own Session
records/keys remain theirs; delivered keys and OS copies cannot be retracted.

Terminal open validates actor/Machine/root before spawn and again at the actual reached effect after asynchronous
preparation. Reuse validates existing record's requester and accepted scope before returning it. Current access is
required for read/input/OS resize/close and stream publication, including after reconnect. Lost open acknowledgement
shows unknown and uses existing exact terminal-key observation; it does not open a fresh shell elsewhere. Cancel/close
reports actual PTY settlement, not timer success. Budgets/reaper/process-tree cancellation remain PTY-owned, with
Windows/macOS/Linux paths validated.

Shared direct/tunnel/peer effects use only carriers that can enforce current access. Unsupported direct shared flow
routes server-required; unavailable server means typed no-effect/unavailable where proven, indeterminate when acceptance
is uncertain. Never classify a dropped ACK as definite refusal. Repository credentials, Source access, final environment
approval and own service control are checked separately; Machine Use never copies a custodian's settings/credentials
into the requester.

## 10. Compatibility

Prospective sibling basis: `../0.2` HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`, focused Machine
key/API/schema/route/UI encryption status empty at drafting. Those owner data shapes are preserved through `40`;
existing same-owner terminals/AccessKey/Session history remain usable. New sharing rows have no predecessor writer. Read
current sibling terminal DTO/attribution producers before 41s3 and record bytes/suffixes, including staged/unstaged
changes; do not infer actor ownership from absence of new fields in an old marker.

Unreleased 0.3 admission/projection/terminal changes refactor in place under the one-way ruling; no old-0.3 aliases,
dual grant tables, ticket TTLs, fallback plain request or invented mixed-version matrix. Existing persistent
absent-envelope reading is owner-only; shared reads cannot use it. Missing supported new operation is typed unavailable;
broader existing own operations remain usable. Wire identity/authority/strict mutation unions cannot silently ignore new
semantics; contract capability/epoch change is owner-governed where needed, never a UI flag masquerading as
authorization.

Canonical documentation: implementation updates `docs/encryption.md` Machine/recipient sections and
`docs/compatibility.md` Machine/terminal sections. Search/update the existing published Machine-sharing/terminal page
under `apps/docs/content/docs/**` rather than creating a competing explanation; read Docs instructions before edits.
D8/count documentation belongs `42`; trusted OS-user disclosure is shared wording. No documentation/source edits occur
in this plan-writing task.

## 11. Slices in order

**Stored-reader checks:** 41s1 grants/envelopes are relational rows; only reached JSON Machine and retained PTY readers need owner regression cases. Shared doctrine and helper tests live in [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts.

Each slice includes its real producer and consumer, strict schemas, Actions and relevant UI. Use existing tests and true
OS/network/DB boundaries; no mocked internal access resolver, membership engine, crypto preparation, PTY accounting or
destination model. All slice test paths marked NEW are future tests beside the actual owner, not pre-existing coverage.

### 41s1 — Current audience/readiness and accessible sharing

**Consumed seam:** `ShareSheet` / `ShareSheetAdapter` — INT PLAN §3 I2; per-row levels and the legend come from
the same Machine adapter. `buildShareSheetSelectionStep.tsx` must not show the document-only Edit legend.

**Shared targets, pool ownership and policy prerequisites:** explicitly supersede only the deferred sharing portion of
`../machine-pools-capacity-and-shared-machine-access.md` and consume Lane 11 pool identity at
`apps/server/sources/app/machines/pools/machinePoolService.ts`: pool members remain custodian-owned Machines; shared
Machines are exact targets, not foreign pool members. Remove any shared-pool dependency rather than invent eligibility.
Extend 30s2's one purpose-qualified destination projection at its owner: requester Session, finite script and service
paths may admit supported exact shared targets; workflow/trigger/background-worker and Board `my_machines` selectors
stay owner-only with explicit unsupported reason. Include current `TriggerRunsOnRow` and `WorkflowProjectTargetControl`
consumers through that owner, not local filters. Visibility is not FIN eligibility. Machine finite policy consumes
40/30's Machine content writer, never a custodian-private Account KV row.

Follow the index's Daemon weight rule at these actual leaf imports; the existing stored-reader owner already supplies laziness.
Shared Machine delivery/execution consumes the index's D24 contract and the configured Action policy.

Consumes complete `40` resource-key basis and current Team/group/PrincipalRefV1/share-sheet owners; provides MS-R2/R3
and access DTO/grant owner to 41s2. Reuse Protocol `teams/principal.ts` and existing current membership consumers, NEW
`machines/machineAccessV1.ts`, access specs, server `machineAccess.ts`/`machineAccessRoutes.ts`, per-kind
grants/KeyEnvelope migrations, existing trusted-client recipient sealing seam, Machine serialization/list/detail, UI
sync/destination and NEW `components/sharing/machines/machineShareAdapter.tsx`/controller mounted in existing
`ShareSheet`. Register real routes/mutations together; recipient delivery enables only with 41s2 safe
publication/transport, not types alone. No new grant-detail route or sheet.

**RED:** NEW `apps/server/sources/app/machines/machineAccess.sqlite.integration.spec.ts` through the real
SQLite/membership/recipient-readiness owners: Plain target accepts both modes with no envelope; E2EE→Plain refuses;
eligible E2EE stays pending until current tuple commit; later Team joiner is eligible; departed Team/group membership
loses only those contributions and rejoin follows current membership semantics; overlap removal preserves access; stale
holder/recipient-key commit refuses. Test actual constraints and currentness, not a mock grant decision.

Additional RED at that real DB owner: repeat principal grant.set/remove remains idempotent with effective overlap;
Team/group leave, remove, bulk changes and rejoin recompute current union while an independent Account grant survives.
Extend existing `apps/cli/src/api/sessionAccessGrantEnvelopeHost.test.ts` if present after inventory, otherwise add its
adjacent Machine adapter suite: authorized current Manage sharer plus offline custodian daemon seals current Machine
key, wrong recipient/current grant refuses, later Team joiner gets pending then current owner/daemon delivery. Real
crypto/preparation/currentness, network boundary only. UI NEW `components/sharing/machines/machineShareAdapter.test.tsx`
through real `ShareSheet`/controller and canonical testkit verifies only Use/Manage offered, failed save retains draft,
phone Back/remove/focus shares the same owner; D24 uses adapter leading sections, refused E2EE→Plain levels/candidates explain the lock,
and removal previews distinguish effective access loss from surviving overlap before the same Confirm/Cancel flow.
Existing destination/plainMode suites preserve settled selection and
resource-mode contracts; do not assert raw styles/wording.

**D20 RED at the same real access/DB owner:** a current Manage grant admits power/delete/controller
reassignment/plugin/daemon administration, spend through custodian-held provider credential and granting Manage through
every actual UI/CLI/Action carrier; Use refuses those operations. A manager has no API read/export of the owner's
credential/keys or remove/replace the original custodian. Revoked/downgraded Manage refuses next admin effect;
overlapping valid Manage still admits. No handler-local owner equality or second Manage check may remain.

**GREEN and completion:** all accessible reads/list/picker/detail/CLI inventories use the same projection; saved grant/access
work is real, no recipient disclosure before s2, pending is derived, no second list/audience policy. Provider schemas/migrations sync; package/generator checks follow the index integration rule. Actual author-approved migration edits own retained DB reconciliation. Can prepare after 40 alongside
Project/worker/managed UI; effects wait 41s2.

### 41s2 — Current actor/custodian routing and safe Machine publication

**Consumed seams:** `ShareSheet` / `ShareSheetAdapter` — INT PLAN §3 I2; level options and the help legend come from
the Machine adapter's Use/Manage choices. Extend `buildShareSheetSelectionStep.tsx` at that owner so it never shows
the document-only Edit legend. `machineUpdateHandler.ts` consumes 40's current key basis and this slice's admission;
valid encryption material never confers metadata-write or daemon-state authority.

**Metadata/state RED:** extend the nearest `machineUpdateHandler` authorization integration suite with real access
and encrypted content: Use with a valid DEK and current expected version cannot change Machine policy; current Manage
can commit metadata while the custodian daemon is offline. Manage cannot publish daemon state; only the exact current
custodian installation can. Revoke/downgrade and envelope/version conflicts leave content unchanged.

**Membership-loss producer and preview contract:** extend the existing
`teams/memberships/sessionAccessEffects.ts#withTeamSessionAccessEffectsInTx`, memberAdministration/membershipService and
`teams/groups/groupContributions.ts#applyTeamGroupContributionInTx` permission-impact path to produce before/after
Machine effective unions for leave/remove/bulk/group edits/rejoin. Machine access consumes the committed impact and
existing invalidation/transport; final union loss alone revokes authorization and composes Session/finite
queue/PTYS/services stop. Preserve overlap; no independent consumer kill decision. Revoke protected streams and
authenticated Local Services/sessionless preview grants/tokens using 22s2's canonical owner, including already-open
browser preview streams; no permanent raw daemon token bypass. Existing stop settlement/incomplete recovery remains
observable. Real DB + transport/PTY/service boundary RED exercises direct and inherited overlap, final Team/group loss,
bulk removal, rejoin and open-preview loss, not just a direct grant DELETE.

Consumes 41s1 + 40s3 + existing signed transport and approved Sync relationship status/read contract; provides
MS-R1/R5/I1–I3 to all shared effects, 42s1 and 41s3. Touch REST/socket/external verifier/dispatcher/daemon
receiver/protected V2/SDK resolver/peer policy/stream relay, Machine daemon-state publisher/schema and UI Sync
hydration/status subscribers.

**RED:** `apps/server/sources/app/api/socket/externalActionCarrier.integration.spec.ts` and
`rpc/registerSocketRpcHandlers.authorizationRace.sqlite.integration.spec.ts` must admit Bob actor to Alice exact
installation without substituting Alice and reject revoke/install change before dispatch. CLI
`apiMachine.machineAdmission.runtimeCatalog.integration.test.ts`/`machineRpcAuthorization.test.ts` plus real crypto
verify Machine-target V2 opens under Machine material, not Bob Account ciphertext fallback.
`registerPeerMediationGrantRoutes.spec.ts` and current stream/tunnel authorization suites reject stale shared admission
or return server-required; no direct-key shortcut.

**D19 cancellation RED:** at real access removal plus existing lifecycle owners, revoke Bob's last valid grant while
Session runtime, finite process/descendants, queued/preparing operation, standalone terminal and started service are
active: actual stop/cancel settles each exact Bob-owned work reference, blocks further launch/input/stream, leaves
Alice/Cara's work and Bob's history/Session records intact. Remove a direct grant while Team/group access remains:
cancel nothing. Lost/offline stop acknowledgement stays incomplete/stop-unconfirmed and reconnect observes/retries the
same owner; never claim success from room eviction alone.
This is the composed access-loss check, reusing 31s3 queue/process and 42s2 Session/pending fixtures; those owners retain
their distinct settlement regressions rather than independently recreating this all-owner journey.

Privacy RED: `apps/cli/src/daemon/startup/createDaemonMachineBootstrapRuntime.test.ts` publishes a private relationship
and decrypts the whole shareable Machine DTO: no relationship id/path/private work.
`apps/ui/sources/sync/store/domains/machines.projectionInvalidation.test.ts` plus actual admitted relationship-status
owner must still refresh authorized status/conflicts; guessing unrelated relationship is denied. Trace each
peer/transfer passthrough producer and strict schema, with a fixture containing sensitive extra fields; forwarding them
must fail. Do not misclassify Local Services count as inventory.

**GREEN and completion:** every reached effect/read/carrier consumes one admission; equal-owner guards are removed only after
complete producer/consumer proof, administration accepts owner or current Manage via the same admission; private key
reads/original-custodian removal remain forbidden; direct currentness gap uses server-required; all private Sync
consumers migrate without rewriting approved semantics; whole blob audit is complete before any recipient seal. If
approved Sync contract cannot be preserved, stop affected portion for its amendment, not a local redaction store.
Run adjacent auth/encryption/transport/Sync suites; package/generator checks follow the index integration rule. Share delivery/UI becomes usable only after this integrated boundary. Editing same signed/key/cache hunks with
40s3 is coordinated, not parallel authority.

**Consumed seam for 41s3:** `admitAgentStartV1` — ORC PLAN §3.4 / INT PLAN §3 agent-start row; any Agent
start from a terminal retains requester authority through 42s2, never unchecked custodian daemon auth.

### 41s3 — Standalone requester Project terminal end to end

**PTY capacity prerequisite:** `apps/cli/src/terminal/pty/sessions.ts#ensureTerminal` currently evicts the globally
oldest terminal at capacity. Extend that existing capacity owner to evict only an eligible terminal owned by the
admitted requester, excluding 21's active finite-operation hold. With none eligible, return the existing owner's typed
capacity-unavailable/refused outcome; do not add another quota. RED fills the real manager to its existing bound, then
Bob opens while Alice is oldest/protected: Alice survives and Bob receives refusal or only Bob's eligible terminal is
replaced. Also test same-requester protected operation hold and ordinary eligible replacement.

Complete restart Action spec/executor/RPC registration through the actual manager restart; every
list/read/input/ack/resize/restart/close/reuse and relay frame consumes current requester/root/Session custody. RED
invokes the advertised restart handler and a forged other-requester raw restart/resize/close, asserting refused before
process IO and no cross-user terminal close. Local pane Restart delegates to the Action; resize remains approved stream
custody, not a separate business Action.

Consumes 41s2, accepted exact roots (`10/11`), final host environment (`24`) and existing PTY/pane owners; provides
MS-R4/I4 to Project/Session/CLI/agent/phone and terminal attribution to 42s3. Touch Protocol terminal DTO/spec family,
Machine RPC handlers/PTY records and registry, byte-stream/relay authorization, existing mounted terminal workspace
adapter, Project entry/pane wiring and i18n.

**RED:** existing `apps/cli/src/api/machine/rpcHandlers.terminal.realPty.test.ts` opens Bob's actual admitted root with
no Agent Session and retains output; `rpcHandlers.terminal.test.ts` + `terminal/pty/sessions.test.ts` denies Cara
list/read/input/resize/close/reuse/byte-stream ACK/subscribe for guessed id/key, and rejects next operation/stream after
Bob revoke. Use real PTY where available; otherwise OS PTY boundary mock with real record/access logic, never internal
ownership stubs. Add two-requester same terminal-key case to distinguish namespace collision from simple list filtering.

Existing mounted terminal family tests and NEW Project-scope adapter test must focus/split/rename/detach/close view
without synthetic Session or task-process kill. Canonical Action schema/executor/projection tests exercise
read/write/open under Ask first and actual advertised Voice/CLI tools; no raw RPC-only button.

Neighboring RED at the same real PTY owner: Machine close and incumbent Session close each settle the same
admitted process and deny a foreign requester; closing a borrowed output pane retains its task process. Attach-driven OS
resize still rejects revoked/guessed scope without introducing a standalone resize business Action. Preserve the broader
stream/reconnect/namespace tests above.

**GREEN and completion:** create/reuse/all byte/raw operations/relay/reconnect use admission-stamped ownership, root checks and
actual PTY outcomes; all pane hosts reuse the same body, no second process/terminal store. Linux/macOS/Windows
shell/path/process-tree cases pass where available, with explicit gaps. Run adjacent stream/PTY/lifecycle suites; package checks follow the index integration rule. Run §12's live segment before integrated completion. Can
prepare terminal UI/tests in parallel with s2; cannot enable foreign terminals before current access/privacy producers
are proven.

Validation/commands follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence, once at the coherent 40–42 boundary; focused owner/adjacent suites remain slice-local.

**Disclosure/policy check — 41s1:** extend the existing ShareSheet/controller + real Action-approval suite once:
the default grant request creates approval with the adapter's exposure disclosure; an explicit Always allow waiver admits
the same current authorized grant without another human acknowledgement, while disclosure remains in Share/waiver UI.
Current recipient-key maintenance needs no acknowledgement state; stale grant/binding still refuses at the existing
envelope commit owner. 30/40/42 consume this evidence rather than add approval tests. 41s1's D20 DB/carrier test above
owns credential/key API non-disclosure and original-custodian protection with synthetic boundary material; raw authorized
shell/file output may contain credentials. Plain remains keyless. No test opens real user credential files.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 41s1 | IMPLEMENTED (focused GREEN) | `71e10f8f39`, `92c476ae05`, `c72ecf82f0`, `751f8d9477` | [C41](../../reviews/2026-10-02-lane12-replan/impl-C/C41.md) supplies the canonical audience/readiness owner; [FX9](../../reviews/2026-10-02-lane12-replan/impl-C/FX9.md) closes [RV-B](../../reviews/2026-10-02-lane12-replan/impl-C/RV-B.md) access/preparation defects; [FX11](../../reviews/2026-10-02-lane12-replan/impl-C/FX11.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) confirm census retirement, overlap-aware removal and actual loser names. | Common gate; live E2EE/Plain, pending holder, Team late join/rejoin/overlap and configured approval. | Physical desktop/mobile sharing; native installed holders and signing. |
| 41s2 | IMPLEMENTED — open items | `92c476ae05`, `0cb95bb680`, `1a99f1349a`, `c72ecf82f0`, `327e8df613` | [C41](../../reviews/2026-10-02-lane12-replan/impl-C/C41.md) records signed actor/custodian routing and safe publication; [FX9](../../reviews/2026-10-02-lane12-replan/impl-C/FX9.md) closes reconnect cleanup without Session AccessKey; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) records real encrypted Account-currentness/catalog roundtrip GREEN. | Common gate; prove the whole decrypted publication and final-grant loss across Session/finite/queued/PTY/service/preview owners, preserving overlap and history; source tests do not replace that composed journey. | Native process-tree/PTY and reconnect on Linux/macOS/Windows; physical devices and signing. |
| 41s3 | IMPLEMENTED (focused GREEN) | `0cb95bb680`, `646b36d73c`, `1a99f1349a`, `c72ecf82f0`, `751f8d9477` | [C41](../../reviews/2026-10-02-lane12-replan/impl-C/C41.md) owns PTY/requester custody; [FX9](../../reviews/2026-10-02-lane12-replan/impl-C/FX9.md) repairs foreign Project-root ingress; [FX11](../../reviews/2026-10-02-lane12-replan/impl-C/FX11.md) records terminal approval/Artifact replay GREEN and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) confirms focused parity. | Common gate; real two-requester Project PTY open/read/input/resize/restart/close/reconnect and revoke through the same Action owners; B7 physical-root provenance remains its producer obligation. | Real PTYs/process trees on Linux/macOS/Windows; physical keyboard/safe areas and signing. |

## 12. Live QA segment and completion

Sharing/terminal segment of [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence. Use Alice E2EE custodian, Bob E2EE requester, Cara Plain/unrelated, a Plain Machine and admitted Project roots. After `40` segment, exercise desktop and 390px phone
Share/add/role/remove/pending cancel, Team late join/rejoin/overlap, E2EE→Plain inline refusal and Plain permission-only
selection. Verify holder-offline pending and no launch, then current delivery makes the ordinary shared picker row
usable.

Open Bob Project shell without Agent, type/read/resize/reconnect through actual PTY and Action tool counterparts.
Attempt unrelated guessed-id read/input/stream. Revoke while Bob's runtime, finite command/descendants, queued/preparing
work, shell and service are live; all reached owners cancel/stop, no subsequent effect/read/input/stream, Bob
history/Session records remain. Repeat with another valid grant: no cancellation. Inspect recipient's entire decrypted
Machine publication and authorized private Sync status separately. Lost ACK shows unknown/observe; direct shared
unavailable never becomes a successful effect.

Compare final `m-share A/Ap/SS/T/Tp` and `m-pick A/Ap/S/Sp` reference/live at matching light/dark widths, including
loading/offline/error/refusal/key pending; inspect component ownership as well as screenshots. Keyboard,
Back/Escape/focus restoration, screen-reader live status, large text, safe areas, reduced motion and subscription
locality are required. Runtime/prerequisite/release handling follows the index.

Completion follows the index integration rule with MS-R/I outcomes. A shared list without effects, recipient sealing before blob correction, missing raw terminal authorization or silent unsupported business effects cannot close the corridor.

## 13. Economy notes

Do not build IAM, Session history horizons, a persisted pending/access/count ledger, deny overrides, a second Machine
catalog, arbitrary shared-ticket TTL, separate crypto request format, hostile-tenant sandbox, Project terminal process
store, fake Session, new Sync status store or generic redaction envelope. Preserve capability/access/crypto/readiness as
distinct facts. No provider power fallback, custodian credential impersonation, new shell budget, task concurrency
default or decorative progress timer. Current permission and existing lifecycle owners supply the required outcome with
fewer competing decisions.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Empirical items and owners: **41s1** validate actual relational audience schema/unique constraint and normal recipient
work pass; **41s2** full Machine blob/peer/transfer publisher census, every current carrier and preservation of approved
Sync private-status semantics; **41s3** actual PTY streaming/interactive approval custody and platform/reconnect
behavior. **42s1** owns restricted principal sufficiency/D3 fallback; **40s3** owns warm-key cache behavior. Empirical
uncertainty is investigated, not sent for product ratification or encoded as speculative safety machinery.

Residual risk: current carriers and nested publication fields require the deciding real privacy/revoke tests; the draft
does not certify offline shared direct execution, OS isolation, erasure of copied material or current runtime behavior.

History: see archive-r8.4 and the review folder
