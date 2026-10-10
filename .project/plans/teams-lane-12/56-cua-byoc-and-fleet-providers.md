# Lane 12.56 — Cua BYOC and Fleet Machine providers

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**  
Date: **2026-10-06**  
Plan-writing owner: **PE2**. No implementation, vendor claim/purchase, credential inspection or cloud mutation is
approved by this draft.

Supersedes: [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md)
remote Cua BYOC and Fleet portions; preserves both D12 leaves while separating native ownership/lease
semantics. 
Extends: `53-local-lume-and-cua-providers.md` s2–s3's one native Cua adapter with qualified remote contributions, not
another Cua host registry; `50-managed-resources-and-enrollment.md` s1–s3 with exact remote resource refs and normal
enrollment; `51-managed-presets-and-creation.md` s1–s3 with remote facts. 
Consumes: 50s1 family/SDK, 50s2–s3 durable acquire/current private enrollment/recovery; 51s1–s3 one
configuration/preset/receipt; `52-managed-retention-and-wake.md` s1–s3 native intent/expiry/wake/cleanup/reassignment;
53s2–s3 shared Cua boundary/license and created Space cleanup; `55-docker-modal-and-crabbox-providers.md` s2 finite
Modal semantics when that BYOC backend is selected; `24-native-execution-environments.md` s1–s3 final environment;
`40-machine-content-key-lifecycle.md` s1–s3 normal registration; `41-machine-sharing-and-project-terminals.md` s1–s3
current access; `42-requester-sessions-and-work-visibility.md` s1–s2 requester Sessions;
`63-shared-computer-browser-pip.md` s1–s3 normal viewer; `64-native-macos-and-display-capture.md` s1–s3 native
display/capture; `70-shared-ui-and-plugin-presentation.md` s1 choices/status and s4 fidelity/export reconciliation;
`71-action-placement-and-parity-integration.md` s1–s3 Action parity/approval. 
Provides: 56s1 Cua BYOC and 56s2 Fleet to 50s2–s3, 51s1–s3 and 52s1–s3, completing E's D12 sequence after 55s3 Crabbox.
BYOC → Fleet is roadmap order; ready implementation/qualification overlaps after the actual 50/shared Cua carrier (D42).

Authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,5–10 and `SYNTHESIS.md` D1–D42.
Deep/candidate reports and archived drafts are extraction evidence; current native docs/source establish mechanics. NEW type
names/files below are proposed, not existing public exports.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE2 names the Machine-provider plan-writing lane (plans 53–56).

## 1. Outcome and user value

- **RP-R1 — both remote routes:** a user can create compute in their own cloud through Cua BYOC or acquire a Fleet claim, privately enroll it, and use it as an
  ordinary Happier Machine/Session from every normal surface.
- **RP-R2 — exact ownership:** created BYOC resources and acquired Fleet claims have exact native cleanup; releasing a claim cannot delete a fleet pool.
  Existing external Spaces/VMs independently enroll through ordinary Add → Connect without a managed ownership/import mode.
- **RP-R3 — lifetime and cost truth:** native expiry/claim shutdown is separate from native power and disk/RAM continuity. 51 derives one Keep control for
  durable routes or Ends/native duration for finite-only routes; no indefinite Fleet/Modal lifetime or renewal promise.
- **RP-R4 — one canonical authority:** native Cua transport/codecs feed 50's one row and enrollment, 52's intents, ordinary Session/worker/viewer; no Cua
  persistent-agent/session/sharing/sync owner is adopted.
- **RP-R5 — current same-resource recovery:** uncertain acquisition/claim binding remains discoverable; install retry/wake never claims/recreates a replacement
  after absence. Credentials stay with exact approved controller custody.

Lab references: final lab `.happier/design-lab/lane12-final/` (D27): `m-add A/Ap`, shared configurator `m-config A/Ap/L/Lp`, `m-detail A/Ap`,
`m-pick A/Ap/Aprog`, `m-presets A/Ap`, `m-life A`
unavailable/uncertain/cleanup states, `b-wake S` and viewer `b-mac A/Ap/S`. Remote Cua leaves are required even
without distinct final painted cards; native lease/ownership facts extend the existing shared receipt anatomy, not a new
product shell.

### Primary vendor basis — bounded fetches 2026-10-05

| Leaf / shared boundary | Version and primary URL | Observed semantics |
| --- | --- | --- |
| Cua BYOC | Native CLI Cargo **0.1.0**, immutable source **2bce4442c107fc34c45b374b29a35d09f630fd83** [Cargo](https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83/libs/cua/Cargo.toml); current [your-cloud guide](https://cua.ai/docs/cua-sdk/guides/your-cloud) | AWS/GCP/Modal are documented routes; selected native cloud/location must be explicit. Native lifetime defaults differ from indefinite intent; AWS/GCP and Modal do not share an unlimited lease guarantee. |
| Cua Fleet | Same native source basis; current [Fleet API](https://cua.ai/docs/cua-sdk/reference/fleet) | Claim/acquire/attach are separate from pool management. Keep-alive changes lease and returns shutdown time; release releases the claim, not the pool. Read inspection must not renew it. |
| Spaces ownership | **cua-spaces v0.5.0**, [release](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.5.0); [Spaces API](https://cua.ai/docs/cua-sdk/reference/spaces) | Native remove unregisters; created Space delete versus address-import forget have different effects. |
| Component license | Immutable [spacesd license](https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83/libs/cua-spacesd/LICENSE) | FSL component/use qualification from 53 remains applicable; do not infer redistributability from a core SDK license. |

Fleet/Spaces vendor HTTP returned 200 through direct bounded fetches when web parsing failed; separate Claims page was
inaccessible and is not used as successful evidence. These rolling APIs are dated evidence, not a claim that a current
published JS SDK is version 0.1.0 (that is the native CLI Cargo version). 56s1/s2 pin the actual installed SDK/native
daemon and native cloud route versions before relying on a carrier. No live cloud/Fleet claim was made during authoring.

## 2. User flows, navigation, states and exact copy

Desktop: Settings → Machines → Add → Create → Cua BYOC or Fleet → 51 shared configurator. BYOC chooses explicit cloud
credential/backend/region/image/size and creates compute. Existing native Spaces use ordinary Add → Connect; no
create/connect mode in the managed configurator. Fleet chooses qualified namespace/runtime/image/size and reviewed
native claim lifetime/billing. Review exact controller and credential reference, capability-derived Keep OR finite Ends
and supported wake. Save preset/Use has no native effect; reviewed Create admits 50's managed id and progress. After
current private join, open the ordinary Machine; creation/lease facts remain in detail, current power/cleanup controls
come from 52.

Phone/browser: push rows use the same validated draft, with native ownership/expiry visible in sticky summary before
approval. The viewing device does not inherit vendor bearer. Back retains draft and input; closing progress never
releases a claim. Controller-offline can outlast a lease; show exact resource/claim and current/unknown expiration
separately. A finite ended resource offers explicit new acquire, not a misleading Wake that secretly claims another.

CLI/Agent/MCP/Voice: list/check/options read safe cloud/claim choices and costs; invoke canonical acquire with current
reviewed snapshot; inspect/cancel/bootstrap retry/delete/qualified intent by managed id. All mutations have human Ask
first default and same policy; Voice target follows ordinary Session identity, not visible provider card.
`session.spawn_new`, pending input, worker admission and computer Actions remain normal after enrollment. Client-only
navigation/copy uses 71 answering-surface boundary and is honestly unavailable without an app.

Common empty/loading/acquiring/installing/joining/error/unknown strings consume 50 §2's `managedMachines.*` owner with
descriptor title/noun and validated facts, plus 52 expiry consequences. Only Fleet capacity/claim-binding/release and
Cua-native diagnostics retain leaf keys. Those proposed plugin English keys live with
`packages/plugins/machine-cua/src/ui/translations.ts` and existing plugin locale projection:

| Key | English | State / recovery |
| --- | --- | --- |
| `managedMachines.credential.required` | 50 §2's exact credential state | Existing credential/setup front door |
| `machineCua.fleet.empty` | “No compatible Fleet capacity is available.” | Empty capacity; no pool provisioner or fallback |
| `managedMachines.options.loading/error` | 50 §2's exact option states | Read Retry, not new claim; draft retained |
| `managedMachines.permission.refused` / `.providers.unavailable` | 50 §2's exact common states | Exact native/credential/license diagnosis |
| `managedMachines.controller.waiting` | 50 §2's exact controller state | Retained exact recovery; native expiry remains independently visible |
| `machineCua.fleet.pending` | “Waiting for this claim to bind…” | Pending native claim, not a second acquire |
| `managedRetention.nativeExpiry` | 52 §2's exact expiry consequence | Fleet native expiry/51 Ends control, no hidden renewal |
| `machineCua.fleet.release` | “Release this claim. The Fleet pool will not be deleted.” | Destructive/interrupting review |
| `managedMachines.resume.unsupported` / `.cleanup.unknown` / `.price.unavailable` | 50 §2's exact common states | Separate approved acquire; exact cleanup; no invented price |

Native cloud setup/probe must not run a global `cloud connect` that silently changes the controller's default cloud.
Show explicit selected location in every receipt. Published default eight-hour BYOC lifetime is not Happier's retention
default: until-delete AWS/GCP launch uses the native documented explicit no-TTL setting only after qualification; Modal
remains native-capped and visibly finite. Fleet always shows lease facts, no indefinite promise.

Consume 51 §2/§8's sole receipt/configurator metric, motion and phone rules and 70's neutral selection anatomy; no leaf
density slots or receipt. At 390px prioritize native region/lifetime, ownership and readable native price units. Consume
52 D21, not the lab unused-stop default or a native pool count as budget.

## 3. Current owners and verified change map

**D21 facts:** report native locality, stopped compute billing, separate storage charges and capabilities through 50 §5; policy resolves only at 52 §5.

Observed basis HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`; broad discovery through `hstack-exec`, local ignored
labs/reviews remained authoritative. No source edits or clean-tree manufacture occurred.

| Path:line + symbol | Verdict | Exact change / seam owner |
| --- | --- | --- |
| `packages/protocol/src/plugins/contributions/families.ts:12` family helper; `catalog.ts:933` contribution catalog | EXTEND | Consume 50's family/schema, register qualified BYOC/Fleet references only |
| `packages/plugin-sdk/src/definePlugin.ts:2963` `definePlugin` | EXTEND | Public closed Machine-provider grammar, no second provider loader |
| `apps/cli/src/plugins/projection/families.ts:52` projection; `runtime/api/registrationRightsHost.ts:118` registration host | REUSE | Existing generated projection/manifest rights |
| `packages/plugin-sdk/src/managed-services/contract.ts:220` `ManagedServiceSpec`; `:323` `ManagedServices` | REUSE | Public native exec/credential transport at 50's owner; no absent `managed-services/io.ts` import |
| `apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.ts:14` | REUSE | Host-private file custody via public seam, no Cua keyvault as Happier secret authority |
| `packages/cli-common/src/systemTasks/nativeRemoteSshBootstrap.ts`; `kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` | CONSUME (50s2) | SSH-reachable BYOC returns canonical carrier and consumes 50's task/keypair/trust/install/cancel/progress; Fleet/native exec routes retain native carriers |
| `apps/cli/src/auth/remoteTerminalEnrollment.ts:89`; `persistTerminalEnrollmentCredential.ts:15` | REUSE / REFINE | Current normal protected enrollment/registration supplied by 50 and 40 |
| `packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts:177` | REUSE | Binary-safe guest payload; no SDK-driven npm/Python setup |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16` | EXTEND | 51 owns creation/detail front doors; plugin projects native facts only |
| `packages/plugin-ui/src/components/SelectionTiles.tsx:85`; `Collection.tsx:698` | EXTEND | 70 public card/comparison anatomy reused for remote Cua |
| `apps/ui/sources/components/ui/motion/motionTokens.ts:4` | REUSE | Existing morph/overlay/reduced-motion tokens |

NEW shared leaf package is owned initially by 53:

| Exact package file inventory |
| --- |
| `packages/plugins/machine-cua/{package.json,src/manifest.ts,src/activate.ts,src/index.ts,src/machine/{nativeClient.ts,schemas.ts,localSandbox.ts,localSpace.ts,provider.test.ts},src/ui/translations.ts}` |

56 adds `src/machine/{byoc.ts,fleet.ts}` and focused remote schemas/tests beside those files; edit shared native client
only for actual common transport. Extend the same manifest/activation, not another package with a rival Cua registry.
Membership source changes, if needed, use `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts` once at the
integrated batch; no direct generated edits.

Existing tests to reuse: Protocol `plugins/contributions/catalog.test.ts`, SDK `definePlugin.externalFixture.test.ts`,
CLI `auth/persistTerminalEnrollmentCredential.runtimeOrigin.test.ts` and
`plugins/runtime/invocation/services/managedServiceCredentialFileOwner.test.ts`, UI
`NewSessionMachineSelectionContent.test.tsx`, public UI `SelectionTiles.rnw.test.tsx`/`Collection.rnw.test.tsx`. No
current managed remote-Cua test is claimed; new tests live in the owned package.

## 4. Split-brains and migrations/removals

Canonical owners are 50 resource/enrollment/catalog, 51 configuration/presets, 52 policy/expiry/intent, 40–42
key/access/ordinary requester Session, 24 final execution and 63/64 viewer. One Cua client from 53 provides native
codecs; separately declared leaves do not imply a universal route with common guarantees. The current inspected
Machine-provider corridor has no BYOC/Fleet managed registration.

Every Machines Add/composer/preset/detail caller uses 51. Native Cua Space/claim registry is only external
evidence/identity, never Happier's Account/Home inventory or sharing authority. Cua cloud account config, keyvault,
relay shares, persistent agents, teleport and volumes are not copied into Happier. Existing manual connect/pairing
remains a distinct ordinary Machine ingress, not paid resource authority.

Remove any introduced direct `cua cloud` UI effect, native global default mutation, provider-specific claim queue,
automatic release/renew scheduler, token URL metadata, arbitrary Space deletion, pool destroy, custom VNC/SSH viewer or
duplicate ordinary Session. Native cloud id, sandbox id, Space registry id and Fleet claim id stay distinct qualified
fields, not aliases for a Machine id. Direct Modal (55) and Cua BYOC Modal are distinct native entry contracts;
each admitted managed row owns its exact returned identity. Do not add cross-entry discovery, a global collision
index or adoption machinery for hypothetical overlap.

## 5. Contracts: separate launch/identity unions

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 policy:** consume 52 §5 and 51’s single Keep/Ends control. Native expiry and unsupported power remain leaf facts.

**Reader/input classification:** Persisted/stored: ByocLaunchV1, ByocResourceV1, FleetLaunchV1 and FleetResourceV1
(cloud/nativeLifetime/owned attachments/claim/lease/expiry) in 50/51 rows/presets/recovery. Input/wire/event: those native leaf shapes at acquisition/report ingress,
bootstrap/role/options/lifecycle requests/outcomes and MachineProvisionerContributionV1.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

Callers use canonical 50 acquisition/read/cleanup Actions. Import its tolerant stored-reader/canonical-writer
`ManagedMachineV1`/`ManagedResourceV1` and strict input/outcome `AcquireResult`/`MachineProvisionerContributionV1` and
51 recipe types. The following are proposed provider-owned Zod/portable outputs, not public SDK replacements:

```ts
type ByocLaunchV1 = Readonly<{
  cloud: 'aws' | 'gcp' | 'modal';
  region: string; nativeImageId: string; nativeSizeId: string;
  nativeLifetime:
    | { kind: 'no-native-ttl' }
    | { kind: 'finite'; durationSeconds: number };
}>;
type ByocResourceV1 = Readonly<{
  cloud: 'aws' | 'gcp' | 'modal';
  nativeResourceId: string; sandboxId: string; spaceId?: string;
  ownedAttachmentIds: readonly string[];
}>;
type FleetLaunchV1 = Readonly<{
  namespace: string; runtimeId: string; imageId: string; sizeId: string;
  nativeLease: { durationSeconds: number };
}>;
type FleetResourceV1 = Readonly<{
  namespace: string; claimId: string; sandboxId?: string;
}>;
```

The canonical native schemas validate known option
ids/enums, cloud/region and native duration units. The cloud credential is captured once in 50’s admitted launch binding, not again inside BYOC launch choices.
`apps/cli/src/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority.ts#createManagedProviderOperationAuthority`
materializes each genuinely distinct declared purpose. If Cua gateway auth is separately required, declare that named
purpose there; never recapture cloud group/defaults. Actor/controller/Home/currentness remain 50’s. `no-native-ttl` is accepted only for qualified native AWS/GCP
routes; Modal finite requirement comes from the actual containing vendor. Fleet requested lease comes from actual native
allowed options; do not invent a numeric product cap/default. If native lease API does not accept a chosen duration, use
its observed expiry and remove unsupported choice at this leaf's schema, not an imaginary flag.

Fleet pending claim id is real native identity before sandbox binding; `sandboxId` becomes bound observation without
creating another row. Native RFC3339 shutdown time parses into 50's native-expiry observation with provenance. Expected
expiry is not confirmed resource absence; release/lookup must prove the correct claim is gone/released. Created Spaces
registry removal is distinct from owned native delete. BYOC refs store exact created provider identity/owned attachments
required for cleanup. Existing Spaces enroll through ordinary Add → Connect, without a managed acquire specialization,
import store or managed delete authority.

Native addresses/secret service URLs/bearers stay on the controller in the existing credential/IO owner; Home-visible
recovery fields are nonsecret qualification only. Settings/retention/preset revision/row relations/ordinary metadata are
exactly 50/51/52 and normal 40 registration; no leaf Prisma migration or server RPC. Native
claim/acquire/attach/release/observations travel through manifest-declared role Actions and authenticated controller
report, not a Fleet event bus or provider-owned pending queue. Price/capacity facts use 50's validated source/time/unit
shape; vendor cached config is not justification for a new Happier cache/freshness promise.

Bootstrap returns 50's selected native private exec/file carrier or `ManagedBootstrapCarrierV1` SSH
address/user/host-key evidence/credential reference. SSH-reachable allocation consumes the host-generated public half of
50's one controller-held per-resource keypair outside reusable preset choices; private material stays at its
credential-file owner. `remote.ssh.bootstrapMachine.v1` at
`systemTasks/kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` owns trust/install/approval/current
enrollment/cancel/progress and same-resource Retry; no BYOC SSH installer. Fleet/native exec carriers stay
route-qualified. Cua bearer-protected service gateway is a transport credential, not an Account Machine principal or
public Home URL. Native success/failure/cancel/recovery is characterized with the real selected SDK/native version. D3's
conditional requester-Session fallback is not authority to expose ordinary Account bearers in guest
image/env/registry/logs. If native driver installation lacks protected ordinary enrollment, that exact 50 carrier
requirement remains empirical/unqualified, not replaced by Cua's own Agent/Space account.

### Current policy and owner decisions

- **SETTLED — 50 MR-D1 and 52 RT-D1; native leaf remains facts-only (50 privacy):** minimum nonsecret native resource/claim ids/controller/intent/cleanup are
  Home-visible; credentials/gateway tokens/carriers remain local. Proposed fields: BYOC cloud/resource/sandbox/owned attachment ids; Fleet namespace/claim/bound
  Sandbox id. Qualify sensitive namespace/Space names before exposing, no bearer service URLs/native bags.
- Consume 51 §5 **MP-D1** for optional cap semantics; native capacity/TTL is not a new cap or Team budget.
- Consume 52 §5 **RT-D1/D21** for erasure and retention defaults; native expiry/cleanup evidence remains this leaf's responsibility.

## 6. Actions: all business operations and safety

Consume 50/51/52 §6 domain schemas and the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog) for approval and eligible dispatch.

Checks never mutate the default cloud or acquire/renew a claim. Reads never keep alive or wake. Ended claims cannot
reacquire through retry/Start; deletion targets only the created resource/claim, never pools or ordinary connected compute.

Existing Machine/session/access/computer Actions remain normal after join. Explicit native renewal/pool/image management
is **not** a newly promised Happier user operation in D12; native keep-alive is not invoked automatically by
inspect/wake/retention. If a future user request requires renewal, 52 must own a reviewed same-row intent and concrete
policy; do not sneak it into a read. “Create another” after ended resource is the same acquire Action with new reviewed
id/approval, not hidden refresh. Existing Spaces/VMs use incumbent ordinary Connect Actions; no managed
connect/disconnect aliases or native UI commands.

## 7. Plugin extensibility and what stays closed

**Consumed provisioner contract:** 50 §7 owns public family, activation, author fixture and credential custody. This leaf needs its actual producer/carrier and native success/failure/cancel/recovery characterization; the Lima/Hetzner roadmap does not gate independent work (D42).

Extend the 53-owned `machine-cua` manifest/activation through 50's single `machineProvisioners` family and closed public
SDK. BYOC and Fleet have separate strict launch/resource schemas and declared role references; qualified BYOC subroutes
may use a discriminated native union but cannot invent common power/lifetime semantics. Registration occurrence and
generated projection use the existing catalog/rights owner. No extra native Cua registry inside generic host, model
Provider/Agent ids or capability-as-gate.

Native installed dependency and in-process SDK belong to the Cua leaf. Select executable/package version at the public
managed dependency/IO owner; binary-safe runtime has no system Node/Python/package-manager spawn. 53's license
qualification remains applicable to bundled native components. Shared SDK exports use `*.public.ts`/package export
owner; plugins never import CLI/server/UI internals.

UI supplies facts/localized labels through existing plugin UI slots and `@happier-dev/plugin-ui` exports extended by 70.
Closed seams: Home/actor admission, credential materialization authority, current enrollment/retirement proof, durable
paid identity, retention/wake, queue/worker selection, workspace sync, Session lifecycle, shared Machine keys and
capture driver. Cua relay share/Keyvault/Agent session never substitutes for these.

## 8. Shared UI composition and motion

```text
51 ManagedMachineConfigurator on Machines / composer / preset / detail
  ItemGroup: credential + exact controller
  SelectionTiles + 70 preview extension: native images/runtimes
  Collection + 70 radio comparison: native cloud/size/capacity
  existing form rows: explicit cloud/region + capability-derived Keep OR finite Ends
  51 MachineConfigurationReceipt: ownership + price source/unit + independent lease/expiry
  existing footer / phone sheet: reviewed Create / Save preset
50 managed progress/detail → 52 native intent/release/cleanup
63 normal viewer → 64 qualified capture or honest unavailable
```

Consume 51 §8's shared radio/async-selection/phone/focus/reduced-motion contract and sole Keep/Ends control. Native
claim binding and lease changes update that fact model semantically; no Fleet-specific receipt, per-second live-region
countdown or unmount-triggered release.

## 9. Lifecycle, cancellation and recovery

Consume 50 §9's row-before-effect/uncertainty/recovery and 52 §9's intent/retention/wake/cleanup invariants. Native
claim labels/names aid observation but do not establish idempotency; native Sandbox binding belongs to the exact claim,
not a second purchase.

BYOC created: selected cloud/location → native resource/driver readiness → private install/current ordinary join.
Explicit native no-TTL setting is qualified per AWS/GCP; finite Modal and native maximum remain visible. Native power
capability is backend-specific; Stop disk/RAM/billing facts are not inferred from Cua's unified API. Created deletion
cleans exact proven-owned cloud resources/attachments and registry, retaining partial cleanup. Existing Spaces
independently enroll through ordinary Add → Connect and receive no managed cleanup controls. Never default `cloud
connect` during a read or override another user's global native config.

Fleet: claim/acquire → wait exact named binding → native Sandbox ready → protected ordinary enrollment. Lease/shutdown
observation is independent of daemon online and selected Keep. No hidden keep-alive loop, fleet-pool GC or namespace
management. Ended claim cannot resume by acquiring another; same native resource supported wake only is delegated to 52.
Release observes exact claim disposition and leaves pool/other claims untouched. “Missing claims are fine” native
release behavior does not imply a secret gateway error is absence; current authorization/lookup schema still decides
evidence.

Consume 50/52's cancellation, late-identity, controller-loss, admission/retention and accepted-input wake contracts
without a leaf policy/queue. Native cleanup deletes only created BYOC resources or releases the exact Fleet claim;
ordinary Connect remains outside cleanup. Native lease expiry is disclosed as independent of host work/policy.

## 10. Compatibility and existing native data

Authoring predecessor basis: `../0.2` HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`; scoped auth/key, plugin SDK and
Protocol Machine paths clean. Actual legacy/dataKey Machine encryption contexts remain readable through 40's ingress;
newly enrolled remote Cua uses normal Machine registration and fresh resource authority. Token-only ordinary Account
credentials are not assumed restricted and Cua bearer is not a Machine key.

No observed predecessor BYOC/Fleet managed row/writer establishes an old persisted provider format. Refactor 0.3-only
family/leaf intermediates in place, no unreleased dual-write/reverse shim. Existing ordinary
Machines/Sessions/pending/historic transcripts stay under their current owners after native expiry. Native existing
Spaces/cloud resources/claims remain external identities; ordinary Add → Connect enrolls them without reinterpreting
enrollment as allocation ownership. 50/53/publication owner refresh moving sibling paths and immutable supported
released contracts before implementation; this scoped inspection does not certify all SDK/artifact directions. Published
strict schema evolution follows `docs/compatibility.md` at the single seam.

## 11. Slices, tests and completion boundaries

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**Native-fact RED:** strengthen the native adapter suite below to discriminate its actual billing/capability/expiry facts. Category invariance and precedence are tested once at 52s1; receipt/control wiring is tested at 51s2.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

Proposed commands/evidence only; no tests/builds/native calls were run while writing this draft. Broad
analysis/tests/typechecks/builds route through `./apps/stack/bin/hstack-exec -- …` and public package scripts; no
`*:local`, bare compiler or frozen release representation. New package public scripts follow existing plugin conventions
established in 53; membership source/generator changes remain local, regenerated once per coherent integration.

Exact focused command once 53 creates the package: `./apps/stack/bin/hstack-exec -- yarn workspace
@happier-dev/plugins-machine-cua test src/machine/provider.test.ts`. Package scripts/config follow observed
`packages/plugins/claude/package.json`; add package-owned test/compiler configuration rather than allowing the new tests
to be excluded. Run the same workspace's public `typecheck`/`build`, then changed hosts' public lanes
(`@happier-dev/cli`, `@happier-dev/app`, `@happier-dev/protocol`, `@happier-dev/plugin-sdk`) through the executor once
per coherent integrated boundary. No direct `*:local` execution.

Documentation co-lands with these native leaves at the existing `apps/docs/content/docs/apps/control-panel.mdx:64`
Machines section: created BYOC cleanup versus ordinary Connect, explicit cloud/lease/price and Fleet release-versus-pool
distinction. Coordinate that hunk with 51/53/54/55, rather than adding separate Cua lifecycle documentation. Update
`apps/docs/content/docs/apps/remote-hosts.mdx` only if consumed SSH setup changes. 50 owns common family/public SDK
guidance in `docs/plugin-platform.md` and its published projection; remote leaf examples use that single explanation.
Label actual 0.3 development/preview availability, read docs instructions/skill and run docs checks on implementation
edits, without unrelated Relay cleanup.

### 56s1 — BYOC creation and exact native cleanup

- Consumes 50s1–s3, 53s2–s3 real adapter/private carrier and 51s1–s3; provides RP-R1–R5 explicit BYOC created-resource route/native lifetime.
- Touch `packages/plugins/machine-cua/src/machine/{byoc.ts,schemas.ts,nativeClient.ts,provider.test.ts}`, manifest/activation/translations; shared file
  changes coordinate with 53 by actual hunk. No connected-resource specialization or managed import union is added; ordinary Connect stays at its incumbent
  owner.
- **RED:** NEW cases in `packages/plugins/machine-cua/src/machine/provider.test.ts` : native created-resource cleanup → exact owned resource/attachments
  mapped, unrelated resources untouched, and registry-success/native-delete-failure remains incomplete rather than absent. Requested explicit cloud must not
  mutate global default or silently choose a different backend. AWS/GCP until-delete maps to the qualified native no-TTL choice; Modal retains finite native
  expiry instead of indefinite promise. Mock vendor/native process/HTTP/exec-file/clock boundaries only, not schema/ownership/managed admission/policy.
- GREEN route-qualified mapping and private bootstrap; extend 50 owner schema/currentness tests only for real consumed changes. Run Cua public focused tests,
  `@happier-dev/plugins-machine-cua` public typecheck/build; CLI public typecheck/build for importing closure; Protocol/SDK/UI public lanes if touched, plus
  affected 50/52 and existing credential-file/registration tests. Existing public-author/catalog checks amortize at integrated family boundary.
- Completion requires created-resource wiring in all four hosts and ordinary Connect retained for existing Spaces, exact external ownership preserved, no
  global native default mutation, native lifetime truthful, same-id recovery/private normal enrollment and runnable §12 segment. No fake VM or Cua-account
  Session fallback.

### 56s2 — Fleet exact claim and expiry

- Consumes 56s1 shared native boundary, 50 row/private carrier and 52 native expiry/wake; provides separately declared Fleet contribution RP-R1–R5 without pool
  ownership or implicit renewal.
- Touch `machine-cua/src/machine/{fleet.ts,schemas.ts,nativeClient.ts,provider.test.ts}`, manifest/activation/translations; no server claim queue/table or
  Fleet pool controller.
- **RED:** same NEW package test owner: native claim-without-Sandbox maps pending with exact claim id, a dropped attach response preserves that id, and bound
  observations correlate the same claim/Sandbox rather than decoding a new allocation. Read inspect must not extend lease; native expiration maps ended with
  unsupported resume. 50/52 own same-row retry and no-replacement pending-wake tests. Release must leave pool/other claims, and unreachable bearer gateway must
  not become confirmed absence. Mock Fleet HTTP/native exec/file/clock only, real strict schemas/admission/native mapping/row/wake owner.
- GREEN exact claim/acquire/attach/release/expiry codecs and protected enrollment. Run Cua public tests/typecheck/build plus affected 50/52 pending-input and
  credential tests; changed CLI/Protocol/SDK/UI public lanes once at integrated batch.
- Completion: all hosts show current/unknown claim expiry and release consequence, no native pool delete/hidden renewal, same-resource recovery/currentness and
  ordinary Session wiring proven, introduced direct native consumers removed, runnable §12 segment recorded. Native release is not labeled retained Stop.

BYOC/Fleet research and strict adapter preparation can overlap once 50/53 producer exists; roadmap s1 → s2 does not gate independent Fleet qualification. Shared `nativeClient.ts` and manifest edits coordinate only actual collisions, not dirty-file reservations. Final
completion needs every relevant migrated caller/removal, meaningful owner-level RED→GREEN, package lanes and runnable
source/live evidence; registration or a still-running command is not a gate result.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 56s1 | IMPLEMENTED (focused GREEN) | `ce9b346ec3`, `633acda94d`, `51b7cbf32d`, `f1bf5fbff7`, `53b3fb93f9`, `b21f46377a` | [C56](../../reviews/2026-10-02-lane12-replan/impl-C/C56.md) historical producer holds are followed by [FX3A](../../reviews/2026-10-02-lane12-replan/impl-C/FX3A.md)/[FX5](../../reviews/2026-10-02-lane12-replan/impl-C/FX5.md) activated roles/recovery and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) selected AWS/GCP versus Modal retention GREEN; [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) confirms source correction. [CD2/CD7/CD9/CD12/CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) retain plural purposes and unconfirmed missing-record cleanup. | Common gate; regenerate remote Cua variants/duration binding, then current captured cloud+Cua purpose→private bootstrap→ordinary enrollment/retry/exact cleanup and selected native lifetime. Missing native BYOC records stay unconfirmed under CD9. | Authorized AWS/GCP/Modal BYOC tenant, real credentials/transport/billing/expiry/owned cleanup; native platforms, physical devices and signing. |
| 56s2 | IMPLEMENTED (focused GREEN) | `ce9b346ec3`, `633acda94d`, `51b7cbf32d`, `f1bf5fbff7`, `b21f46377a` | [C56](../../reviews/2026-10-02-lane12-replan/impl-C/C56.md), [FX3A](../../reviews/2026-10-02-lane12-replan/impl-C/FX3A.md), [FX5](../../reviews/2026-10-02-lane12-replan/impl-C/FX5.md) and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) record exact pending/bound claim, token/native IO, recovery/release and native lease binding GREEN under [CD2/CD7/CD12/CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md). | Common gate; regenerate stale Fleet native-duration declaration, then exact claim→bound sandbox→private ordinary enrollment/same-id Retry→expiry/release. Inspect never renews; pool/other claims remain outside cleanup. | Authorized Fleet tenant/capacity, real claim lease/transport/pricing/billing/exact release; native platforms, physical devices and signing. |

## 12. Live QA segment and once-only release checks

Consume 50 §12’s acquisition journey plus 51/52’s owned segments and the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule.

Add BYOC explicit cloud/region and exact owned cleanup, Fleet pending claim→bound Sandbox identity, lease expiry and
claim release to the shared creation journey. Reads change no global cloud default and never renew a lease. Cancel/late
binding and same-id Retry preserve the exact claim/resource; pool/other claims and ordinary connected compute stay
untouched. The one captured cloud-purpose binding supplies native IO; a distinct gateway purpose is declared separately.

Real native spend/destruction needs an authorized target. Name an unavailable runtime prerequisite; never claim a
boundary fixture proves real vendor success. External hardware/tenant evidence consumes the index’s sole
[Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; no per-leaf release gate or representation.

## 13. Economy, exclusions and justified variation

No Fleet pool/autoscaler/GC owner, keep-alive scheduler, BYOC global default rewriter, Cua account/keyvault/sharing
mirror, provider queue, automatic replacement wake, cleanup escrow, custom VNC/SSH/Agent runtime, native persistent
agents/teleport/volume sync, extra credential table or generic mode guaranteeing common lifetime. Two separate native
contributions are justified by D12 and distinct ownership/lifetime, not a new general cloud platform. 53's one native
boundary is reused only for actual shared transport; direct native power/cost/policy stays in 50/52. Native lease expiry
is external behavior, not an invented Happier safety timeout.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

- **Empirical 56s1:** exact native BYOC SDK/CLI/backend versions, no-TTL versus capped route, cloud credential scope/default mutation behavior, created
  attachments and exact Space/native cleanup; private carrier/license from 53 and 50. Until-delete translation uses actual native support, never unsupported
  flags.
- **Empirical 56s2:** actual native claim lease options/expiry units, paid scope/prices/absence/release semantics and protected guest exec/file; correct native
  Mac/Linux image/capture follows 64 rather than a vendor brochure. Claims page fetch failure is not contract evidence.
- **Empirical 50/52:** exact returned resource identity, same-resource controller custody and privacy; no speculative cross-entry collision search. If a route cannot
  privately enroll an ordinary Machine or prove ownership, identify the affected requirement and smallest amendment; do not drop remote Cua breadth or
  substitute its own Session/account runtime.

History: see archive-r8.4 and the review folder
