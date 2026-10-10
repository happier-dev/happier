# Lane 12.50 — Managed resources, provider contributions and enrollment

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.8** (D53, 2026-10-09)  
Date: **2026-10-06**  
Plan-writing owner: **PE1**; implementation owner: Lane 12 Machine management corridor. No implementation approval is
recorded.

Supersedes: [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) managed
acquisition/enrollment portions; [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md) the common
provider
seam and Lima. Sharing/key portions move to `40-machine-content-key-lifecycle.md` s1–s3,
`41-machine-sharing-and-project-terminals.md` s1–s3 and `42-requester-sessions-and-work-visibility.md` s1–s3, not here. 
Extends: `25-devcontainer-child-machines.md` s1–s3 with its consumed generic managed-record contract; it remains the
native Docker/namespace owner. 
Consumes: `40-machine-content-key-lifecycle.md` s1–s3 ordinary registration/key adoption;
`41-machine-sharing-and-project-terminals.md` s1–s3 current MachineAdmission;
`42-requester-sessions-and-work-visibility.md` s1–s2 requester Session custody; `23-ordinary-agent-authoring.md` s1–s2
ordinary composer start; `21-finite-project-execution-and-output.md` s1/s3 Action operation/output observation;
`70-shared-ui-and-plugin-presentation.md` s1 shared selection/status anatomy;
`71-action-placement-and-parity-integration.md` s1–s3 approval and answering-surface dispatch. 
Consumes: ORC `.project/plans/2026-09-27-orchestration-workstreams/PLAN.md` §3.4 `admitAgentStartV1`;
INT `.project/plans/2026-09-29-unified-agent-work/PLAN.md` §3 I3 `resolveWorkStatusTone`/glossary;
FIN `.project/plans/automation-workflows-and-steps/finalization/03-account-actions-library-and-live-state.md` §5.3
inline trigger custody. A known Agent-start continuation is admitted before spending; bare compute acquisition needs no Agent-start context.
Provides: 50s1 machineProvisioners/Lima catalog-to-host vertical to `53-local-lume-and-cua-providers.md` s1–s3,
`54-hetzner-digitalocean-and-fly-providers.md` s1–s3, `55-docker-modal-and-crabbox-providers.md` s1–s3,
`56-cua-byoc-and-fleet-providers.md` s1–s2; 50s2 durable row/acquire/enrollment to `51-managed-presets-and-creation.md`
s1–s3, `52-managed-retention-and-wake.md` s1–s3 and `25-devcontainer-child-machines.md` s1–s3; 50s3 pre-enrollment
collection/detail recovery to 51s3 and `60-bots-session-identity-and-pins.md` s2.

Architecture authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,4–10; binding D1–D42 in
`SYNTHESIS.md` §§4–8. `lanes/deep-E.md` is discovery evidence, not a shipped-contract claim. Proposed symbols below are
**NEW** unless listed in the observed map. The umbrella remains the sole program status/QA pointer.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE1 names the managed-resource core plan-writing lane (plans 50–52).
- EC is the Account settings entity-catalog plan at `../2026-10-06-account-settings-entity-catalogs/PLAN.md`; S-number references name its slices.
- B25 refers to plan 25, Devcontainer child Machines.
- PTY means pseudoterminal; PTYS refers to pseudoterminal sessions.
- DTO means data transfer object; CAS means compare-and-set.

## 1. Outcome and user value

Users can create compute from a contributed provider, observe it before Happier joins, recover a failed install on that
same resource, and then use it as an ordinary Machine. Lima is the first real provisioner/public SDK consumer;
Hetzner 54s1 is the next cloud reference on the roadmap, not a prerequisite for independent leaves; adding another native leaf does not require another
loader, lifecycle owner or viewer.

- **MR-R1:** an admitted allocation has one durable managed id before any external effect; uncertain acquisition stays discoverable after Action/UI loss.
- **MR-R2:** allocation, installation, enrollment, daemon connectivity and workspace readiness are separate observed facts. Retry install never purchases again.
- **MR-R3:** exact Home, custodian, authenticated Action requester and controller installation survive every route. The resource custodian owns the provider
  credential; current Manage authorizes its use/spend through 41 without transferring custody or permitting credential/key reads. A plugin cannot mint that
  authority. An eventual Session requester belongs to 42's ordinary Session binding, not another resource Account identity.
- **MR-R4:** canceled/replaced enrollment cannot attach a late Machine or start a stale composer; possible late resources retain cleanup custody.
- **MR-R5:** all offered business operations have one Action contract with normal approval and applicable UI/CLI/Agent/MCP/Voice dispatch.
- **MR-R6:** the first-party Lima leaf and a public-only custom author fixture both reach the real host consumer; Stack's corresponding native implementation
  is contracted atomically.

Lab basis: final lab `.happier/design-lab/lane12-final/` (D27): `m-add A/Ap`, `m-pick A/Ap/Aprog/W/Wp`, `m-life A`;
creation/detail configuration is 51. Retain `m-life A` waiting-controller, acquisition-off, removed-plugin, unknown provisioner and
incomplete-cleanup cells. Do not copy demo timers as lifecycle evidence.

## 2. User-facing flows, navigation and copy

Desktop: Settings → Machines → existing Add route → Create one → provisioner → 51 configurator → reviewed Create → managed
detail. Before enrollment the detail is addressed by managed id, not an invented Machine id. Machines rail and Activity
can reopen progress. After verified registration, Open Machine uses the ordinary enrolled destination. Existing This
computer / Over SSH / Another computer paths stay at their current owners.

52's reviewed Archive/Hide removes a row from the active list while preserving an authorized archived-list/get entry
for recovery, possible cost and pending native handles. It never marks the resource absent or releases optional capacity.

Phone/browser: Connect | Create segmented entry; select a remote controller by its identity rather than treating the
viewing device as the executor. Provisioner push rows → same configuration → progress/detail push. Back restores collection
search/selection or composer text and caret; Back/Close never cancels paid work. Cancel explicitly calls the
cancellation Action and shows resulting cleanup disposition.

CLI/Agent/MCP/Voice: discover providers and options, invoke acquire with reviewed inputs, receive `{managedId,
operation}` promptly, then inspect by id. Generated CLI arguments/SDK DTOs derive from the same Action schemas.
Operations targeted to a daemon work without a mounted app; concrete app navigation needs an answering client;
focus/clipboard/disclosure are local presentation, not a generic callback bus. A spoken or scripted request cannot
decide its own human approval.

Composer: choosing a preset/one-off prepares a draft target only. Explicit Send/Create plus normal acquire approval
admits allocation. During create/install/join the original text, options, Home and start intent remain with ordinary
composer custody. Changed Home/target or canceled start retires continuation; resource cleanup remains managed-owner
work. 51s3 owns the UI transaction; 23 owns the ordinary Session start, and 42 owns shared requester credentials.

50s3 and 52s2 project one managed-progress `AgentInputStatusBadge` kind through
`components/sessions/agentInput/agentInputContracts.ts`, `AgentInput` and `instrumentStrip/SessionInstrumentStrip.tsx`.
Creation/wake observations supply its label/tone and existing `renderPopover` observed-stage details; no second composer strip or progress lifecycle.
Extend the existing composer/strip host tests at 50s3: only observed stages advance, draft/current target survive failure/Back,
and choosing/closing the badge neither allocates nor starts a Machine. Phone uses the same badge's sheet/focus owner.

Proposed host English keys under existing `sources/text/translations/*` (reuse common Retry/Cancel/Back/Delete labels
where present; add every new key to all locales):

| Key | English string | State / recovery |
| --- | --- | --- |
| `managedMachines.providers.empty` | “Create a machine with a provisioner plugin.” | Empty; install through existing plugin front door |
| `managedMachines.providers.loading` | “Checking available provisioners…” | Initial loading; retain prior catalog on refresh |
| `managedMachines.providers.unavailable` | “This provisioner can’t create machines here.” | Unsupported platform/prerequisite; contributed repair Action |
| `managedMachines.controller.waiting` | “Waiting for {controller}” | Offline; show controller reason and explicit Cancel |
| `managedMachines.controller.required` | “{controller} manages this machine and needs to be online.” | Detail/controller sheet; never fail over |
| `managedMachines.creation.disabled` | “Creating machines is off.” | Acquisition disabled; existing rows/inspect/cleanup remain |
| `managedMachines.creation.approval` | “Waiting for approval to create {name}.” | Pending approval; no native call yet |
| `managedMachines.creation.create` | “Create machine” | Real allocation stage; provider display noun may specialize |
| `managedMachines.creation.install` | “Install Happier” | Install stage |
| `managedMachines.creation.join` | “Join {home}” | Enrollment stage |
| `managedMachines.creation.messageWaiting` | “Your message waits here until {name} joins.” | Composer admitted continuation only |
| `managedMachines.creation.unknown` | “{name} may already exist. Check before creating another.” | Lost native response; Inspect/console, no replay |
| `managedMachines.creation.installFailed` | “Happier couldn’t install on {name}. Retrying uses this same machine.” | Bound resource; Retry install/Delete |
| `managedMachines.creation.mayBill` | “This resource may still be billed by your provisioner.” | Possible allocation/cleanup; billing facts may refine |
| `managedMachines.creation.canceledCleanup` | “Creation canceled. Cleanup is still pending.” | Late allocation/delete incomplete |
| `managedMachines.creation.enrollmentRefused` | “This machine couldn’t join {home}. Review its connection.” | Wrong/retired Home, resource or attempt |
| `managedMachines.creation.joined` | “{name} joined {home}.” | Verified normal Machine registration only |
| `managedMachines.provider.unreachable` | “{provider} isn’t answering. Last checked {time}.” | Error with retained observation; Inspect |
| `managedMachines.provider.removed` | “Install {provider} again to manage this resource.” | Unavailable plugin; native recovery reference retained |
| `managedMachines.credential.refused` | “The provisioner connection is no longer available.” | Refused/revoked; reconnect through owning credential Action |
| `managedMachines.enrollment.credentialDisclosure` | “Review the Happier sign-in stored on this trusted machine before it joins.” | Use only actual characterized credential scope; never claim restricted bearer |
| `managedMachines.inspect.checkNow` | “Check now” | Non-waking refresh |
| `managedMachines.creation.retryInstall` | “Retry install” | Same resource |
| `managedMachines.creation.openDetails` | “Show creation details” | Presentation; get/operation APIs supply headless equivalent |
| `managedMachines.creation.setup` | “Set up” | D53 stage after Join when the preset has an environment |
| `managedMachines.creation.setupFailed` | “Setup failed on {name}. Retrying uses this same machine.” | Retry setup / Continue without setup / Delete |
| `managedMachines.creation.retrySetup` | “Retry setup” | Same machine; never re-acquires |
| `managedMachines.creation.skipSetup` | “Continue without setup” | Marks the stage skipped, never Ready-with-setup |

This plan owns the common state vocabulary for every 51/53–56 consumer. Add `managedMachines.options.empty` (“No choices
are available for {provider} here.”), `.options.loading` (“Checking choices for {provider}…”), `.options.error`
(“Choices couldn’t be checked. Your choices are saved.”), `.options.unavailable` (“This choice is no longer
available.”), `.permission.refused` (“You don’t have permission to manage {name}.”), `.credential.required` (“Connect a
provisioner account to see available machines.”), `.power.pending` (“Waiting for {provider} to confirm {state}…”),
`.cleanup.unknown` (“Cleanup isn’t confirmed. Check this same resource before creating another.”), `.price.unavailable`
(“Price unavailable · billed directly by {provider}”), `.price.checked` (“Price from {source} · checked {time}”),
`.billing.stopped` (“Stopping keeps these charges: {charges}”), `.local.footprint` (“Runs on {controller} · no provisioner
bill”), `.resources.headroomUnknown` (“Available host resources are unknown.”), `.resume.unsupported` (“This ended
resource can’t be resumed. Creating another is a separate action.”), and `.capture.unavailable` (“Computer access isn’t
available for this image.”). Descriptor title/noun and validated capability/observation facts supply interpolation and
select consequences; no generic state or stopped-billing sentence is retranslated per provider. Native expiry and host
retention intent remain 52 facts; leaf-only license/template/transport diagnostics retain their qualified keys.

All states have an outcome, retained facts and a real next action. Forbidden/read-refused shows no protected row
content; unavailable native tool is distinct from no contributed provider. Off-device network failure keeps acknowledged
metadata dated, never labels the resource deleted.

## 3. Current owners and change map

**D21/D23 change map:** 50s1 adds location/stopped-billing facts to the canonical machineProvisioners descriptor; 53–56
leaves supply facts only. 50s2 stores 52's resolved retention/wake policy/live override. D23 offers an optional choice, default Keep; selected Stop/Delete binds existing
Automation lifecycle/durable-run triggers through 52s2 and 51s3; no managed-row scope field or process-local operation
identity is persisted.

Observed current checkout HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`; inspected moving on-disk source on
2026-10-05. This is not a runtime identity or a clean-tree claim.

| Verified path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `packages/protocol/src/plugins/contributions/catalog.ts:933` `PLUGIN_CONTRIBUTION_CATALOG_V2`; `families.ts:12` `definePluginContributionFamilyV2` | EXTEND | Add one typed machineProvisioners descriptor, same reference/registration derivation |
| `packages/plugin-sdk/src/definePlugin.ts:2963` `definePlugin`; `:2825` raw contributes rejection | EXTEND | Closed `machineProvisioners` author adapter, inferred role inputs/results; no raw manifest input |
| `apps/cli/src/plugins/projection/families.ts:52` `definePluginProjectionFamilyV2` | EXTEND | Schema-validated daemon/safe UI projection and occurrence currentness |
| `packages/protocol/src/actions/actionSpecs.ts:822` `ActionSpecSchema`; `:11825` `normalizeActionPublicExposure`; `actionIds.ts:75` families | EXTEND | Canonical host ids/specs/executor adapters; generated surface projections; respect client CLI transport restriction |
| `apps/cli/src/auth/remoteTerminalEnrollment.ts:89` `runRemoteTerminalEnrollment` | REFINE | Bind managed enrollment correlation/Home/resource/current admitted start; reject retired attempt before binding |
| `packages/cli-common/src/systemTasks/nativeRemoteSshBootstrap.ts`; `systemTasks/kinds/remoteSshBootstrapMachineKind.ts:353` `createRemoteSshBootstrapMachineTaskKind` | EXTEND | Reuse `remote.ssh.bootstrapMachine.v1` for every SSH-reachable managed guest; add managed/Home/resource/attempt correlation here, retaining host trust, binary payload, provisioning approval and enrollment recipes |
| `apps/cli/src/cli/commands/machine.ts:245`; `apps/ui/sources/components/machines/add/machineAddSshTaskAction.ts:53` | REUSE / EXTEND | Existing CLI setup and `machines.add.ssh.start/status/respond/cancel` task lifetime/progress; managed bootstrap attaches the same task rather than a second installer/progress controller |
| `apps/cli/src/auth/persistTerminalEnrollmentCredential.ts:15,42` persist/register | REUSE / REFINE | Normal credential persistence and registration, characterize actual Account bearer custody; consume 40 key adoption |
| `apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.ts:14` owner | REUSE | Private carrier materialization/cleanup at existing IO boundary; no credential vault |
| `apps/server/prisma/schema.prisma:2277` Machine; `:3445` AccessKey | EXTEND / CONSUME | ManagedMachine.enrolledMachineId is the sole optional FK to Machine; reverse association is derived, not a second Machine FK. Foreign AccessKey correction belongs 42 |
| `apps/stack/scripts/utils/managed_lima/lifecycle.mjs:124,153,167,176` inspect/start/stop/reconcile | EXTRACT / REFINE | Shared native inspect/create/identity/start/stop/delete boundary; errors distinct from absence; observe power after command acceptance |
| `apps/stack/scripts/utils/managed_lima/manager.mjs:58` `setupManagedLimaInstance`; `provisioner.mjs:220` guest provision | REUSE / EXTRACT | Keep Stack profiles/install/Node/Yarn/pressure policy; extract only matching native IO, not whole provisioner |
| `apps/ui/sources/components/settings/machines/collection/machineCollectionModel.ts:55` `buildMachineCollection`; `MachineCollectionList.tsx:142,382,431` list/draft/rail | EXTEND | Home-qualified managed-before-enrollment row variant and detail links; normal Machine identity remains unchanged |
| `apps/ui/sources/components/settings/machines/collection/useMachineAddOptions.ts:29`; `apps/ui/sources/components/machines/add/useMachineAddPaths.ts:19` | EXTEND | Actual provider creation entry through existing Add/options owner; do not create another setup picker |
| `apps/ui/sources/components/sessions/new/components/NewSessionMachineSelectionContent.tsx:57` | EXTEND | New-machine offers with 51's draft model, existing machine purpose/eligibility intact |

Existing tests to strengthen: Protocol `plugins/contributions/catalog.test.ts`, SDK `definePlugin.test.ts`,
`definePlugin.externalFixture.test.ts`, `definePlugin.inputTypes.test.ts`; Stack
`managed_lima/{lifecycle,manager,profiles,host_executor,provisioner}.test.mjs`; CLI
`auth/persistTerminalEnrollmentCredential.runtimeOrigin.test.ts`; UI `MachinesSettingsView.test.tsx`,
`collection/machineCollectionModel.test.ts`, new-session selection tests. New managed schemas/services/tests below are
intentional additions, not reported existing code.

## 4. Split-brains contracted here

The contribution catalog wins over provider maps, new loaders, model `contributes.providers` and naming conventions.
Migrate first-party/custom discovery, descriptor reads, role registration, UI options and CLI execution to the same
catalog/projection; no `registerMachineProvisionerRuntime` escape hatch.

The Machine-domain managed row wins over Action snapshots, provider-local allocation files, composer-only pending state
and fake Machine rows as paid-resource authority. Operations still own progress/results; normal Machine still owns
enrolled connectivity/crypto. All pending/detail/cleanup consumers read the durable row, and all ordinary
Session/file/SCM/PTY/service/capture consumers continue on normal Machine ids.

Extract one native Lima IO owner for Stack and the leaf. Keep distinct Stack placement, guest toolchain, SSH
publication, pressure and source-dev policy. Delete moved duplicate native bodies/imports after both callers migrate; do
not import Stack internals into a published product plugin. Old draft Action aliases `managedMachine.profile.*`,
provider options aliases and a separate G family spine are not implemented.

## 5. Contracts, persistence and routing

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**Consumed retention/trigger contract:** 52 §5 owns D21 category preference `machineRetentionDefaultsV1`, native
qualification (including D36 Ends after 1 h unused), and D23 `sessionArchived`/durable run-terminal bindings; 52 §6 owns
after-idle effect and fire-time approval. 50 snapshots the reviewed resolved policy and provides the exact created
resource/controller association to 52s2's FIN trigger write, never a second resolver, trigger store or implicit replacement/wake promise.
Selected `afterMs` reuses `RetentionV1`'s unused duration and stays on the same intent row.

**Reader/input classification:** Persisted/stored: ManagedMachineV1, ManagedResourceV1<NativeIdentity>,
ValidatedLaunchSnapshot<Launch>, RetentionV1, SupportedNativeIntent, controller/preset/enrollment/cleanup references and
ValidatedProviderObservation in managed rows; selected native identity/launch/billing/expiry/option facts and local
recovery records. Input/wire/event: AcquireResult, ManagedAccepted, ManagedBootstrapCarrierV1, MachineProvisionerContributionV1 (including
launchSchema/resourceSchema), provider role/action/report/admission inputs/outcomes and stable Machine events.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

The following is the proposed caller-visible type contract. Canonical Zod schemas live in **NEW**
`packages/protocol/src/machines/managed/{managedMachineV1,providerFactsV1,actionsV1}.ts` and **NEW**
`plugins/contributions/machineProvisioners.ts`; generate public validation/DTOs from those schemas. `HomeId` denotes the
existing Home locator/address carrier; Account/Machine/installation ids, contribution/action references and credential
references reuse their existing Protocol owners rather than new branded identities. Type names below describe selected
canonical carriers, not already published exports.

```ts
type ManagedResourceV1<NativeIdentity> = Readonly<{
  contributionRef: PluginContributionReferenceV2;
  schemaVersion: number;
  value: NativeIdentity; // nonsecret contribution fields; tolerant stored read, strict report input
}>;
type RetentionV1 =
  | { kind: 'until-delete' }
  | { kind: 'unused'; afterMs: number; effect: 'stop' | 'delete' }
  | { kind: 'deadline'; at: number; effect: 'stop' | 'delete'; interrupts: true };
type ValidatedLaunchSnapshot<Launch> = Readonly<{
  provider: PluginContributionReferenceV2;
  schemaVersion: number;
  name: string;
  choices: Launch; // tolerant stored read, strict launch input; no repository, Agent or secrets
  credential?: Readonly<{ purpose: QualifiedConnectedAccountPurposeV1;
    account: QualifiedConnectedAccountRef }>; // captured actual selected account, not group/default selector
}>;
type ManagedMachineV1<Launch, NativeIdentity> = Readonly<{
  id: string; homeId: HomeId;
  custodianAccountId: string;
  preset?: { id: string; revision: number };
  launch: ValidatedLaunchSnapshot<Launch>;
  controller: { machineId: string; installationId: string };
  allocation: 'unsubmitted' | 'may-exist' | 'bound' | 'confirmed-absent';
  bootstrapCredentialRef?: Extract<SavedSecretRefV1, { kind: 'shared_resource' }>;
  resource?: ManagedResourceV1<NativeIdentity>;
  enrolledMachineId?: string;
  desired: SupportedNativeIntent;
  desiredWhen: 'now' | 'after-idle'; // 52 intent timing on the same row, not another scope binding
  desiredAfterMs?: Extract<RetentionV1, { kind: 'unused' }>['afterMs']; // selected idle interval for after-idle only
  intentRevision: number;
  archivedAt?: number; // hide retains recovery/resource/capacity truth, never native deletion
  retention: RetentionV1; // resolved creation policy, explicit live overrides use52
  wakeOnAcceptedMessage: boolean;
  observation?: ValidatedProviderObservation;
  cleanup?: { disposition: 'pending' | 'unavailable'; reason: string };
}>;
type AcquireResult<NativeIdentity> =
  | { kind: 'bound'; resource: ManagedResourceV1<NativeIdentity> }
  | { kind: 'pending'; nativeOperationRef: ValidatedNativeOperationReference }
  | { kind: 'unknown'; recovery: ValidatedRecoveryHint }
  | { kind: 'rejected'; code: ManagedRefusalCode };
type ManagedAccepted = { managedId: string; operation: ExistingActionOperationReference };
```

`SupportedNativeIntent` is a closed union of current supported start/stop/suspend/resume/delete and B25's explicit
rebuild specialization; never an arbitrary native command string. 52 owns algorithms/intent admission, 50 owns persisted
shape/row mutation. Schema refinements require bound resource identity, forbid enrolled bindings on canceled admission
and forbid claiming confirmed absence from unavailability. A resource may remain present on confirmed-absent history for
exact recovery provenance. Number/date fields are finite and semantically validated; no guessed array caps, TTL or
string-length resource limits. Credential reference is validated by its actual Saved Secret/Connected Account owner, not
a permissive JSON bag.

`custodianAccountId` is the resource owner, provider-credential principal and enrolled Machine owner. The requester is
the authenticated actor already retained by the admitted Action/operation correlation; read that incumbent record for
audit/approval rather than duplicate it on the resource. Remove the proposed `executionAccountId`: it has no separate
resource consumer. 42 supplies any distinct requester-owned Session later. Per-resource SSH keypair custody belongs to
this host bootstrap stage: generate/materialize it privately on the exact controller through the existing
credential-file capability before SSH-reachable allocation, pass only the public key to the leaf launch, and retain only
`bootstrapCredentialRef` for retry/cleanup. Private key bytes never enter row/native choices/preset/receipt/logs;
installation retry reuses the same key and resource. Preserve the reference while bootstrap/native key cleanup needs it;
release its material through the existing credential lifetime owner after actual dependent work settles.

The declared `actions.bootstrap` returns a strict transport carrier, not its own SSH installer:

```ts
type ManagedBootstrapCarrierV1 =
  | { kind: 'ssh'; address: string; user: string; port?: number;
      hostKeyEvidence: ValidatedSshHostKeyEvidence;
      credentialRef: Extract<SavedSecretRefV1, { kind: 'shared_resource' }> }
  | { kind: 'native'; transport: ValidatedPrivateNativeTransportReference };
```

The native arm uses a closed `bootstrapTransport` adapter declaring private `exec` and `putFile` Action references.
The host supplies the binary install task's argv/input and private payload bytes under exact resource/controller/
attempt custody; the leaf implements only native IO through public SDK Exec/managed-services. `exec` returns the
existing process result/lifetime contract; `putFile` returns confirmed write or typed unknown/refusal for the exact
guest path. Neither owns enrollment nor selects credentials. Strict transport/report schemas characterize success,
failure, cancellation and ambiguous recovery before enabling acquire-to-enroll. Dispatcher custody covers both roles.

The catalog normalizer validates `bootstrapTransport.exec` / `.putFile` as effectful roles under the same admission
rule as acquire/power/destroy; the public-author fixture proves no invocation can bypass host custody.

The two new carrier aliases denote strict adapters to the existing SSH trust/native IO schemas, not exports that already
exist. SSH address/user/evidence are resolved by the leaf; the host invokes `createRemoteSshBootstrapMachineTaskKind`
through the existing task runner with exact Home/resource/attempt and current approval. Host trust/replace-host-key,
payload architecture selection, service provisioning, enrollment, cancellation/redaction and progress stay at that
task's owner. 54 Hetzner/DO, 55 Crabbox and SSH-reachable 53/56 routes consume it. Lima/Docker/Modal/Fly/Fleet native
exec/file use this host-owned adapter over their characterized native leaf carrier; common admitted enrollment/
currentness still applies. No per-provider SSH install or extra public bootstrap Action family.

Provider family descriptor:

```ts
type MachineProvisionerContributionV1 = Readonly<{
  id: string; title: ExistingLocalizedText; icon: ExistingPluginIcon;
  resourceKind: string;
  launchSchema: ExistingPortableStrictSchema;
  resourceSchema: ExistingPortableStrictSchema;
  // Persisted leaf reads derive createStoredReadSchema(launchSchema/resourceSchema);
  // acquisition/report admission continues to use the strict declared schemas.
  schemaVersion: number;
  platforms: readonly ExistingPluginExecutionPlatform[];
  prerequisites: readonly ValidatedPrerequisite[];
  billing: ValidatedBillingCapabilities;
  retention: ValidatedRetentionCapabilities;
  actions: {
    check: ExistingActionReference; options?: ExistingActionReference;
    acquire: ExistingActionReference; bootstrap: ExistingActionReference;
    inspect: ExistingActionReference; power?: ExistingActionReference;
    destroy: ExistingActionReference;
  };
  bootstrapTransport?: Readonly<{
    kind: 'native'; exec: ExistingActionReference; putFile: ExistingActionReference;
  }>;
}>;
```

Fixed-shape leaves may omit options; finite leaves may omit power. Safe facts include option ids/native image
descriptor, CPU/RAM/disk where returned, qualified prices
`{amount:string,currency:string,unit:string,source:string,observedAt:number}`, separately returned monthly price/cap,
stopped compute/storage consequences, native expiry, actual controller headroom or unknown. No hourly-to-month
conversion or cost-so-far engine. Preserve pricing provenance without putting provider bearer in
launch/row/Action/receipt.

For D21, refine this same proposed `providerFactsV1` billing schema with explicit `location:'local'|'cloud'|'unknown'`
and `stoppedBilling:'billed'|'not-billed'|'unknown'` facts alongside its existing price/provenance projection. “Billed”
means stopped compute charges (D42); retained storage charges are disclosed separately and do not change the category.
Fly remains running-billed. Missing/unknown compute facts stay unknown. 52 maps local to local, cloud/not-billed to running-only,
cloud/billed to stopped-billed, and every other combination to unknown. Provider leaves report characterized facts;
neither a title nor a provider-id list determines policy.

**Persistence is required** by MR-R1: paid resource/native identity must survive loss of the initiating operation/UI and
is not reconstructible from progress snapshots. Add only ManagedMachine and ManagedMachinePreset (51) through
`apps/server/prisma/schema.prisma`, provider schemas and canonical schema-sync/migration owner. Relational columns cover
id/Home/custodian/controller installation/enrolled relation/intent revision/admitted Action request correlation and
useful existing lookup conventions; known-field-validated, tolerantly read complex launch/native identity/observation
may use established JSON representation. Do not add ProviderConnection, TaskRun, enrollment journal, worker queue,
receipt or provider lifecycle tables. `ManagedMachine.enrolledMachineId` is the only FK for this optional association; Machine's reverse view is derived.
The database uniqueness for admitted Action correlation returns the same row for
retried same input; changed input conflicts. Use `inTx`; emit/forward effects through `afterTx`, never buy inside a DB
transaction. Match existing Account/Home relation and erasure rules; preserve recovery responsibility per 52 rather than
cascading away a possibly paid row.

**NEW** server owner `apps/server/sources/app/machines/managed/` contains focused admission/acquire/read/mutation files;
thin routes join existing Machine route registration. Reads and writes are explicitly Home-qualified. Use existing
Action request transport, operation snapshots and Machine update/Account invalidation events to refresh admitted
consumers. No new provider RPC/event bus; private invocation/report adapters bind authenticated controller installation
and expected intent revision. Report input accepts only descriptor-validated facts and native identity. UI callers
cannot submit an admission DTO or self-declare a custodian.

**D20/D24 administration:** consume [41 §5](41-machine-sharing-and-project-terminals.md#5-contracts-persistence-routes-and-events).

### Current policy and owner decisions

Settled owner contracts (consumers reference by id):

- **MR-D1 — SETTLED — 50's managed-resource/recovery owner and D20:** Home-visible recovery metadata is minimum nonsecret native
  identity/controller/intent/cleanup. Native schema field census in 50s1/2 escalates only concretely sensitive fields; no blanket encryption/public bag.
- **MR-D2 — SETTLED — 50's managed-resource/recovery owner and D20:** acquisition choice lives in existing Machines settings and its user/Home setting controls
  acquire. No separate until-validated/new-capability gate is introduced without a named rollout requirement. Disable acquire without hiding retained
  resources/cleanup. 50s2 and 51s2 consume; do not invent a Home Features page from an illustrative prototype.
- **MR-D3 — SETTLED — 50's managed-resource/recovery owner and D20:** no acquisition-then-handoff topology for an existing Session. New Session dedicated
  target and same-resource wake remain; existing ordinary enrolled-target handoff keeps its owner. Any broader promise requires explicit amendment.

**D53 amendment (r9.8, 2026-10-09):** when the creation selection's preset revision has an `environment`, creation adds a
“Set up” stage after Join: the joined daemon runs 51's `applyMachineEnvironment` for that exact revision; the admitted
composer continuation (first message) waits until setup succeeds or is skipped. Setup success/failure/skip is a stage fact
on the existing creation row (no new store). Retry setup reruns only the operation on the same machine.

## 6. Actions (D16)

**Agent-start admission:** extend `packages/protocol/src/actions/executor/agentStartAdmission.ts#resolveActionAgentStartRequestsV1`
only when acquire includes a real Agent-start continuation. Requester/depth/target admission precedes spend and stays
current through actual start. Bare compute, finite commands and services retain spend approval and Machine authority
without fabricated Agent context. ORC owns the start decision; 50 owns compute admission (D42).

**D21/D23 Action inputs:** acquire reviews resolved retention/wake; a selected created-scope effect is handled by
admitted continuation configuring 52's existing Automation binding after real Session/durable-run identity exists.
retention.update changes only live retention/wake at the managed row; binding changes use canonical Automation
CRUD/trigger Actions. Category preference updates use plan 52's declared settings Actions, not arbitrary resource patches.

All ids below are NEW host specs at the existing Action owner. Approval and actual surface parity consume the index
[Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog) (D16/D42).
Catalog normalization requires daemon placement and declared same-plugin role occurrence. Effectful acquire/bootstrap/
exec/putFile/power/destroy calls require admitted host-private custody on every route; an exposed effect delegates to
canonical host admission, never raw IO. Side-effect-free check/options/inspect may also be exposed under ordinary
current access. Extend catalog/dispatch once; no provider-local validator or extra permission engine.

| Action | Input → output | Safety / placement |
| --- | --- | --- |
| `machines.provisioners.list` | Home + exact optional controller → safe current descriptors/availability | Read / Account discovery + daemon contribution facts |
| `machines.provisioners.check` | contribution + Home/controller/credential ref → prerequisites/typed repair | Read/probe / selected controller; never install/create |
| `machines.provisioners.options` | same + draft native selectors → validated options/facts | Read / selected controller; stale/error retains draft |
| `machines.managed.acquire` | executable selection or preset id+revision, exact Home/controller, reviewed retention/wake; start admission only for a real Agent continuation → ManagedAccepted | Purchase/install / Ask first; real start denial precedes spend; bare compute uses Machine/spend admission |
| `machines.managed.list` | Home + authorized filter/existing paging → safe managed summaries | Read / no wake |
| `machines.managed.get` | Home+managed id → admitted safe row/recovery | Read / no wake |
| `machines.managed.inspect` | Home+id → current or unavailable observation + operation when native async | Read / exact current controller; never start |
| `machines.managed.bootstrap.retry` | Home+id+expected revision+current enrollment context → same-resource operation | Install/enrollment / Ask first; no acquire |
| `machines.managed.cancel` | Home+id+expected revision+creation request → cancellation/cleanup disposition | Potential delete / Ask first; before submit no effect, after possible allocation exact cleanup |

52 defines power/retention/delete/controller/retire host intents; 25 owns the closed Devcontainer rebuild
specialization; 51 defines presets. Existing `machines.list`, connection/pairing/SSH/install, Session spawn and
inherited Machine operations retain their specs; new managed list is separate from released ordinary Machine-list
unions. Concrete Machine/Session/settings navigation uses its existing admitted owner. Recovery-id copy/disclosure are
local presentation; native-console URLs are validated and credential-free, not arbitrary transported callbacks. Headless
equivalent is get/inspect returning safe reference/URL, not CSS-click Actions.

## 7. Plugin extensibility and Lima vertical

Extend existing `definePlugin({machineProvisioners:{...}, actions:{...}})` author grammar; one generated portable
declaration and one `activate(api)` registration contract. The new author adapter validates same-plugin role references,
daemon placement, input/result schema relationships and occurrence rights. Shared validation is catalog-owned; don't
duplicate it in SDK or CLI. Add public exports through SDK `*.public.ts`/package `exports`, public author inference
fixtures and existing declaration governance. Machine provisioners are distinct from executable Agents and model
Providers.

Bundled producers remain `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts` and
`apps/ui/scripts/generateBundledPluginUiArtifacts.mjs`. Update source manifest/membership and regenerate once at
integrated boundary; never hand-edit generated projections. Real custom fixture imports public SDK only, normalizes,
activates and invokes check/acquire/inspect through host admission; successful types alone do not complete MR-R6.

**NEW**
`packages/plugins/machine-lima/{package.json,src/index.ts,src/machine/provider.ts,src/machine/schemas.ts,src/machine/provider.test.ts}`
uses public SDK Actions/managedDependencies/Exec/managed-services IO, existing binary installer and credential file
service. Generic host has no Lima id branches. **NEW** `packages/cli-common/machineLima.mjs` + `.d.mts` is the
package-owned shared native boundary using its current root-module export convention; both Stack wrappers and
public-admitted plugin IO consume it. No Stack policy is exported.

Lima selection/resource input and report schemas are closed; their stored projections tolerate/drop extras and writers
canonicalize: selected instance name, exact resolved Lima store, image/native architecture/VM type, CPU/RAM/disk,
explicit reviewed mounts; resource identity retains exact store+instance and observed creation facts. Product defaults
no host-home mount, SSH-agent forwarding or containerd; Stack profile behavior stays with Stack. Start cannot recreate
an absent VM; same-name/different-store or creation drift refuses. Exact native delete does not target all VMs. Stop
retains disk and promises no RAM/process survival. Install/bootstrap operates guest-native binary payload, not Stack
Node/Yarn/toolchain setup.

Observed Stack reconciliation is macOS VZ-specific and requires Lima ≥2.0.0; do not claim it proves Linux support. [Lima
usage](https://lima-vm.io/docs/usage/) and [exact delete command](https://lima-vm.io/docs/reference/limactl_delete/)
were consulted 2026-10-05 as primary-document discovery; selected installed version/tool/image must be characterized
before implementation relies on flags, host support or guest-home path. Do not invoke native delete in this planning
lane. Qualify Linux through actual native adapter contract if supported; otherwise typed unavailable. Windows controller
can read and route another host; local native Lima eligibility requires positive platform evidence. Local VM controller
cannot move physically.

Closed host responsibilities: managed intent admission, normal enrollment, key material, prompt/Session/turn state, wake
queue, grant administration, credential selection and retention algorithm. Provider cannot register a second Machine,
lifecycle runtime, viewer, auth principal or resource queue. Public plugin UI may display safe facts via admitted
Actions and existing widgets; no raw bearer/key/native response bags or host-internal imports.

## 8. UI composition and token reconciliation

`MachinesSettingsView → MachineCollectionList/MachineCollectionRail → existing MachineAddForm → SelectionTiles(action
provider cards) → 51 ManagedMachineConfigurator`; pre-enrollment detail uses `ItemList + PageHeader + ItemGroup +
SectionContentRow + SurfaceStateCard/SurfaceFreshnessLine + shared Step/Status`, operation output from 21. **NEW**
`components/settings/machines/managed/ManagedMachineDetail.tsx` composes that pre-enrollment body;
`ManagedCreationProgress.tsx` is a domain projection, not a new progress engine.
`/settings/machines/managed/[managedId]` is pre-enrollment only. Once `enrolledMachineId` is verified, the captured-Home
route redirects to existing `apps/ui/sources/app/(app)/machine/[id]/index.tsx#MachineDetailScreen`, which mounts 51's
receipt and 52's `ManagedMachinePolicySection` with 41 Sharing, 42 counts and 30 worker policy. Pending deep links
follow this same redirect on later open; no second enrolled detail or duplicate power controls.

Provider logo stands bare; healthy readiness stays quiet. Initial arrival is static. Lab press 90/180ms maps to
`motionTokens.durationMs.press/release`; anchored picker 140/120ms maps to `motionTokens.overlay.popover`; progress
expansion 240ms + 80ms delayed content maps to `inPlaceMorph`. Reduced motion is immediate or canonical short crossfade;
no shimmering progress while hidden. Row/section metrics remain `pageListMetrics`, `itemDensityMetrics` and public page
metrics, not copied lab 56/48/30 constants. 70s1 supplies missing shared semantics only with this/51 real consumer. No
custom div table, status pills, sheets, stepper or icon tiles.

## 9. Lifecycle, failure, cancellation and recovery

1.  Admission validates current requester/use/spend/Home/controller/credential/feature. Persist unsubmitted row before forwarding. Controller-offline remains
   unsubmitted waiting, not a guessed failed purchase.
2.  Exact current controller marks may-exist before native acquire. Same admitted request coalesces through existing Action identity/row; no global exactly-once
   guarantee. Native idempotency/correlation must be proved, not inferred from labels.
3.  Bound identity is persisted promptly before bootstrap. Lost response yields typed unknown/reconcile same native scope; no automatic new purchase. A native
   pending handle is retained through its validated native contract, not a generic workflow journal.
4.  Guest creates enrollment proof; protected normal carrier binds Home/resource/admitted Action attempt and intended audience. Final credential/private key is
   not cloud-init text, argv, logs, descriptor or receipt. If a private supported carrier is absent, independent QR/fingerprint approval is truthful;
   implementation cannot invent wider guest Account exposure from D3's requester-Session fallback.
5.  Enrollment commit checks current intent/installation/admitted attempt before linking ordinary Machine. Cancellation/changed draft cannot attach late result;
   record possible native cleanup even when stale binding is rejected.
6.  Reconnect/restart reads retained row, checks current plugin schema/authority/native identity and reinspects. Missing storage/plugin/credential is
   unavailable, not confirmed-absent. Removed plugin leaves safe native recovery data visible under current row-read authority.
7.  Cancel before native submission prevents create; cancel after may-exist requests exact cleanup through 52's intent. Closing a UI loses no custody. History
   remains after confirmed absence; live eligibility stops, not the user's Session history.

## 10. Compatibility and predecessor basis

Wire/persistence/SDK seams follow `docs/compatibility.md#sdk-protocol-evolution`: new managed V1
authority/mutation/identity/routing/native-reference objects recursively closed; manifest remains existing V2/runtime
ABI 1 with one admitted new family. Package SemVer is separate from wire epoch and requires actual published census
comparison at publication. Unknown fields cannot select credentials/authority; invalid resource schema version retains
manual recovery rather than reinterpretation. Capability/admitted operation absence disables create while ordinary
connection/read flows remain.

Observed live sibling `../0.2` HEAD **51f8ac630607ce4041cc6a774de824c330f421f3** on 2026-10-05; targeted status/diff for
CLI API/encryption, schema and SDK/catalog paths was empty. Its `apps/cli/src/api/client/encryptionKey.ts:35` Machine
factory uses Account machineKey or legacy secret; `apps/server/prisma/schema.prisma:804` Machine stores existing
ciphertext/envelope/install fields. Those ordinary rows must remain readable through 40's owner, including absent
managed link. Earlier deep-E cited a different HEAD and predecessor enrollment modules that are now absent; do not
fabricate compatibility fixtures from those paths. 50 changes normal enrollment only after reading actual current
predecessor auth producer. No new managed row/family was found in the bounded current Prisma/catalog/SDK/Machine owner
search; 0.3-only drafts are replaced in place without aliases/dual writers/reverse-0.3 rollback.

Implementation refreshes relevant sibling HEAD/status/diff and actual immutable released producers at the consumed
40/enrollment/SDK boundary. New clients with old servers return supported-operation unavailable; old ordinary Machine
readers are not sent an unexpected managed-row union. Do not impose an Account-wide update floor or new custom CORS
header without predecessor support.

## 11. Ordered consumed slices and deciding checks

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**50s2 policy/trigger integration:** admission snapshots 52’s resolved policy once; category edits do not
rewrite live rows. Existing Automation binding after actual Session/durable-run admission cannot attach
canceled/replaced continuation or an existing selected Machine. No scope enters a managed-row/settings field; real
trigger/currentness suites prove it. Stored extras use lazy shared tolerant reader; strict request unknown fields/forged
identities refuse.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

50s2's real managed row read/write test seeds extra nested native/launch fields, reads known identity through the shared
projection and writes only canonical fields; strict acquire/report ingress still refuses those extras. This discriminates
an incorrectly strict stored reader or permissive input without reproducing the helper's full schema matrix in each leaf.

### 50s1 — Real provider family with Lima and a public author

**First consumed vertical:** Lima needs 50s2 durable admission, private enrollment and a real invoked acquire consumer.
A headless Action is a consumer. UI creation co-lands its 51 facts/receipt and 70 table at the UI boundary. Hetzner proves
the cloud path next on the roadmap; neither it nor complete four-host UX blocks independent Lume/native work.

The provisioner supplies only native acquisition/bootstrap IO. Task inspection and final execution tuple remain
24s2's responsibility after ordinary enrollment; its completed environment adapter is not a prerequisite for this
first allocation/install proof. No detector-only replacement execution API or second runtime.

**Provisioner family and dispatcher prerequisite:** migrate all catalog/SDK/UI/CLI/first-party/custom consumers to one
`machineProvisioners` family, deleting the undeployed old name/aliases; no model-Provider registry or second loader.
Extend `plugins/runtime/lifecycle/activation/targets.ts#PRODUCT_DEMAND_READY_REGISTRATION_FAMILIES` and its demand
coordinator: light descriptor discovery must not activate every leaf; first use activates selected occurrence and
retained-row reconciliation loads only the referenced leaf. This is a consumed activation implementation, not
descriptor-only dormant plumbing.

**Dormancy RED:** extend `apps/cli/src/plugins/runtime/lifecycle/manager.targetActivation.test.ts` at the real
manager/catalog/demand boundary: startup and descriptor listing leave unused provisioner modules unimported/inactive;
demanding one occurrence imports/activates only its leaf, retained rows demand only referenced leaves, and retirement
denies native invocation. Instrument module-loading boundaries, not internal policy.

Extend `apps/cli/src/plugins/runtime/invocation/actions/executeContributedAction.ts#executeContributedAction`’s
private targeted-operation/execution-origin carrier and
`apps/cli/src/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority.ts#createManagedProviderOperationAuthority`
for native-role effects requiring host-private managed
custody **before native IO**, bound to current managed row, exact controller installation, contribution occurrence, role
and admitted intent. Add only the missing current-row/role predicate to those owners. Plugin-only surfaces
and same-plugin calls supply no authority. RED runs real contributed dispatch: approved managed acquire succeeds,
same/other-plugin direct native-role calls without custody refuse before allocation, stale
row/controller/role/occurrence refuses, unrelated ordinary plugin Actions stay unchanged. No public bearer or second
registry.

**Reference and public-author roadmap:** Lima 50s1/2 acquire→protected install→ordinary enrollment/Session
plus inspect/stop/delete and public-only author fixture, then Hetzner 54s1 equivalent, prove local and cloud consumers.
Independent leaves need their actual producer/carrier, not both references (D42). 53s1 is Lume. Characterize versioned SSH or native exec/put-file
success/failure/cancel/recovery at exact resource; host supplies protected task payload, no unrelated RemoteHost. Reuse
`plugins/authoring/toolchain.ts#preparePluginAuthorDependencies` and `materializePrepublicationAuthorWorkspacePackages`
for current module closure and shared SDK/package identity. Imports/measurement consume the index Daemon weight rule.

Consumes incumbent plugin/Action/native IO/enrollment owners; provides catalog→builder→activation→host native consumer.
Owns Protocol contribution/schema/spec adapters, SDK author/public exports and inference fixtures, CLI
projection/invocation binding, **NEW** machine-lima leaf and cli-common native module, corresponding Stack
wrappers/tests. The minimum host acquisition consumer co-lands with 50s2's row-before-effect substrate; a
descriptor-only family is not a completed or enabled feature.

RED: extend `packages/protocol/src/plugins/contributions/catalog.test.ts` and SDK `definePlugin.externalFixture.test.ts`
to execute a custom public machine-provider through the real normalizer/activation/currentness host and return validated
native identity; wrong-plugin role/client-only role or retired occurrence refuses before IO. NEW
`machine-lima/src/machine/provider.test.ts` invokes real leaf below native process/OS boundary: inspect error is
unavailable, missing retained VM cannot be recreated by Start, lost create reconciles same exact store/name. Extend
Stack `lifecycle.test.mjs` / `manager.test.mjs` to prove unchanged Stack drift/profile/explicit reconcile outcomes after
extraction. Mock native process/SSH/OS only, not catalog/policy/native decoder.

GREEN: one family and consumed native owner; exact delete/identity validation, producer diagnostics and public inference
succeed; no duplicate native bodies/host id branches. Checks: routed focused Protocol/SDK/leaf/Stack suites; public
`typecheck` for protocol, plugin-sdk, cli-common, CLI and any UI touched; routed package `build` for new leaf/cli-common
and Stack build; bundled projection governance after regeneration. `hstack-exec -- node --test
apps/stack/scripts/utils/managed_lima/lifecycle.test.mjs ...` uses native Stack harness, never Vitest. No local package
installation/archive.

### 50s2 — Durable acquire, same-resource bootstrap and normal enrollment

**Consumed seam RED:** `managedAcquire.integration.spec.ts` exercises real start and compute admission: denied real
Agent continuation spends nothing; bare service/finite-only compute succeeds with normal Machine/spend authority and
no Agent context. Admitted Agent continuation remains current at actual start. No internal policy mock.

**Native bootstrap RED:** `machines/managed/enrollment.test.ts` executes the host task/declared exec/putFile adapter:
private payload reaches only the exact admitted guest; failed/ambiguous IO preserves same-resource recovery;
cancellation or retired controller/occurrence cannot enroll or replay. No private-role custody bypass or public bearer.

**Credential lifecycle:** configure/select/refresh/repair cloud credentials through existing qualified Connected
accounts/purposes (`connect/qualifiedConnectedAccountsV4.ts`, purpose bindings/selector) and public manual/OAuth
descriptor owner, not a provisioner credential table/undefined reference. Custodian controller holds material; Manage
admits native use/spend, no API secret-read. Resolve account/group selection once at acquire; retain actual qualified
account and leaf-schema-validated native organization/project scope. Later inspect/power/delete cannot follow changed
defaults into another account.

Generate bootstrap SSH key through canonical SavedSecret mutation/resource owner, persist private half there and
atomically retain validated resource reference on managed row before use. `account/settings/savedSecretReferenceV1.ts`
and CLI `settings/secrets/savedSecretCatalog.ts` own reference validation/recheck/materialization; credentialFile is
only temporary private delivery lease. Disposal/restart/failed-install retry reopen the same key for the same paid
resource. Native creation receives public half only; no material in
presets/preferences/receipts/log/user_data/cloud-init. Existing protected SSH task or native exec/put-file carries
install payload without an unrelated RemoteHost. Move selects explicit reachable custodian-owned installation able to
resolve same account/native scope/key; unavailable stays disclosed, no failover.

For Plain Accounts this bootstrap key is a server-readable SavedSecret by design; keyless Plain transport is not E2EE.
E2EE keeps the incumbent sealed content. Manage may request host-held use but cannot read/export either mode's key.

RED rotates group/default after acquire and inspect/delete still targets captured account; revocation/mode change
refuses materialization; dispose file lease/restart/retry proves same SavedSecret key/native id; malformed ref never
reaches native IO. Consume EC S2/S6 ready typed snapshots/atomic references, no Settings replica. Managed shared enrollment consumes D24 pre-grant disclosure
and API non-disclosure.

50s1’s catalog/dispatch RED admits public read-only check/options/inspect while direct effectful role invocation
without managed custody allocates nothing; an exposed effect succeeds only through canonical host admission. The
public-author fixture executes native exec/putFile through the same custody. No provider-local surface validator.

Consumes 50s1; supplies row/routes/controller reconciliation/native correlation/enrollment and typed cancel. Owns NEW
server managed domain/Prisma provider-consistent migrations, Protocol managed schemas, **NEW** CLI
`machines/managed/{acquire,reconcile,enrollment}.ts`, normal auth carrier adaptation; consumes 40 for keys. RED: **NEW**
`apps/server/sources/app/machines/managed/managedAcquire.integration.spec.ts` with existing real DB harness admits same
request twice and recovers same row, changed payload conflicts, denied acquire creates no paid effect, row visible
before external response. **NEW** CLI `machines/managed/enrollment.test.ts` fails bootstrap then retry binds the same
native id, canceled/replaced attempt cannot attach/start, possible late result still retains cleanup. Extend actual
credential-origin test to discriminate wrong Home. HTTP/native process/private credential delivery are boundary mocks;
DB/auth/schema/admission/normal registration logic are real.

GREEN: row first, exact retained identity, truthful unknown, guest proof/actual scope disclosed, atomic current binding.
Checks: routed focused CLI and server integration/DB-contract plus Protocol schemas; public CLI/server/protocol/SDK
typechecks and server build. Migration scope includes Postgres/SQLite/MySQL generated schemas/deploy evidence; if edited
unpublished migration was applied, final editor completes current-checkout retained DB reconciliation, semantic
comparison, two deploys and integrity per server/Stack AGENTS. No reset/backup/clone for that narrowly owned
reconciliation; no mutation now.

### 50s3 — Reachable pending rows, progress and cleanup across hosts

This slice is preparation until the 51 configurator/receipt/draft-target consumers co-close. INT PLAN §3 I3 owns
`resolveWorkStatusTone` and glossary; ORC PLAN §3.2 owns Inbox attention, including costly-install failure.

**Reachable recovery, status and presentation:** creation-scope controls configure52's existing Automation binding, not
a new field/watcher. Managed power/wake and operation status consume `components/work/status/resolveWorkStatusTone.ts`
and canonical WorkStatus/StatusPillVariant; failed costly install/unknown cleanup enters existing Inbox/attention with
exact recovery. Focus/search/copy/dismiss remain local presentation; concrete admitted Session/Machine/settings
navigation and domain effects use real owners, never transported arbitrary callbacks. Reconcile reached settings-fix
Connected Action/runtime-metadata/NewSession diagnostics at later integrated touched-package gate; no inherited
pre-existing/green claim.
Managed creation and wake use the single AgentInput badge/observed-stage popover from §2, with existing status-row phone/focus behavior.

50s2 also owns the existing SSH task extension from §3/§5, not only the new managed wrapper. Extend
`packages/cli-common/src/systemTasks/kinds/remoteSshBootstrapMachineKind.test.ts` after verifying its current harness:
managed SSH guest with host-key change requires incumbent trust review; cancel/retired Home/attempt cannot enroll;
failed install plus Retry uses the same resource/public key/private credential reference. The CLI/UI task adapters
retain the same start/status/respond/cancel outcomes. Only SSH/process/private-file/network boundaries are mocked; real
task recipe, binary selection, enrollment and admission execute. Native exec carriers are the neighboring positive case,
with no forced SSH dependency.

Consumes 50s2 + 51 draft/config projection; shared enrollment consumes 40/41/42 complete authority. Owns Machine
collection/model/route and NEW managed detail/progress, composer continuation adapter with 51/23. RED: strengthen
`collection/machineCollectionModel.test.ts`, `MachinesSettingsView.test.tsx` and new-session selection test using
canonical UI testkit: resource with no Machine id remains reopenable after failed install/plugin removal, then enrolled
row navigates normal Machine without duplicate list item; late result after target/Home change cannot dispatch Session
start. Boundary mock network/router only, real row/draft selection.

GREEN: desktop/phone/CLI get/open/cancel/retry all use same ids; no fake Machine, hidden pending bill or raw provider UI
mutation. Public app/CLI/protocol typechecks, focused and adjacent Add/setup/navigation suites, actual
loaded-stack/browser evidence in §12. Can prepare UI while s2 runs; cannot enable acquisition or mark complete before
durable producer and native consumer. No s1/s2 dormant spine completion.

Slice completion consumes the index Integrated implementation evidence rule. No production checks ran in this draft-text lane.

50s3's route/destination RED must reopen a previously saved managed URL after enrollment and reach `MachineDetailScreen`
in the same Home with the single receipt/Keep/sharing/work/worker section composition. Before enrollment that URL
remains progress/recovery, even offline; revoked access reveals no protected row. GREEN removes any enrolled
managed-only detail branch. Preserve the existing fuller Add/composer/late-result checks above.

**D20 proof:** consume 41’s canonical admission/credential non-disclosure suite. This slice adds only its discriminating managed mutation/credential-currentness cases; no repeated omnibus access matrix.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 50s1 | IMPLEMENTED — open items | `71e10f8f39`, `c8fb44dd2d`, `bb91a546bb`, `e2fce97c6b`, `51b7cbf32d` | [C50](../../reviews/2026-10-02-lane12-replan/impl-C/C50.md) records family/dispatcher, Lima/shared Stack IO and dormancy owner GREEN; [FX6](../../reviews/2026-10-02-lane12-replan/impl-C/FX6.md) retains the canonical publisher failure handback; [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) confirm narrow Protocol imports/native declarations. | Common gate; canonical bundled publication/DTO and public-author consumer checks, selected-only activation and the integrated cold-daemon measurement; repair external SDK/leaf publisher inputs rather than hand-edit output. | Actual Lima/native tool/image/platform/license qualification; physical clients and signing. |
| 50s2 | IMPLEMENTED (focused GREEN) | `92c476ae05`, `0cb95bb680`, `8a9eec3d81`, `e2fce97c6b`, `ac944cbc52`, `d0b68f94e2`, `7ef13082ec`, `f1bf5fbff7`, `327e8df613` | [C50](../../reviews/2026-10-02-lane12-replan/impl-C/C50.md), [FX1](../../reviews/2026-10-02-lane12-replan/impl-C/FX1.md), [FX4](../../reviews/2026-10-02-lane12-replan/impl-C/FX4.md), [FX6](../../reviews/2026-10-02-lane12-replan/impl-C/FX6.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) record row-before-effect/admission, same-resource retry, current credential and recovery GREEN. [C53D](../../reviews/2026-10-02-lane12-replan/impl-C/C53D.md) adds D53 Set up/retry/skip/Delete; [CD2/CD6–CD8/CD10/CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) shape bootstrap, Fly boot, purpose custody and selected retention. | Common gate; retained DB deploy/FKs and schema verification, then acquire→private install→Join→Set up→same-resource retry/cancel/late enrollment with actual admitted continuation; external catalog assertions remain Main's adjudication. | Authorized vendor acquisition/transport/billing/cleanup; native executables/platforms, physical devices and signing. |
| 50s3 | IMPLEMENTED (focused GREEN) | `ee62fef68b`, `e9931ecea2`, `69af451f9c`, `5de4a3a656`, `53b3fb93f9`, `1122a710fb`, `327e8df613` | [C50U](../../reviews/2026-10-02-lane12-replan/impl-C/C50U.md), [FUI](../../reviews/2026-10-02-lane12-replan/impl-C/FUI.md), [FUI3](../../reviews/2026-10-02-lane12-replan/impl-C/FUI3.md), [FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md), [FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) and [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) record pending/enrolled routing, retained/archived recovery, hydration and CLI list/get GREEN; [CD3/CD13](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) govern opt-out and FIN detail. | Common gate; reconcile held shared Add/screen-model/localization closure from CC3/CC4; QAC3 catalog→configuration→Save/Use is in progress, not proof of paid acquire/Join/recovery or full visual/accessibility parity. | Native failed-install/lifecycle/platform behavior and vendor cost/cleanup; physical devices and signing. |

## 12. Live QA recipe and completion

This is the managed acquisition segment of the umbrella's **one composed journey**, not another program ship recipe:
identify existing checkout-bound dev Home/server, loaded UI and controller daemon; on a qualified native host Create a
separately named Lima VM → induce an install boundary failure → reopen pending row from Machines/phone → Retry install
same native identity → verify ordinary enrollment → ordinary Project/file/SCM/terminal/Session use → inspect without
wake → 52 stop/start retains a guest sentinel file → exact delete leaves a neighboring/Stack VM untouched. Public-author
fixture reaches same host path; Action automation waits for Ask-first decision and cannot bypass it. Do not
create/freeze/package a release or operate another stack's VM.

Side-by-side final lab/live `m-add A/Ap`, `m-pick A/Ap/Aprog` and `m-life A` at desktop/390px light/dark:
initial/loading/offline/refused/unknown/late cleanup; keyboard focus/Escape/Back, screen-reader stage names, large text,
reduced motion, draft preservation. Observe catalog/options requests only on demanded surface and narrow row updates;
elapsed clock cannot rerender whole composer. Test actual process/network/DB source path where runnable. Physical
native/vendor qualification unavailable to executor is named once in umbrella Release checks with
host/tool/tenant/permission prerequisite; it is not a recurring per-provider certification ledger.

Outermost acceptance: a failed bootstrap is visibly recoverable by managed id with exactly one allocated identity;
canceled late enrollment never starts the old draft; enrolled guest supports ordinary operations; no plugin/native
bypass or second owner; actual source checks and runnable composed evidence available. Missing local producer/carrier/DB
evidence blocks its affected implementation slice; physical release checks alone do not prevent implementation
completion.

## 13. Economy notes

No provider registry/loader, second Machine runtime, TaskRun, ProviderConnection/vault, receipt Artifact, generic
job/DAG/checkpoint journal, new queue, host exactly-once promise, lease/epoch/fence/controller election, second crypto
factory or provider-specific viewer. Cloud credentials stay at mode-aware Connected/SavedSecret owners; no unenveloped
E2EE or Manage-readable copy is added. Plain material is server-readable by design. Native-request ambiguity stays
visible; row revision
cannot unsend an external request. Reuse owner-local single-flight; introduce a narrower claim only after a reachable
duplicate-effect test defeats current identity/one-controller/native semantics and a contract amendment authorizes it.
Plain Docker remains B25; no offline-controller child restart.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Empirical checks: 50s1 selects/pins actual Lima tool/image/native delete/success/fail/cancel/recovery and public SDK
published frontier; 50s2 proves actual normal guest credential/carrier scope (D3 fallback is not guest authorization),
authenticated Home/resource/attempt retirement and current DB representation; 50s3 composes 40/41/42 for shared behavior
and refreshes predecessor facts. Unknown native contract returns truthful unavailable until characterized; do not cut
required Lima/provider capability because a release host is absent.

Residual risk: guest credential custody,
real native tool qualification, database/currentness and integration with moving neighboring seams require
implementation proof and subsequent program review.

History: see archive-r8.4 and the review folder
