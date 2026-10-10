# Requester Sessions and work visibility

Status: **APPROVED 2026-10-08 — slices implemented with focused GREEN; corridor B physical namespace/birth proof and Main's composed recovery/integration evidence remain open (see §11 status)**
Contract revision: **r9.4**
Date: **2026-10-06**  
Owner: Lane 12 / PD; approval record: none. Binding inputs: D3, D8, D15, D16. D3's conditional fallback is already
authorized; broader credential exposure is not. D41/D42 govern this r9.4 simplification.

- **Supersedes:** [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) §“Full Machine key and requester Session
  lifecycle”, requester Session/AccessKey/D3 credential custody and the D8 owner-count contract. It does
  not supersede managed-resource/wake policy or ordinary Session/runtime ownership.
- **Extends:** ordinary server Session create/rejoin, AccessKey, auth/currentness, host Session lifecycle, pending input/recovery/handoff and current process
  inventories.
- **Consumes:** `40-machine-content-key-lifecycle.md` s1–s3; `41-machine-sharing-and-project-terminals.md` s1–s3 (`MachineAdmission`, resource-mode/current
  transport, admitted terminal attribution and §5 policy); `10-workspace-identity-and-sources.md` s1 qualified root; `20-project-manifest-native-and-trust.md`
  s3 setup policy; `24-native-execution-environments.md` s2 final launch; `21-finite-project-execution-and-output.md` s1/s3 operation↔terminal association;
  `31-finite-worker-admission.md` s3 accepted shared queue/process facts; `70` s1/s4 shared UI and `71` s1–s3 Action integration; ORC's existing
  admitAgentStartV1/effective prompt/start-policy owner, ORC WorkerUpdate/host-context consumers and FIN run/trigger delivery
  contracts; exact owning sections and invariants are named in the slices below.
- **Provides:** **42s1** foreign-Machine AccessKey and proven requester runtime credential; **42s2** same requester Session/native identity through
  launch/reconnect/pending/handoff/revoke and non-content exact-target wake facts; **42s3** owner-or-Manage identities+numeric work summary. `31` s3, `50` s3,
  `52` shared s2 and `60` s2 Bot launch/recovery flows consume 42s2 as well as 42s1; they may not mint credentials or read
  foreign work to compute counts.

42s3 additionally consumes `52` s1's internal `LiveWorkInventoryV1` (W3). 42s1/s2 shared execution and 31s3 do not wait
for owner-count presentation; 42s3 closes after the inventory producer. 52s1 consumes requester attribution from 42s2,
never this summary, so there is no 42s3↔52s1 cycle.

Observed source basis: 2026-10-05, current HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`, dirty moving checkout;
predecessor basis §10. **Observed** describes inspected source; **Target** describes proposed implementation. No
credentials accessed, no Session spawned, no source/DB mutated and no tests/build/live QA ran for this draft.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PD names the Lane 12 resource-key, sharing and requester-Session corridor (plans 40–42).
- ORC is `.project/plans/2026-09-27-orchestration-workstreams/PLAN.md`; it owns agent-start policy, turn facts and host-context consumers.
- FIN is `.project/plans/automation-workflows-and-steps/`; it owns workflows, claims, delivery, completion and lifecycle triggers.
- INT is `.project/plans/2026-09-29-unified-agent-work/PLAN.md`; it owns context-slot contracts, status and glossary.
- Finite script execution remains at Lane 12 plans 21/31, not FIN.
- W2 and W3 are implementation waves defined in the program index; they do not introduce separate owners.
- E2EE means end-to-end encryption; DEK means data-encryption key.
- PTY means pseudoterminal; PTYS refers to pseudoterminal sessions.
- DTO means data transfer object; CAS means compare-and-set.

## 1. Outcome and user value

Bob chooses Alice's shared Machine and starts an ordinary Session that belongs to Bob. Bob's Session history, messages
and native identity survive reconnect/resume and Machine-access removal. Alice's Machine page shows who is using it and
counts of their work, with no title/command/path/prompt/transcript/output links. The trusted operating-system user can
see local process/files as disclosed; Happier grant authority does not expose Bob's other Account data.

Lab basis: final lab `.happier/design-lab/lane12-final/` (D27): `m-pick S/Sp` credential/trust strip and `A/Ap` target selection; `m-share SS/T/Tp`
recipient/revoked/counts/terminal facts; `m-detail A/Ap` actual Machine detail (own names allowed, foreign counts only);
`b-wake A/Ap/S` same-resource/same-Session recovery. Provisioner acquisition is independent of this existing-Machine
sharing vertical.

- **RS-R1:** one exact `(requester Account, Machine, Session)` AccessKey can name a foreign custodian Machine; all
  create/read/update/delete/revoke/replace/erase/session-availability consumers migrate coherently.
- **RS-R2:** persistent shared execution prefers a Session-scoped runtime principal at existing auth/currentness owners; prove required runtime routes and
  rejection of unrelated Account/Session/grant routes. If adaptation is empirically disproportionate, use only the documented D3 ordinary requester-credential
  fallback in existing per-Session custody.
- **RS-R3:** ordinary create, message/tool/transcript, reconnect/resume, pending/wake and handoff preserve exact
  requester/Home/Machine/installation/Session/native identity and recheck current permission at each reached effect.
- **RS-R4:** owner-or-Manage work summary derives current requester attribution from real Session/process/Action/PTY owners, counts a script and its PTY once,
  and returns unavailable when liveness/attribution cannot be established.
- **RS-I1:** never replace Bob by Alice as actor, overwrite daemon global auth with Bob, copy Alice's Account settings, or create a second Session runtime/work
  ledger.
- **RS-I2:** Machine Use/Manage does not give private Session access.
- **RS-I3:** owner summary contains identities and numeric categories/currentness
  only.
- **RS-I4:** retained server history is independent of Machine admission and keys; counts are not idle/drain authority.

The discriminating evidence is Bob's real runtime writing/reading Bob's exact Session on Alice's installation, negative
unrelated-route tests with that principal, and Alice's actual summary with no foreign content. A usable shared picker or
foreign FK alone cannot complete this plan.

## 2. User-facing flows and exact copy

### Shared target → ordinary Session

Desktop/phone New Session composer → existing Run on picker (`41`) → exact shared target → disclosure entry in `AgentInput`'s existing status row
→ ordinary Send. Retain prompt, Agent/profile choice, root and Home while access/key/launch is pending or fails. No
auto-send on selection, no fake Session for a terminal, no provider acquisition from a shared-row click. The composer
uses `23`'s ordinary authoring path when seeded; this plan extends actual spawn, not seed policy.

Server creates/rejoins Bob's ordinary Session under incumbent tag/idempotency semantics, produces its exact AccessKey
and protected per-Session runtime credential, and sends only admitted Session-specific material to the target process
through existing carriers. Pending launch is not success. Accepted-but-unknown launch observes the same target/Session;
no fresh Session retry on another Machine. Bob history/navigation stays in ordinary Session views.

CLI/agent/MCP/voice call incumbent `session.spawn_new`/message/stop/handoff families under existing approvals and
qualified target. Disclosures reflect actual credential kind, never a cosmetic setting. Agent adapters receive admitted
Session context through host services; plugins are not token issuers or Session lifecycle owners.

### Continue, stop, lose access and move

Bob opens/rejoins his Session from ordinary history, sends messages, reads transcript/output and resumes only after
fresh current Machine admission. Stop/cancel uses normal Session/process owner and distinct current authority. Machine
revoke blocks new target effects, pending consumption and protected Machine reads/inputs/streams per `41` §5; it does
not delete Bob's server Session or its independent key. D19 also stops that requester's current Session runtime on this
Machine via the existing stop owner; their Session record/key/history remains theirs. Another valid grant means no stop.

After access removal, own server history remains readable. “Move a session” checks both source and destination
admission/reachability through existing handoff; if source access is gone or local state cannot be read, show
retained-history/resume guidance rather than pretending local files/native state moved. A stopped managed target uses
`52`'s non-content wake signal, only after pending input authorization. Merely opening history, listing/counting,
Talk/Watch, pinning or inspecting never wakes compute.

### Owner visibility

Settings → Machines → actual Machine detail → In use by others. Show person Avatar/name and quiet numeric
Session/run/terminal counts. No expandable foreign content row, Session title, work title or navigation to foreign
history. Phone rows retain same hierarchy; a person menu may explain counts but cannot open their work. Requester detail
can show their own authorized names/output via ordinary owners; never repurpose that projection as an owner summary.

Counts reflect live hosted Sessions and active finite scripts/execution runs/workflow work (queued/preparing/running),
with standalone terminals separate. Use neutral copy rather than asserting all are “running.” Exclude settled operations/retained
output/dead processes. A finite script's associated PTY is not an extra shell. Partial/unknown recovery data yields
unavailable, not a reassuring zero. No summary refresh causes provider power, runtime start or transcript reads.

### Proposed localization additions

Keys integrate with existing i18n catalogs; all CLI/agent structured outcomes map to the same meaning. Actual protected
token/private-file paths are never interpolated.

| Key | English string | State / action |
| --- | --- | --- |
| `machines.requester.runsOn` | Runs on {owner}'s {machine}. | Composer/approval exact target identity. |
| `machines.requester.scopedSignIn` | Happier gives {machine} a sign-in that works only for this session. | Only when RS-R2's scoped route proof succeeds. |
| `machines.requester.fullSignIn` | Your Happier sign-in is stored on {machine} while this session runs. People with terminal or agent access there may use it to access your Happier account. | Only the documented conditional D3 fallback; explicit Account-wide exposure, not “session-scoped” branding. |
| `machines.requester.osVisibility` | The owner and anyone else with terminal or agent access on {machine} can read this session's files, output and sign-ins, including your {provider} sign-in and this session's Happier access, while it runs. | Composer status entry and human launch disclosure; use actual selected materialized purposes for both scoped and fallback credentials. |
| `machines.requester.loading` | Checking {machine} before starting your session. | Access/credential load; preserve draft. |
| `machines.requester.launching` | Starting your session on {machine}. | Pending actual acceptance. |
| `machines.requester.offline` | {machine} is offline. Your draft is kept here. | Retry when available or explicit target change; no auto reroute. |
| `machines.requester.keyPending` | Waiting for secure access to {machine}. | Existing pending share row; no Session launch. |
| `machines.requester.refused` | You cannot start a session on {machine} with your current access. | View access; retain draft. |
| `machines.requester.credentialUnavailable` | The sign-in for this session could not be prepared. | Repair/Retry; never automatic full-credential fallback on error. |
| `machines.requester.failed` | Your session could not start on {machine}. | Existing typed cause/output; retry only when no-effect established. |
| `machines.requester.unknown` | The session start could not be confirmed. Check this session before trying again. | Observe accepted target/Session/native state. |
| `machines.requester.accessRemoved` | Your access to {machine} was removed. This session stays in your history. | Disable target effects; own transcript remains. |
| `machines.requester.resumeElsewhere` | Open your retained history and choose another machine to continue. Files on {machine} have not been moved. | Alternative when handoff source not admitted/reachable. |
| `machines.requester.handoffUnavailable` | This session cannot be moved while its source machine is unavailable or no longer shared with you. | Explain existing handoff refusal; no privileged copy. |
| `machines.requester.waitingController` | Waiting for {controller} to start {machine}. | Consumes `52` actual wake state; no prompt relayed to controller. |
| `machines.work.title` | In use by others | Existing Machine page section. |
| `machines.work.description` | Who is working on {machine} right now. Their sessions stay theirs; Happier shows only who and how much. | Owner-or-Manage explanation. |
| `machines.work.empty` | No teammates are working on {machine} right now. | Only a current known empty result. |
| `machines.work.loading` | Checking who is using {machine}. | Stable section size; no zero while loading. |
| `machines.work.counts` | In use by others · {active} active | Display-only sum of the existing sessions/tasks/terminals fields, with dedupe unchanged; no fourth DTO field or count producer. Breakdowns use canonical sessions / scripts / runs and terminals where applicable, never call scripts runs. |
| `machines.work.unavailable` | Current work on {machine} could not be checked. | Retry; no zero inference. |
| `machines.work.offline` | {machine} is offline. Current work is unavailable. | Retain explicit last-known/as-of display only; never render it as current. |
| `machines.work.denied` | Only the machine's owner or someone who can manage it can see who is using it. | Current Manage is admitted through 41's access owner; Use recipients are denied. |
| `machines.work.refreshFailed` | Could not refresh work on {machine}. | One freshness line, Retry. |

Empty/new Session flows use incumbent composer copy; this plan introduces no parallel Session-list empty state. Invalid
audience/credentials/root/setup refusal are mapped to their owner codes and actionable messages, not raw enums or a
generic “something went wrong.”

**Access-loss presentation:** consume [index](../teams-lane-12-managed-environments-and-workspaces.md) D19 and 41’s `machines.sharing.revoked`; requester Session stop/pending recovery retains the existing incomplete/settled distinction and own history.

## 3. Current owners and change map

| Current path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `apps/server/prisma/schema.prisma:3445` `AccessKey` | REFACTOR | Machine relation currently uses `(accountId,machineId)`; use globally unique Machine id FK while Account remains requester/Session owner. Preserve tuple uniqueness/data/dataVersion. |
| `apps/server/sources/app/accessKeys/sessionMachineAccessKeyMutations.ts:47/:65/:86/:100` binding/read/invalidation/create | EXTEND | Current Machine availability uses requester Account as custodian; consume 41 admission and exact Session authority. Invalidation reaches all requester tuples on that Machine, not only custodian Account. |
| `apps/server/sources/app/api/routes/accessKeys/accessKeysRoutes.ts:12` route owner | REUSE / EXTEND | All GET/POST/PUT route guards and tuple outcomes consume migrated owner; no route-only foreign override. |
| `apps/server/sources/app/session/create/createFreshBoundLayout1Session.ts`; `createOrRejoinLayout1SessionByTag.ts` | REUSE / EXTEND | Preserve normal create/rejoin/publication and duplicate semantics; exact shared binding composes here, not separate Session entity. |
| `apps/server/sources/app/ephemeralRunner/materializeEphemeralRunner.ts:115` materialization pattern | EXTRACT | Reuse server-mints Session/restricted credential pattern where general; retain real Runner activation/resource rules. |
| `apps/server/sources/app/ephemeralRunner/materializedRunnerPrincipalCurrentness.ts:41` verifier | REFINE / EXTRACT | It currently requires ephemeral kind/activation and equal Machine owner. Share only true Session/installation/currentness checks at the auth owner via the private signed principal and live record joins, without fake activation/kind or another persisted binding. |
| `apps/server/sources/app/auth/auth.ts:197` restricted verification; `:713` `createChildApiToken` | REUSE / REFINE | Characterize existing Runner and attenuated API-token machinery against actual runtime routes before selecting smallest scoped carrier. API-token child issuance exists but is not proof that persistent runtime scope already works. |
| `apps/cli/src/api/apiMachine.spawnSession.runtimeCatalog.integration.test.ts` + `api/apiMachine.ts` spawn corridor | EXTEND | Real Machine daemon forwards only Bob's admitted per-Session bootstrap into existing host launch; never replaces daemon Account credentials. |
| `apps/cli/src/daemon/sessionRegistry.ts:34/:530` marker/write; `apps/cli/src/daemon/startDaemon.ts:725` `pidToTrackedSession` | EXTEND | Add nonsecret admitted requester/Home/installation attribution to actual launch/recovery records; no content/key/bearer in marker. |
| `apps/cli/src/daemon/actionOperations/actionOperationStore.ts:36/:52` scope/store | REUSE | Current operations already scope Account/Machine. Derive active count at trusted host owner without loosening public operation reads. |
| `apps/cli/src/terminal/pty/sessions.ts:302` PTY owner | REUSE | Consume 41 stamped requester and 21 operation↔PTY association for de-duplication; terminal liveness/output stay there. |
| `apps/server/sources/app/session/pending/pendingActivationAuthorization.ts`; CLI `daemon/sessions/activatePendingInactiveSession.ts` / `pendingSessionActivationRecovery.ts` | EXTEND | Current pending authorization/target recovery gain foreign-custodian non-content exact routing; canonical pending message custody unchanged. |
| `apps/ui/sources/components/sessions/new/components/NewSessionLaunchPendingPreview.tsx`; `navigation/presentCreatedNewSession.ts` | EXTEND | Keep current accepted launch/draft/currentness and exact target result; add actual shared sign-in disclosure, not a parallel composer path. |
| `apps/ui/sources/app/(app)/machine/[id]/index.tsx:162` `MachineDetailScreen` | EXTEND | NEW `MachineWorkSummarySection` mounts owner-authorized summary; foreign content never fetched to hide it later. |

Current source was checked by exact file/symbol inventory. Line-less creation/pending/spawn entries designate a verified
corridor where the slice first traces route/runtime callers; they are not claims a particular proposed helper exists.
All NEW filenames below are proposed.

## 4. Split-brains contracted here

**Session ownership winner:** existing ordinary Session/create/rejoin/host runtime plus canonical AccessKey mutation
service. **Machine permission winner:** 41 admission. **Credential winner:** existing auth/currentness/credential
materialization. **Count winner:** a derived projection of actual live owners, not another lifecycle authority.

- Migrate every AccessKey writer, GET/PUT/read helper, availability/socket admission, handoff, Machine revoke/replacement, Session delete and Account erase
  caller. Remove first-AccessKey target selection and requester=custodian assumptions; never add a second Session↔Machine binding table or redundant custodian
  column solely to avoid joins.
- Persistent requester auth extends the current principal owner after route characterization. Delete any daemon-owner credential substitution or hidden global
  requester auth path; keep existing ephemeral activation semantics and normal unrelated API-token rules.
- Normal spawn/resume/pending/hand-off consumers use exact admitted binding; no special shared Session runtime, title/metadata patch queue or duplicate
  wake-message store. Existing Agent/native adapters remain host-owned lifecycle consumers.
- Owner counts are generated at daemon inventory scope before output; never query someone else's `action.operations.list` or Session transcript and redact in
  UI. Keep each private read under the requester, while trusted internal liveness projection exposes only categories.

Retained distinct seams: Session history authorization, Machine access, OS administrator visibility, root/source trust,
E's provider power/controller and ordinary runtime bearer policy. None is collapsed into “shared means can do
everything.”

## 5. Contracts, persistence and runtime routes

Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Daemon weight; `packages/protocol/src/json/storedReadSchema.ts#createStoredReadSchema` already owns lazy derivation and reuse.

**Reader/input classification:** Stored: AccessKey data/version, nonsecret RequesterWorkAttributionV1 in actual start/adoption/recovery records and retained pending target facts. Strict input/event: signed runtime principal and credential/bootstrap/Session/handoff requests, credential disposition, summary and stable lifecycle events. Follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts; the private principal is verified from signed claims and live authorities, not another persisted record.

Target schemas extend current Protocol/Session/daemon owners. Every binding/credential selector/mutation/outcome at
input ingress and stable event is **closed**, including nested objects; AccessKey/attribution stored readers follow the index.
Reuse existing validated IDs/Home addresses/installation proof schemas; V1 wire epoch is
separate from package version. Unknown accepted presentation fields cannot become credential or work identity.

```ts
// Verified private principal from the chosen existing signed carrier; no new persisted binding.
type PersistentSessionRuntimePrincipalV1 = Readonly<{
  v: 1;
  accountId: string; // requester and Session owner
  sessionId: string;
  machineId: string;
  installationId: string;
  installationPublicKey: string;
  tokenEpoch: number; // existing Account epoch, not a new runtime revocation epoch
}>;
// Nonsecret process adoption attribution, stamped from admitted launch context.
type RequesterWorkAttributionV1 = Readonly<{
  serverId: string;
  accountId: string;
  machineId: string;
  installationId: string;
}>;
type RequesterSessionCredentialDisposition =
  | { kind: 'session_scoped' }
  | { kind: 'ordinary_requester'; basis: 'documented_d3_fallback' };
type MachineWorkSummaryV1 =
  | Readonly<{ kind: 'current'; requesters: readonly Readonly<{
      accountId: string;
      displayName: string;
      sessions: number;
      tasks: number;
      terminals: number;
    }>[] }>
  | Readonly<{ kind: 'unavailable' }>;
```

Private bearer/key/configuration is separate from the safe disposition; never embed it in this public schema or Action
output. Counts are nonnegative integers under actual existing inventory scale; no new artificial top-N requester cap or
pagination loss. Identity presentation can use existing admitted Account display/avatar reference shape when available,
with no arbitrary private-profile bag. `kind:current` is actual current observation, including valid empty; unavailable
has no count.

**AccessKey model migration:** replace only its Machine composite FK with `Machine(id)` FK, leaving `accountId` Account
relation, `sessionId`, `(accountId,machineId,sessionId)` unique tuple and encrypted data/version semantics. Existing
rows need no account rewrite. Source models `apps/server/prisma/schema.prisma`, `prisma/sqlite/schema.prisma`,
`prisma/mysql/schema.prisma` sync through canonical schema generator. All deletion/invalidation queries derive custodian
from Machine and requester from AccessKey/Session, not assumed equality. Member grant and current installation are
rechecked in the owning transaction/effect boundary. FK change alone is insufficient without all read/write/erase paths.

Future migration editing follows Server/Stack instructions: classify released history; sync provider-specific SQL/client
schemas; real data/FK tests; automatically reconcile applied unpublished current-checkout migrations in place, semantic
schema comparison and deploy twice. No current DB mutation is authorized by this draft authoring step.

**Credential design discretion:** prefer the existing server-mints Session/restricted principal seam. Characterize both
Runner extraction and current attenuated API-token capability without building two issuers. The selected carrier must
bind exact requester Session and current Machine installation/grant; allow only required persistent runtime operations,
keep private material per Session process, and invalidate on requester status/token epoch, Session deletion,
installation replacement, Machine revoke or access loss. Preserve Runner activation checks at their owner. NEW
constrained helper if extraction is needed: `apps/server/sources/app/auth/persistentSessionRuntimePrincipal.ts`; its
internal binding is not a public token authoring API.

The existing currentness pattern is
`apps/server/sources/app/ephemeralRunner/materializedRunnerPrincipalCurrentness.ts#verifyCurrentMaterializedRunnerPrincipalInTx`:
derive requester status/epoch, exact Session ownership, Machine installation/key and AccessKey from their existing records,
then compose 41's current grant. Extract those genuine shared checks while retaining Runner activation/kind restrictions
in the Runner wrapper. The private type above represents verified signed claims; add no binding row/file, token-epoch
owner or revocation store. Existing issuer credential custody and expiry remain at the chosen issuer. D3 route sufficiency
must still be characterized; these existing facts do not make the current Runner credential a persistent runtime credential.

Before implementation selection, trace actual host bootstrap, Session create/read/update, pending
claim/materialization/ack, transcript/message append/read, metadata/agent-state/lifecycle, tool/approval result,
reconnect, and scoped Machine/root/tool-install reads. Add precisely required route support at existing guards, not an
open Account permission. Global settings/KV/secret catalog, unrelated Sessions/Machines, grant administration, provider
spend and broad Account token mint must reject the runtime principal. Existing Session tool/PromptDoc/role/profile
inputs use narrow prepared host services or already admitted material; do not silently grant entire private libraries to
make a tool work.

The same authority census includes Machine-placement starts: `mcp/runtime/createSessionAccountActionExecutor.ts`
currently routes these to its base executor. Extend that canonical router and the reached spawn/execution-run/workflow
RPC start handlers with the authenticated requester and admitted policy snapshot. `session.spawn_new`,
`execution.run.start` / `execution_run_control` and `workflow.run.start` must recheck requester Home/Account and
`admitAgentStartV1` for the actual target; unsupported requester execution returns typed refusal. The custodian daemon's
unchecked global Account credential never creates the resulting Session/run.

Protected bootstrap uses existing exact Machine/signed installation/V2/AccessKey carriers, containing only
Session-specific key/configuration and private credential references. The custodian Machine-profile socket does not gain
general Bob Session API authority by holding a foreign AccessKey; Bob's runtime authenticates as Bob's exact scoped
Session principal. Own interactive Bob client retains normal server-history auth independent of Machine access.

**D3 fallback:** only if this route characterization demonstrates disproportionate adaptation, document the required
calls and machinery avoided in the existing 42s1 execution evidence, select ordinary Bob credential per Session in
current protected/private file owner and present full-sign-in disclosure before launch. This is authorized within D3, no
extra re-ratification required. It is never a runtime catch/fallback on unavailable scope, never Alice's credential,
never daemon global auth, and not authorization for arbitrary provider guest enrollment exposure. A materially broader
topology/exposure stops for human decision.

**Runtime routes/events:** reuse ordinary `session.spawn_new`, Session API/socket and pending activation/handoff paths,
extending their strict target/binding/schema at current owners. No new shared-session API family or event stream.
Existing lifecycle/AccountChange/Session/operation snapshots remain authoritative. Extend nonsecret
marker/start/recovery attribution at real launch owner; unknown old marker attribution remains unavailable until
existing adoption proves it.

**Summary:** NEW `packages/protocol/src/machines/machineWorkSummaryV1.ts`, NEW CLI projection
`apps/cli/src/daemon/machines/machineWorkSummary.ts`, a closed `machines.work.summary.get` handler registered at the
normal Machine RPC owner. Server/daemon consume 41's current owner-or-Manage admission and exact installation; there is
no second equality-only check. Read only 52s1's `daemon/lifecycle/managedActivity.ts#readLiveWorkInventory` internal
producer; that producer composes the real tracked Sessions, verified process adoption, operation store and
PTY/service/transfer owners once. This projection must not enumerate those registries independently. NEW UI
`components/settings/machines/MachineWorkSummarySection.tsx` reads that safe DTO only, mounted beside 41 Sharing, 30
worker policy and 52 managed controls in existing `app/(app)/machine/[id]/index.tsx#MachineDetailScreen`. No persisted
counts/table, new owner-wide Session list, history query or public operation cross-account bypass.

Summary uses the inventory's real internal operation/terminal association from 21 (never command-text matching). It
counts active accepted finite operations once, excludes task PTY from standalone terminals and excludes settled
output/history; service/transfer/setup categories contribute to retention but are not added to D8's three public count
columns. Unknown relevant inventory coverage, attribution or liveness returns unavailable, not zero. 52's retention
decision and this privacy-filtered projection consume the same internal inventory; the public count DTO cannot supply
idle truth because it deliberately omits categories, references and settled facts.

The `tasks` field is the active-work column: it includes attributed execution/workflow work as well as finite scripts,
with operation/PTYS deduplicated. The combined Machine summary is “In use by others · 3 active”, using the same three numeric fields.
UI/CLI/Voice breakdowns follow INT I3: sessions are sessions, Project scripts are scripts, workflow/background runs are runs.
No fourth category, human to-do or foreign title is exposed.

**Wake:** 42s2 supplies exact non-content Session/Machine/requester-authorized target facts to existing pending target
recovery; 52s2 owns controller/resource power. Controller receives no prompt/title/transcript/Session DEK/Bob bearer.
Resume stays on same admitted Session/native identity/resource; withdraw uses canonical pending custody, not new
queue/replay.

### Current policy and owner decisions

Consume [index](../teams-lane-12-managed-environments-and-workspaces.md) §Outcome and binding decisions (D18/D19/D20/D24) and 41’s single access/disclosure owner. D3 scoped-first/conditional fallback and D8 content-free counts remain local obligations; this plan adds no consumer-local Machine policy or disclosure acknowledgement.

## 6. Actions (D16)

| Action / reuse | Input → output / authority | Safety, default, surfaces |
| --- | --- | --- |
| `session.spawn_new` EXTEND | Incumbent strict spawn target/Agent/workspace/config → current acceptance/Session result with actual safe credential disposition | Preserve danger/Ask first and existing Agent/setup approvals; UI/CLI/agent/MCP/eligible Voice. Target admission is 41; resource acquire is 50. |
| `session.message.send`, `session.stop` and incumbent resume lifecycle EXTEND | Exact own Session/current target → normal pending/accepted/settled outcomes | Existing policy remains; consequential execution/stop Ask first where current spec requires. All eligible existing surfaces; no shared aliases. |
| `session.list`, `session.open` REUSE | Requester's ordinary own-history/address → existing list/navigation | Existing safe policy; shared Machine revoke does not remove independent server-history rights. Client navigation needs actual answering UI. |
| `session.handoff` + existing status/prepare/commit/abort family EXTEND | Exact Session/source/destination and reviewed current basis → incumbent handoff states | Existing danger/approval, all supported domain surfaces; no privileged move when source no longer admitted. |
| `action.operations.list/get/cancel` CONSUME `21` | Requester-qualified operation → own snapshot/output/cancel | Existing safe read/danger cancel policy; never use as foreign summary endpoint. |
| `machines.work.summary.get` NEW | Qualified Machine → strict `MachineWorkSummaryV1` or current typed denied/unavailable | Safe read, Machine placement, owner-or-Manage; UI/CLI/agent/MCP/voice. Output contains no work ids/content. |
| `machines.access.grants.list`, `machines.access.leave`, `machines.access.prepareKeys` CONSUME `41` | Exact own Machine access → same grant/readiness/recovery outcomes | Same specs/defaults; no duplicate recovery Action. |
| `session.pending.withdraw` CONSUME `52` only if incumbent public equivalent absent | Exact accepted input/current custody → normal withdrawn/consumed/unknown/draft recovery | Existing pending policy; not a new 42 message queue or an agent self-approval. |

Canonical specs/DTOs derive from the existing Action schema/SDK generator. Summary extends 41's Machine domain spec
owner, not a new registry. Refresh repeats the read; real Session/Machine/settings navigation uses concrete admitted
navigation. Details disclosure/Back/help/focus remain local presentation, not generic mounted callbacks or fictitious
CLI Use. Spawn/summary/input business operations require actual eligible handlers. 71 proves advertised tool, approval
and outcome including Voice.

Danger defaults are visible/changeable in Settings → Actions through existing policy. A human approves material effects;
Agents may inspect/request but cannot decide their own pending approval. Session sign-in disclosure never weakens other
Action approvals.

## 7. Plugin extensibility

Existing Agent contributions and SDK host services receive admitted Session/bootstrap context;
Session/turn/pending/transcript ownership remains host runtime. No new Bot/shared-Session/credential/count contribution
family, raw principal/bearer/key export, whole-metadata writer, provider-owned lifecycle or `RuntimeCoreV1` consumer.
`60/61/62` consume ordinary Session identity/access and keep private prompt/voice facts under their canonical owners.

Plugins can use safe `machines.work.summary.get` and ordinary Session Actions through current Host API/SDK-generated
DTOs. Public UI `@happier-dev/plugin-ui` row/avatar/state/freshness primitives render the safe facts; new domain count
section contains no generic primitive implementation. `70` owns any missing neutral presentation export co-landed with
real consumer. Third-party fixture must reject raw runtime-binding fields supplied as author input and cannot read
another person's Session from Machine Manage.

## 8. UI composition, motion and performance

Existing composer `AgentInput` → shared target facts → one `RequesterMachineDisclosure` domain composition (NEW within
`components/sessions/new/components/`) → incumbent pending launch preview/ordinary Send. Scoped/full-sign-in sentence is
selected by actual accepted host credential preparation, not provider id or a preference. The strip links to existing
help and follows shared note/typography tokens; no bespoke banner engine.

Existing Machine detail → NEW `MachineWorkSummarySection` → `ItemGroup` title/description → `Item` person Avatar/display
name + short tabular count line. Section-local loading/unavailable uses `SurfaceStateCard size="line"`; refreshing uses
one `SurfaceFreshnessLine` and last-known rows explicitly stale. Foreign row does not have chevron/content detail.
Requester's normal Session page continues using current transcript/runtime and terminal views.

Use `HAPPIER_PAGE_METRICS` 52/40 row density and 28px section gap through app aliases, reconciling lab illustrative
56/48/30 values as 41 §8. Phone wider counts wrap beneath label; preserve safe-area/composer/keyboard space.
`motionTokens` disclosure/popover/press feedback supplies all timing; summary refresh/count change is immediate and
cannot replay prototype progress. Reduced motion removes motion. No global Account subscription/polling loop for this
section; use exact Machine/readiness/liveness invalidations and current mounted read owner. Measure section/destination
rerenders at integration; do not add cache/counter service or blanket memoization without measured need.

## 9. Lifecycle, failure, cancellation and recovery

Create/rejoin occurs at normal Session owner → admitted exact Machine AccessKey → scoped bootstrap prepared → existing
daemon host spawn → actual Session/native accepted state. Refused root/grant/credentials/setup leaves current draft and
no launched process; failed setup blocks Agent unless explicit one-invocation skip from 20. Definitive no-acceptance may
retry under normal currentness; uncertain acceptance observes same Session/target, not a new tag/native session.

Per-Session private credential custody follows existing private materialization owner and process cleanup;
runtime/reconnect rechecks requester epoch/status, Session, Machine installation and current use. Persist only safe
marker attribution/credential reference as existing respawn requires; never raw bearer in markers/metadata/logs. Server
denial after revoke does not prevent Bob's ordinary own-history reader. Any D3 full credential copy has actual private
lifetime and cleanup disclosed, with no promise to retract material an OS administrator copied.

Machine replacement/revoke invalidates affected runtime sockets/AccessKeys across requester Accounts using existing
after-transaction room owners. Session deletion/Account erase removes that requester's tuples/material under existing
owner policies without accidentally erasing custodian Machine or another requester's history. Retained managed resource
cleanup belongs E. Overlapping grant changes recompute effective access before declaring loss.

`41` §5 D19 governs cancellation of this requester's accepted Session runtime, queued/preparing launch and pending
consumption; effective overlap is checked before stopping. Delegate to
`daemon/sessions/stopSession.ts#createStopSession` through the existing daemon stopSession composition and observe
`StopSessionResult`, not socket disappearance. Direct/inherited Leave consumes settled PD-LEAVE. Handoff retains normal
source/target/rollback expectations; lacking source authority is refusal, not automatic grant bypass. Shared pending
wake uses current non-content authorization, same resource/controller and same Session/native id; unknown provider
start/resume is observed, never recreated. Controller offline remains pending without failover;
read/list/summary/pin/Talk/Watch do not wake.

Summary observes current real process/runtime facts; exit/cancel settlement removes active count, kept output does not.
Recovered markers require existing process identity/adoption proof and admitted attribution. Missing liveness or
attribution yields unavailable. Count is not a kill switch, inactivity proof, subscription grant or historical audit
log.

## 10. Compatibility

Observed prospective sibling HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`; focused Machine key/API/schema/route/UI
encryption status empty. Its actual `apps/server/prisma/schema.prisma:1146` AccessKey has the same requester+Machine
composite FK and `(accountId,machineId,sessionId)` uniqueness. That tuple and persistent Machine data remain prospective
inputs; implementation 42s1 must inspect actual sibling AccessKey/auth/session marker/create/read/erase paths including
dirty bytes, rather than claiming the earlier focused status covered them. Resolve any released immutable
producer/artifact basis that creates additional data obligations; source tags alone are not deployment proof.

Required data direction: old same-owner AccessKey rows and Session history/native identity/markers → current canonical
readers after FK migration. Account remains Session requester; no rewriting to custodian, duplicate correspondence or
broad compatibility schema. Old marker missing requester is not asserted to belong to another account; existing verified
adoption can enrich it, otherwise summary unavailable. Legacy encryption behavior remains 40-owned.

All-component one-way 0.3 ruling permits unreleased foreign AccessKey/runtime binding refactors in place; no persistent
old-0.3 auth/dual-writer/rollback infrastructure. New shared runtime objects are closed and unavailable if unsupported,
not ignored as successful ordinary auth. Preserve actual ephemeral Runner activation principal negative/currentness
tests; persistent sharing cannot relabel an ordinary Machine as Runner.

Implementation updates `docs/encryption.md` credential/Session-Machine custody and `docs/compatibility.md` FK/marker
data transition; update existing public sharing/Session continuation page after reading Docs instructions.
`docs/runtime-core.md` owns Session lifecycle; this plan references rather than duplicates that architecture.
Runtime/SDK/Agent implementers read current package instructions and canonical runtime/plugin/Agent docs before editing;
this draft changes none of them.

## 11. Slices in order

**Stored-reader checks:** 42s1 keeps AccessKey constraints at the DB owner; 42s2’s actual JSON attribution/recovery reader owns extras and canonical marker-write proof. Signed principal inputs stay strict. Shared doctrine and helper tests live in [index](../teams-lane-12-managed-environments-and-workspaces.md) §Stored contracts.

### 42s1 — Foreign AccessKey and smallest proven runtime credential

**Consumed seam:** `admitAgentStartV1` — ORC PLAN §3.4 / INT PLAN §3 agent-start row; host-stamped requester/depth
and current target facts decide admission, never custodian settings or Machine visibility alone.

**Requester admission prerequisite:** consume 20/24's approving-user trust and ORC's canonical `admitAgentStartV1`
policy, prompt/Role/profile/Agent facts at their existing owners. Accepted input carries the requester's resolved policy
facts and current Machine admission, not Alice's daemon Account settings re-resolution. Consume 30s2 purpose-qualified
target projection, with exact shared Session/finite/service targets and explicit owner-only
workflow/trigger/background-worker/Board selector reasons; no shadow picker. The scoped-first D3 decision still requires
characterization of success/failure/cancel/recovery at the real protected Session routes. Shared-enable proof uses D24 API non-disclosure and pre-grant exposure
disclosure; AccessKey/Machine DEK is not same-user OS isolation.

Consumes 41s1/s2 and existing auth/Session create/read/currentness; provides RS-R1/R2 and safe credential disposition.
Touch AccessKey model/migrations/provider schemas, mutation/routes/availability/socket/erase/revoke consumers, normal
Session create/rejoin and existing auth materialization/currentness. Add NEW `persistentSessionRuntimePrincipal.ts` only
if actual extraction is needed. Select one scoped carrier from real route evidence; D3 fallback is available only under
its named empirical condition.

**RED:** `apps/server/sources/app/accessKeys/sessionMachineAccessKeyMutations.sqlite.integration.spec.ts`, using actual
`createLightSqliteHarness` and mutation service, creates Bob Session/Alice Machine tuple and must read/update/revoke
correctly while rejecting Cara and preserving same-owner rows/data versions. Existing
`apps/server/sources/app/api/routes/accessKeys/accessKeysRoutes.get.spec.ts`, `accessKeysRoutes.post.spec.ts`,
`accessKeysRoutes.put.spec.ts` and
`apps/server/sources/app/api/socket/accessKeyHandler.currentness.sqlite.integration.spec.ts` cover reached route/room
changes; no mock of Machine admission.

Credential RED: extend
`apps/server/sources/app/ephemeralRunner/materializedRunnerPrincipalCurrentness.sqlite.integration.spec.ts` for
unchanged Runner guarantees and NEW adjacent auth `persistentSessionRuntimePrincipal.sqlite.integration.spec.ts` for
selected actual persistent issuer/verifier. Authenticate real required runtime Session
read/write/pending/transcript/tool paths, then prove settings/KV/secret catalog/other Session/grant/token admin fail.
Revoked grant, changed installation, requester token epoch/status, deleted Session and expired existing-issuer
credential refuse. Do not use an invented expiration default. Boundary fixtures are real DB/socket/network/clock as
needed; actual principal/route guards stay real.

**GREEN and completion:** FK and every current tuple lifecycle consumer migrate; exact Session/installation/current use and
negative unrelated-route evidence decides carrier. If fallback selected, record exact
characterization/cost/custody/disclosure in this execution area, not a new ledger, and run actual ordinary requester
bootstrap negatives appropriate to its explicitly broader credential (do not falsely claim it rejects Account-wide API
calls). No automatic fallback or custodian replacement remains. Run provider schema/migration/FK/reconciliation and adjacent auth/AccessKey/Session-create checks; package/generator checks follow the index integration rule. Can
characterize auth/tests in parallel with 41s2; foreign execution cannot enable until 41s2 complete.

### 42s2 — Same requester Session through launch and recovery

The existing `mcp/runtime/createSessionAccountActionExecutor.ts#createSessionAccountActionExecutor` and
`daemon/agentRuntime/createDaemonSessionAccountActionExecutor.ts#createDaemonSessionAccountActionExecutor` remain
canonical routing/auth boundaries. `api/machine/rpcHandlers.ts#registerMachineRpcHandlers`,
`rpc/handlers/executionRuns/registerExecutionRunRpcHandlers.ts#registerExecutionRunRpcHandlers` and
`rpc/handlers/registerActionSpecRpcHandlers.ts` are reached Machine start consumers; migrate or refuse them
under the same requester admission, rather than protecting Account placement alone.

**Consumed seams:** `admitAgentStartV1` — ORC PLAN §3.4 / INT PLAN §3 agent-start row, requester policy before
Machine-placement starts; WorkerUpdate/host context — ORC PLAN §3.2 and INT PLAN §3 context-slot row, runtime-derived
delivery is not a server wake producer; FIN finalization `03-account-actions-library-and-live-state.md` §6.5,
committed delivery retains its origin/requester rather than adopting the executing daemon's Account.

**Requester-owned launch cut:** extend `daemon/agentRuntime/createDaemonSessionAccountActionExecutor.ts` at its current
Account-action boundary: qualify requester Home/Account and runtime `isCurrent`; refuse foreign Account Actions unless
an already-authorized requester key-holder channel can actually execute them. Never reuse daemon Alice auth for Bob.
Extend `daemon/spawn/prepareDaemonConnectedServices.ts` and
`daemon/connectedServices/materialize/materializeQualifiedConnectedAccountLaunchUses.ts` to consume requester's
qualified selected account/purpose and existing materialization/refresh owner; do not substitute native Alice
`~/.claude`/`~/.codex` login. No owner-funded fallback is implied by D3; any separately authorized opt-in retains
explicit policy/custody.

**Subscription custody:** extend `resolveConnectedServiceAuthForSpawn.ts#resolveConnectedServiceAuthForSpawn`,
`prepareDaemonConnectedServices.ts#prepareDaemonConnectedServices` and
`materializeQualifiedConnectedAccountLaunchUses.ts#materializeQualifiedConnectedAccountLaunchUses` at their existing
qualified purpose/subject boundary. The Session runtime principal and the native Agent subscription are separate
subjects. Retain requester Home/Account, selected qualified account/purpose and actual native subscription/billing
subject through materialization, group switch, reconnect and resume; a Team selection follows the existing direct or
brokered `TeamResourceConnectedServiceSelectionV2Schema` grant/purpose path. Brokered selection never becomes a copied
owner credential, and a requester-authorized Team subscription bills that selected subscription, not the Machine
custodian by default. Native account identity/usage proves the billing subject; safe markers contain references only.

`ConnectedServiceRefreshCoordinator.ts#ConnectedServiceRefreshCoordinator` owns refresh and group-switch lifetime.
Bind its spawn target/currentness and recovered selections to that same requester selection; refresh/repair/switch
cannot use Alice's native login or token. Consume the access-only child projection at
`packages/plugins/codex/src/agent/auth/services/openai/cloud/authFile.ts#buildCodexCloudAuthFile`: child auth carries
access material with empty refresh-token fields, while canonical refresh authority stays with the host coordinator.
Other Agents use their declared auth-materialization boundary with the same host-owned rotation rule. Final grant,
Team membership, account or purpose loss retires refresh/materialization and reached runtime work through 41/42;
remaining effective grants preserve it. 52s2 resume and 60s2 Bot launch/recovery consume this complete 42s2 output.

**Machine-placement authority RED:** extend `apiMachine.spawnSession.runtimeCatalog.integration.test.ts` and the
existing `rpc/handlers/executionRuns.test.ts` and `workflowActionRpcTransport.test.ts` using the real session Action
router, `api/machine/rpcHandlers.ts#registerMachineRpcHandlers`,
`rpc/handlers/executionRuns/registerExecutionRunRpcHandlers.ts#registerExecutionRunRpcHandlers` and the actual
workflow Action RPC dispatcher/admission owner:
Bob's agent on Alice's daemon starts a Bob-owned Session/run/workflow with Bob's depth/policy or gets typed refusal.
Alice-owned output, owner-funded fallback, a retired caller or bypass of target-machine admission fails the test.

**Composed subscription RED:** at `apiMachine.spawnSession.runtimeCatalog.integration.test.ts`, with the real
`ConnectedServiceRefreshCoordinator.qualifiedRefresh.test.ts` owner fixtures, exercise start → refresh/group switch →
disconnect/reconnect/resume → final revoke. Use distinct Alice/Bob subscriptions plus Team direct and brokered
selections: the effective native account/billing subject and access-only child projection remain requester-selected
at every stage; retired refresh cannot reinstall material or resume work. Bob's disclosure reflects the actual
materialized purposes for scoped and fallback Happier access. Mock vendor/network/OS only, not selection, coordinator,
materialization, admission or billing-subject projection.

Stamp one RequesterWorkAttributionV1 through finite/service/PTY/Session producers, distinct from ORC origin/depth and
the existing FIN origin work reference. Ordinary nonzero exit observed by an Agent/workflow does not itself require user
attention; existing Inbox selector owns grouping/needs-you. Inventory and carry requester/origin facts through real
execution.run start/delivery, WorkerUpdate/context slots, workflow/trigger continuations,
queued/preparing/reconnect/handoff paths and ordinary runtime launch. ORC owns prompt admission/origin, not a second
attribution lifecycle. RED runs Bob bootstrap with different Bob/Alice deny ceiling/profile/purpose selection: Bob's
actual launch policy/credential wins, native-owner fallback and foreign Account read/write refuse, retired runtime
currentness prevents refresh/effect. Final membership union loss cancels existing owners and preview/token streams;
overlap preserves work. Network/process/DB/native boundaries only mocked.

Consumes 42s1, current ordinary host lifecycle, 41s3 terminal/root context and accepted Session target; provides
RS-R3/I1/I2/I4 to shared workers, Bots and 52 non-content wake. Touch `ApiMachineClient` spawn/Session bootstrap,
current daemon start/tracking/marker/respawn, pending authorization/recovery/handoff/socket consumers, new-Session
disclosure/pending preview/navigation/i18n and relevant docs.

**RED:** `apps/cli/src/api/apiMachine.spawnSession.runtimeCatalog.integration.test.ts` runs Bob accepted bootstrap on
Alice exact installation using real internal launch/runtime composition; transcript/message/tool response remains Bob's
same Session/native id, daemon global auth stays Alice. Network/OS process boundaries only. Existing
`daemon/sessions/activatePendingInactiveSession.test.ts`, `pendingSessionActivationRecovery.test.ts`, Server
`session/pending/pendingActivationAuthorization.spec.ts` add foreign target currentness: grant revoked before pending
consumption refuses; accepted unknown launch does not respawn under new target/id; controller routing sees no
prompt/key/bearer. Existing handoff composition tests assert inaccessible source is refused rather than privileged move.

UI `navigation/presentCreatedNewSession.currentness.test.ts` and NEW disclosure composition test under `@/dev/testkit`
assert async target/Home change cannot route stale result or lose draft; actual credential disposition selects truthful
disclosure; refused/unknown preserves ordinary authoring. Current UI Action/settings policy handles approval, not a
mocked internal seed/currentness function.

**GREEN and completion:** start/message/tool/transcript/reconnect/resume/pending/handoff retain requester and exact native
identity; all bootstrap/respawn/private materialization paths migrated; no copied Account settings, global Bob
credential or shared Session runtime. Compose 52 wake only when its real resource/controller producer exists; this slice
provides non-content facts without designing its power policy. Run adjacent normal Session/pending/handoff suites; package checks follow the index integration rule; live §12 segment observes actual cross-account process/runtime. Can
prepare UI/recovery alongside 42s1; enabling effect requires s1 proof and 41 current access.

### 42s3 — Owner-or-Manage live counts without content

**Consumed seams:** `resolveWorkStatusTone` and work glossary — INT PLAN §3 I3; current run counts do not mean idle
or require fetching private work. ORC PLAN §3.2 Inbox owns needs-you grouping, not this content-free summary.

**Work-summary producer closure:** 52s1's sole inventory must compose `daemon/executionRunRegistry.ts`,
`daemon/automation/automationWorker.ts#startAutomationWorker` (`activeExecutions`/claim loop) and
`daemon/executionBudget/ExecutionBudgetRegistry.ts#tryAcquireExecutionRun` with coordinator/in-flight leaves plus
pending background runs, in addition to existing
Sessions/operations/PTYS/services/transfers. Publish content-free requester identities and numeric active-work counts only
where actual attribution/liveness exists; finite/execution/workflow work maps to the `tasks` numeric active-work column with
operation/PTYS deduplicated. Unknown material attribution/coverage is unavailable, never invented zero. RED includes no
Session/PTYS but an active execution run/workflow claim, plus a parked claim released by the actual worker: correct
count/busy and privacy projection, no title/prompt/native-thread/claim payload; 42s3 never independently enumerates
registries.

Consumes 42s2 real requester attribution, 41s3 PTY ownership, 21 early script↔terminal association and **52s1's produced
`LiveWorkInventoryV1` in W3**; provides RS-R4/I3/I4. Touch NEW `machines/machineWorkSummaryV1.ts`, CLI
`daemon/machines/machineWorkSummary.ts`, normal Machine RPC/spec/executor registration, NEW UI
`MachineWorkSummarySection.tsx` and actual Machine detail mount. The richer producer is 52-owned; no second census or
direct registry reads in this projection.

**RED:** NEW `apps/cli/src/daemon/machines/machineWorkSummary.test.ts` consumes real `readLiveWorkInventory` over
existing registries/operation store/PTY accounting with only OS liveness mocked: Bob live Session,
queued/preparing/running script, linked task PTY and standalone shell yield correct categories; task PTY not doubled;
real exit/settlement removes active count while output retained; missing attribution/adoption/liveness returns
unavailable, not zero. Add a service/transfer-only case: retention remains busy but the public three-category counts are
empty, proving both consumers share the same richer producer without using public counts as idle evidence. Strict
serialization with inserted title/command/path/session/operation/terminal ids must reject or never admit those fields.
Existing `daemon/sessionRegistry.test.ts`, `actionOperations/actionOperationStore.test.ts` and PTY suites supply actual
lifecycle fixtures, not mocked projections.

Server/daemon action integration proves owner and current Manage can read, Use-only recipient/Cara cannot, and no
private Session/operation API is opened. NEW UI `MachineWorkSummarySection.test.tsx` uses real safe DTO logic and
canonical boundary testkit: current empty differs from unavailable/offline, stale row is not fresh, count row cannot
navigate foreign content. Action catalog→advertised tool→actual owner-or-Manage summary tested through
CLI/agent/MCP/voice.

**GREEN and completion:** all live launch/recovery attribution producers proved, summary schema has only approved
identities/categories/currentness, every mounted host reads same safe Action, no separate census/counts persistence or
foreign content fetch. E idle/drain and summary use the same richer inventory, with independent privacy projection.
Run adjacent lifecycle/process/Action suites and §12’s live/privacy segment; package/generated checks follow the index integration rule. UI/DTO test preparation can run alongside s2; completion waits 52s1 in W3 and
cannot claim zero from unproven attribution producers.

Validation/commands follow [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence, once at the coherent 40–42 boundary; no runtime validation pass is claimed here.

**D19 RED (42s2):** extend `apps/cli/src/api/apiMachine.spawnSession.runtimeCatalog.integration.test.ts`,
`apps/cli/src/daemon/sessions/stopSession.test.ts` and the existing pending activation/recovery suites through real
launch/stop/access owners: remove last grant during a running requester Session → physical runtime stop/incomplete
result is observed, queued/preparing/pending work cannot start/consume later, while its server Session/key/history and
unrelated runtimes survive. Repeat with another valid grant → no runtime stop/invalidation. Offline/unconfirmed stop
remains pending/incomplete and the existing recovery stops the same runtime before renewed target effects; never delete
the Session to stop it.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 42s1 | IMPLEMENTED (focused GREEN) | `a43ce2034d`, `646b36d73c`, `1a99f1349a` | [C42](../../reviews/2026-10-02-lane12-replan/impl-C/C42.md) records real AccessKey/ingress checks and the deciding D3 crypto characterization: fixed ordinary-requester Account-wide sign-in, not a Session-scoped credential or runtime fallback. | Common gate; retained same-owner AccessKey data/FKs and private per-Session custody/disclosure. Do not claim this selected Account-wide bearer denies unrelated Account APIs. | Native private-file cleanup/credential custody; real vendor subscription/billing subjects, physical devices and signing. |
| 42s2 | IMPLEMENTED — open items | `646b36d73c`, `624dbd7df6`, `edb4640ee1`, `1a99f1349a`, `a3a7b70d11`, `f451c4ad5c`, `1122a710fb`, `68d2fb8f9a` | [FX17](../../reviews/2026-10-02-lane12-replan/impl-C/FX17.md) closes [C42](../../reviews/2026-10-02-lane12-replan/impl-C/C42.md)'s exact four-suite requester handback: one remote batch, 4 files/6 tests GREEN on linux2 after valid cold-Profile admission RED and canonical private catalog hydration; stale Profile revision, lost admission, private Provider/defaults and custody refusal remain covered. [FX8](../../reviews/2026-10-02-lane12-replan/impl-C/FX8.md), [FX14](../../reviews/2026-10-02-lane12-replan/impl-C/FX14.md) and [FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) close focused finite wake, own handoff/Stop and valid shared-Session Edit recovery defects. | Common gate and corridor B's B7 physical namespace/birth proof (not implemented or certified by FX17); then start→refresh/group-switch→cold reconnect/resume→revoke with the same Session/native identity and truthful D3 disclosure. | Real requester/Team direct and brokered vendor billing; native credential cleanup/platforms, physical devices and signing. |
| 42s3 | IMPLEMENTED (focused GREEN) | `a5683ff2ab`, `624dbd7df6`, `ae8eff41fb`, `e9a3f844cf`, `751f8d9477` | [C42](../../reviews/2026-10-02-lane12-replan/impl-C/C42.md) records safe Action reader/summary evidence; [FX8](../../reviews/2026-10-02-lane12-replan/impl-C/FX8.md) lands the shared live-input inventory producer; [FX11](../../reviews/2026-10-02-lane12-replan/impl-C/FX11.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) confirm active-category sum and privacy presentation. | Common gate; loaded owner/Manage versus Use/unrelated reads, real settlement, unknown attribution, task-PTY dedupe and service/transfer-only busy truth; never infer idle from public counts. | Native liveness/adoption across platforms; physical summary/read surfaces and signing. |

## 12. Requester and work-summary live QA segment

Consume the single composed journey and runtime/release rules in [index](../teams-lane-12-managed-environments-and-workspaces.md) §Integrated implementation evidence. 40/41 own key and sharing/terminal segments; this section owns only requester lifecycle, billing-subject continuity and content-free counts.

Use Bob’s ordinary Session on Alice’s exact admitted Machine/installation, with Cara unrelated, an actual supported Agent/runtime and the accepted shared Project root. Launch with the actual disclosed credential disposition, exchange message/tool/transcript, then disconnect and cold-resume the same Session/native identity. Interrupt accepted launch: observe the same target rather than create a second Session. Change requester epoch, installation or final grant and observe current denial; Bob’s own history remains available. Source-unavailable handoff explains the retained-history alternative without privileged copy.

Run a finite script with its linked PTY and a standalone shell; Alice/current Manage sees Bob identity and numeric categories without title/path/output/work ids, while Bob retains his own content and Cara is denied. Real settlement removes active work without deleting retained output; uncertain liveness/adoption produces unavailable rather than zero. Exercise actual execution/workflow work without Sessions/PTYS, and service/transfer-only activity: the richer 52 inventory remains busy even when the three public categories are empty. Summary/history reads never wake compute.

Start → refresh/group switch → reconnect/resume with distinct requester/custodian subscriptions and selected Team direct/brokered purposes. Verify requester-selected native billing identity and access-only child projection at each reached boundary; retired refresh cannot reinstall material. Use 41s2’s composed access-loss journey with 42s2’s real stop/pending fixtures, rather than another all-owner revoke recipe: final loss stops this runtime and prevents pending consumption, overlap preserves it and history stays owned by Bob.

When 52’s actual resource/controller producer is available, authorized pending input sends non-content wake and resumes that same resource/Session; offline controller, withdraw and refused resume stay truthful. Invoke eligible CLI/agent/MCP/Voice Actions through the existing policy, never cosmetic scope labels. Compare `m-pick S/Sp`, `m-detail A/Ap` and requester disclosure/summary against light/dark/390px references, including focus, retained draft, large text and subscription locality; shared visual doctrine remains in the index.

Completion follows the index integration rule with RS-R1–R4/I1–I4. A foreign FK without full tuple lifecycle, a scoped label without positive/negative route proof, a renderer-redacted summary or a first spawn without cold recovery cannot close this corridor. Independent security/schema/data review remains at the substantial integrated 40–42 boundary.

## 13. Economy notes

No separate shared Session/Bot runtime, fake Runner activation, Session↔Machine correspondence store, redundant
custodian AccessKey identity, generic credential framework, provider guest credential waiver, owner impersonation,
global requester auth, Account settings clone, count/history ledger, timer-based active proof, server wake service,
second pending queue, source-admission bypass or privileged revoke-recovery shortcut. Scoped carrier selection follows
actual existing auth capabilities; D3 fallback follows empirical cost and explicit disclosure. Summary is a projection
and cannot replace actual busy lifecycle facts.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Empirical owner work: **42s1** actual persistent principal/runtime route sufficiency, child API-token reuse versus
Runner extraction, complete AccessKey create/read/erase/revoke census, real provider schema migration and predecessor
data basis; **42s2** per-Session custody/cold resume/native identity/current permission and non-content wake; **42s3**
actual liveness/adoption attribution, task↔PTY dedupe and exact safe wire output. Characterization does not license
omitting required tool/runtime functionality or claiming a broad credential is scoped. If evidence requires materially
wider credential exposure/topology, pause only that affected work for amendment.

Residual risk: real route/principal adaptation
and retained data/lifecycle privacy need the named DB/carrier/process checks; source inspection does not establish
runtime safety or OS credential erasure.

History: see archive-r8.4 and the review folder
