# Lane 12.53 — Local Lume and Cua Machine providers

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**  
Date: **2026-10-06**  
Plan-writing owner: **PE2**. Approval is not recorded; this document authorizes no implementation or native allocation.

Supersedes: [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md)
Lume, Cua local sandbox and Cua Spaces local; preserves D5/D12 breadth while replacing
provider-specific host lifecycle proposals. 
Extends: `50-managed-resources-and-enrollment.md` s1–s3 with three consumed native leaves;
`51-managed-presets-and-creation.md` s1–s3 with local image/runtime facts, not another configurator. 
Consumes: `50-managed-resources-and-enrollment.md` s1 family/SDK and s2–s3 durable resource/enrollment/recovery;
`51-managed-presets-and-creation.md` s1–s3 options/receipt/composer; `52-managed-retention-and-wake.md` s1–s3 retention,
exact-controller power and cleanup; `24-native-execution-environments.md` s1–s3 final environment admission;
`40-machine-content-key-lifecycle.md` s1–s3 normal registration; `41-machine-sharing-and-project-terminals.md` s1–s3
access; `42-requester-sessions-and-work-visibility.md` s1–s2 requester Sessions; `63-shared-computer-browser-pip.md`
s1–s3 ordinary viewer; `64-native-macos-and-display-capture.md` s1–s3 macOS/whole-display support;
`70-shared-ui-and-plugin-presentation.md` s1 public choices/status anatomy and s4 fidelity/export reconciliation;
`71-action-placement-and-parity-integration.md` s1–s3 approval/dispatch. 
Provides: 53s1 Lume, 53s2 Cua local sandbox, 53s3 Cua Spaces local to 50s2–s3, 51s1–s3 and 52s1–s3; 53s2–s3 shared
native Cua boundary to `56-cua-byoc-and-fleet-providers.md` s1–s2. Lume follows Lima/public-family readiness; Cua routes need their shared native carrier. Provider order is a roadmap,
not a gate on independent research, adapter implementation or qualification (D42).

Authority: `ARCH-SYNTHESIS.md` §§1.5,2,3E,5–10 and `SYNTHESIS.md` D1–D42 in
`.project/reviews/2026-10-02-lane12-replan/`. `lanes/deep-E.md`, `lanes/provider-candidates.md` and archived drafts are
discovery aids, not live guarantees. Lab files are
`.happier/design-lab/lane12-final/{screens-x-machines.js,x-machines.css}`. Proposed files/types below are **NEW** unless
identified as observed.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE2 names the Machine-provider plan-writing lane (plans 53–56).

## 1. Outcome and user value

- **LP-R1 — ordinary Machines:** from desktop, phone, CLI or an agent, choose an exact reachable controller, create local Lume/Cua compute, install Happier
  privately, then start an ordinary Session. Machines remain independently useful for terminals, workers and the shared computer viewer.
- **LP-R2 — one authority:** every acquisition, late result, cancellation, retry, power intent and cleanup flows through 50/52's one managed row. No
  plugin-owned Session, guest credential authority or restart queue.
- **LP-R3 — truthful local facts:** selected image/runtime determines platform, hardware, licensing, capture and lifecycle. Fixed physical placement does not
  impose a local-Team ban or a universal two-guest cap.
- **LP-R4 — exact recovery:** installation retry uses the bound resource, never another purchase/create. Controller-offline and uncertain native absence remain
  distinct; local resources cannot be reassigned to an unrelated computer.

Lab references: final lab `.happier/design-lab/lane12-final/` (D27): `m-add A/Ap`, `m-config L/Lp` image-first Lume and stable receipt, `m-detail A/Ap`,
`m-pick A/Ap/Aprog`, `m-presets M/Mp`, `m-life A`, `b-wake S`, viewer `b-mac A/Ap/S`. Cua local variants use the same
established configurator anatomy even where the lab labels only Lume; this does not remove undrawn D12 leaves.

### Primary vendor basis — bounded fetches on 2026-10-05

| Leaf | Version / primary URL | Observed contract and implementation consequence |
| --- | --- | --- |
| Lume | **0.6.1**, [release](https://github.com/trycua/cua/releases/tag/lume-v0.6.1); [HTTP API](https://cua.ai/docs/lume/reference/http-api) | Storage-qualified VM identity and native create/run/stop/delete; several causes share HTTP 400, so 400 alone does not prove absence. This supersedes the research report's 0.6.0 basis. |
| Cua local sandbox | Native CLI Cargo **0.1.0**, inspected source **2bce4442c107fc34c45b374b29a35d09f630fd83**; [Cargo source](https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83/libs/cua/Cargo.toml); [sandbox CLI](https://cua.ai/docs/cua-cli/reference/cli/sandbox) | Select local namespace and native runtime explicitly. Cloud/Fleet behavior is not inferred from the same CLI noun. Resume and destruction are qualified per runtime. |
| Cua Spaces local | **cua-spaces v0.5.0**, [release](https://github.com/trycua/cua/releases/tag/cua-spaces-v0.5.0); [Spaces API](https://cua.ai/docs/cua-sdk/reference/spaces) | Created Space deletion and address-import removal are different: removing a registry entry does not destroy a sandbox. Managed creation uses exact owned sandbox cleanup; existing Spaces use ordinary Add → Connect, with no managed destroy authority. |
| Cua license boundary | Same immutable source; [spacesd license](https://raw.githubusercontent.com/trycua/cua/2bce4442c107fc34c45b374b29a35d09f630fd83/libs/cua-spacesd/LICENSE) | FSL terms require component/use qualification; an SDK/core license is not blanket permission to redistribute native daemons/apps. |

Rolling documentation is dated evidence, not an immutable SDK release. 53s2 records the actual selected SDK package
version and runtime/image manifest before relying on it. Web parsing of Spaces intermittently failed; direct vendor HTTP
returned 200 and confirmed create/delete/remove semantics. No physical local runtime was started during plan authoring.

## 2. User-facing flows, navigation, states and copy

Desktop: Settings → Machines → Add → Create → Lume, Cua sandbox or Cua Spaces → 51's shared configurator. Show the
controller name and OS; “On this Mac” applies only when the selected controller is that Mac. Image cards precede size
for Lume; runtime/image facts precede compatible Cua sizes. Save preset and Use select a recipe without allocating.
Reviewed Create admits 50's managed id, immediately opens progress, and later links to the ordinary Machine. Machine
detail reuses the creation receipt read-only; editable Keep/power controls call 52.

Phone/browser: the device is a client, not a local VM executor. Choose a reachable capable computer → provisioner → same
validated choices in a narrow layout → sticky summary sheet → approval → progress. Back/close preserves the draft and
never implies cancellation. If the controller disappears, show its identity and the same managed id; do not offer a new
local create as Retry. Preset settings, archive/restore and composer progress use 51's existing paths.

CLI/Agent/MCP/Voice: list/check/options read safe facts; acquire with the same validated choices and reviewed
credential/controller; inspect/cancel/bootstrap retry/power/delete by managed id. Existing `session.spawn_new` starts on
the enrolled ordinary Machine. Voice is not disabled by provider; approval cannot be self-decided. Client-only
navigation needs 71's answering app and otherwise returns unavailable, whereas admitted daemon operations use the
existing transport.

Use 50/51/52's common state strings for empty, loading, acquiring, installing, joining, error, canceled and uncertain
cleanup; do not introduce another progress vocabulary. `machineLume.empty` belongs to
`packages/plugins/machine-lume/src/ui/translations.ts`; common state keys below consume 50's `managedMachines.*` owner
and 52's native-power consequences, interpolating descriptor title/noun and validated facts. Leaves keep only native
image/runtime/license diagnostics, never another generic state family. Translate all supported locales; these are exact
proposed English strings, not native error prose.

| Proposed i18n key | English | State / action |
| --- | --- | --- |
| `machineLume.empty` | “Choose an image to create a machine.” | Empty image list; qualified macOS/Linux guest choices, no fake image |
| `managedMachines.options.loading/error/unavailable` | 50 §2's exact choice states | Draft retained; Retry options, not acquire |
| `managedMachines.controller.waiting` / `.providers.unavailable` | 50 §2's controller/prerequisite states | Exact controller and leaf diagnostic; ordinary repair |
| `managedMachines.permission.refused` / `.power.pending` | 50 §2's exact permission/native-pending states | No authorization-as-missing-runtime or optimistic settlement |
| `managedPower.stoppedStorage` | 52 §2 plus validated disk/RAM consequence | Only when the runtime proves retained disk; no RAM promise |
| `managedMachines.cleanup.unknown` / `.capture.unavailable` / `.resources.headroomUnknown` | 50 §2's exact common states | Exact recovery, unsupported capture, unknown measured headroom |

Lab → app reconciliation: image cards/radio table consume 70's shared `SelectionTiles`/`Collection` semantics and 51's
configurator/receipt metric reconciliation. Lab 56px image/48px comparison rows and 30px separation are reference intent
mapped by 51 to existing density/spacing owners (52/40/28 page defaults), not new 70 slots or fixed leaf metrics. Use
typography/theme tokens and 390px phone reference without shrinking text. Retention consumes 52's settled D21
local-category Stop after 1 h unused + wake, subject to explicit user/preset/machine overrides and truthful native
support. Lab cost/capacity claims are not copied: price comes only from sourced native facts, and host headroom is
measured or unknown. Keep location/controller detail visible after selecting a card.

## 3. Current owners and exact change map

**D21 facts:** report native locality, stopped compute billing, separate storage charges and capabilities through 50 §5; policy resolves only at 52 §5.

Observed against current checkout HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`; paths/symbols checked locally, broad
inventory routed through `hstack-exec --local` because ignored lab/review files are authoritative here. This basis
describes source, not a frozen artifact.

| Observed path:line + symbol | Verdict | Exact change / responsible owner |
| --- | --- | --- |
| `packages/protocol/src/plugins/contributions/families.ts:12` `definePluginContributionFamilyV2`; `catalog.ts:933` `PLUGIN_CONTRIBUTION_CATALOG_V2` | EXTEND | Consume 50s1's single `machineProvisioners` family; only register these declared leaf ids |
| `packages/plugin-sdk/src/definePlugin.ts:2963` `definePlugin` | EXTEND | Author leaves through 50's closed public grammar; no raw `contributes` escape hatch |
| `apps/cli/src/plugins/projection/families.ts:52` `definePluginProjectionFamilyV2` | REUSE | Consume generated contribution projection; no Lume/Cua switch in generic host |
| `apps/cli/src/plugins/runtime/api/registrationRightsHost.ts:118` `createContributionRegistrationHost` | REUSE | Existing manifest occurrence rights enforce activation |
| `apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.ts:14` `createManagedServiceCredentialFileOwner` | REUSE | Host-private credential-file materialization via public capability; never import this host file from a plugin |
| `apps/cli/src/auth/remoteTerminalEnrollment.ts:89` `runRemoteTerminalEnrollment`; `persistTerminalEnrollmentCredential.ts:15` persistence | REUSE / REFINE | 50 owns protected enrollment and normal registration; local leaves provide only native transport/evidence |
| `packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts:177` `installVersionedPayload` | REUSE | Binary-safe guest payload acquisition at the canonical owner; no `npm install`/Node bootstrap |
| `apps/cli/src/daemon/computer/driver/managedComputerDriver.ts:44` `createManagedComputerDriver` | EXTEND | 64 owns macOS/display qualification; current X-display implementation is not proof of macOS control |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16` `MachinesSettingsView`; `components/sessions/new/components/NewSessionMachineSelectionContent.tsx` | EXTEND | 51 mounts the contributed facts in both real front doors; leaves do not add routes |
| `packages/plugin-ui/src/components/SelectionTiles.tsx:85` `SelectionTiles`; `Collection.tsx:698` `Collection` | EXTEND | 70 supplies public preview/card/comparison anatomy with these local consumers |
| `apps/ui/sources/components/ui/motion/motionTokens.ts:4` `motionTokens` | REUSE | Shared interaction/morph/reduced-motion tokens, no leaf animation constants |

New leaf owners:

| Exact package file inventory |
| --- |
| `packages/plugins/machine-lume/{package.json,src/manifest.ts,src/activate.ts,src/index.ts,src/machine/{provider.ts,schemas.ts,nativeClient.ts,provider.test.ts},src/ui/translations.ts}` |

`packages/plugins/machine-cua/` has the same package front door and
`src/machine/{nativeClient.ts,localSandbox.ts,localSpace.ts,schemas.ts,provider.test.ts}`. These are Machine providers,
not entries in model `providers` or executable `agents`. 56 adds `byoc.ts`/`fleet.ts` to the same Cua package; it
consumes rather than redesigns the adapter.

Existing harnesses: `packages/protocol/src/plugins/contributions/catalog.test.ts`,
`packages/plugin-sdk/src/definePlugin.externalFixture.test.ts`,
`apps/cli/src/auth/persistTerminalEnrollmentCredential.runtimeOrigin.test.ts`,
`apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.test.ts`,
`packages/plugin-ui/src/components/{SelectionTiles,Collection}.rnw.test.tsx`, and
`NewSessionMachineSelectionContent.test.tsx` adjacent to the component above.

## 4. Split-brains contracted here

Canonical winners are 50's row/enrollment/family, 51's configuration model, 52's intent/retention owner, and 63/64's
normal computer transport. The current inspected family/SDK/Machine corridor has no active Lume/Cua managed provider
registration; these leaves are additions, not a justification for duplicating generic lifecycle logic.

Migrate every consumer of the new options through 51: Machines Add, composer, preset editor, detail. Provider callbacks
return strict facts to 50; they never mutate Machine metadata or set thinking/session lifecycle. Retain Cua's native
registry solely as an external identity/transport adapter, not Happier's inventory or sharing authority. Existing native
addresses enroll through ordinary Add → Connect; no managed connect/import mode or extra paid row.

Delete any implementation introduced during the slice that offers direct native power/create from UI, independent
enrollment retries, private viewer, copied Account keys, provider profile persistence or automatic Cua cloud fallback.
Existing manual SSH/connect and owner-only 0.2 key readers stay for their different released ingress contracts; they do
not write this family. Lume and Cua can refer to related native VM engines, without requiring cross-engine discovery or a global native-name collision index. One managed row owns its returned
exact identity; no adoption feature or speculative cross-entry collision machinery is added.

## 5. Contracts: tolerant stored leaves and strict native inputs

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 policy:** consume 52 §5 and 51’s single Keep/Ends control. Native expiry and unsupported power remain leaf facts.

**Reader/input classification:** Persisted/stored: LumeLaunchV1, LumeResourceV1, CuaLocalLaunchV1 (shared by sandbox and Space routes)
and CuaLocalResourceV1 when read from 50/51 rows/presets/recovery records. Input/wire/event: those same native leaf shapes at acquisition/report/role ingress,
MachineProvisionerContributionV1 and bootstrap/native lifecycle request/outcome schemas.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

Callers use `machines.managed.acquire` and never call the native adapter to decide authority. Use 50's
`ManagedMachineV1`, `ManagedResourceV1`, `ValidatedLaunchSnapshot`, `AcquireResult` and strict
`MachineProvisionerContributionV1`; do not fork those schemas. The following are proposed leaf schema outputs, not
already exported SDK types:

```ts
type LumeLaunchV1 = Readonly<{
  image: { kind: 'catalog'; id: string } | { kind: 'native-image'; reference: string };
  storage: string; cpu: number; memoryBytes: number; diskBytes: number;
}>;
type LumeResourceV1 = Readonly<{ storage: string; vmName: string }>;
type CuaLocalLaunchV1 = Readonly<{
  on: 'local'; runtimeId: string; imageId: string;
  size: { cpu: number; memoryBytes: number; diskBytes: number };
}>;
type CuaLocalResourceV1 =
  | Readonly<{ kind: 'sandbox'; namespace: 'local'; runtimeId: string; sandboxId: string }>
  | Readonly<{ kind: 'space'; spaceId: string; sandboxId: string; runtimeId: string }>;
```

Native shapes consume the index Stored contracts rule. IDs are native-returned and revalidated against
selected options; numeric sizes use native units/valid choices, not guessed caps. Lume storage/name are qualified by the
exact controller installation in 50. Do not hand-roll home expansion: native paths use the CLI path owner. User-selected
image references are validated native inputs, not arbitrary shell commands. Space addresses/tokens remain private
transport/credential facts; only created resource ids enter the canonical row. 50 MR-D1 qualifies concretely sensitive
names.

Register qualified ids such as `lume`, `local-sandbox`, `local-space` within their respective plugin manifests.
`local-space` owns creation only. Existing Spaces/VMs use ordinary Add → Connect without managed power/delete/preset
authority; no import schema, Action or store. Settings/presets, row persistence, Home/current actor, controller
identity, retention and wake settings are exactly 50/51/52's; no local Prisma migration/table. Guest metadata uses
ordinary registration/key adoption and only already defined 50 kind/resource linkage. No credential, provider RPC or new
native-event bus is added. Native evidence enters existing authenticated controller reports with expected intent
revision; ordinary Machine online events stay distinct from power evidence.

Private carrier: protected guest exec/file returns 50's native bootstrap carrier; SSH-reachable guests return its
`ManagedBootstrapCarrierV1` address/user/host-key-evidence/credential reference and consume
`packages/cli-common/src/systemTasks/kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` /
`remote.ssh.bootstrapMachine.v1`. Host trust, binary install, approvals, enrollment/cancel/progress and the
controller-held per-resource keypair stay at 50's task stage, with no leaf SSH installer. Existing
`ManagedServiceSpec`/`ManagedServices` in `packages/plugin-sdk/src/managed-services/contract.ts` and `index.public.ts`
are real owners; the old research citation `managed-services/io.ts` is absent and must not be imported. Characterize
credentials in logs, argv, image manifests, native registry and failure output. D3's requester-Session fallback does not
approve arbitrary guest bearer exposure. If a runtime lacks a private carrier, mark that route unavailable and bring the
affected 50 enrollment requirement to its owner; do not silently switch to a different runtime/cloud.

### Current policy and owner decisions

- **SETTLED — 50 MR-D1, 51 MP-D1 and 52 RT-D1; native leaf remains facts-only (50 privacy):** Home-visible recovery contains minimum nonsecret native
  identity/controller/intent/cleanup fields; credentials/carriers remain local. Proposed exposed refs are Lume storage/name, Cua namespace/runtime/sandbox/Space
  id. Sensitive storage names require 50's concrete privacy decision, not an arbitrary native JSON bag.
- **SETTLED — 50 MR-D1, 51 MP-D1 and 52 RT-D1; native leaf remains facts-only (51 optional simultaneous limit):** no default cap or Team budget. Preserve
  optional user control; consume settled 51 MP-D1 acquired/uncertain plus retained-stopped semantics at 50's admission transaction. This leaf adds no local cap.
- **SETTLED — 50 MR-D1, 51 MP-D1 and 52 RT-D1; native leaf remains facts-only (52 erasure):** emergency revoke unconditional; normal erasure presents exact
  retained resource/cost and explicit cleanup/manual-responsibility disposition. Missing local controller does not prove delete.

## 6. Actions and approval parity (D16)

Consume 50/51/52 §6 domain schemas and the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog) for approval and eligible dispatch.

Native checks never boot or mutate a VM. Start cannot recreate; delete targets only the created Space/sandbox.
Physical local control cannot move; ordinary Connect admits existing resources.

Contributed `check/options/acquire/bootstrap/inspect/power/destroy` roles are manifest-declared references under
50’s canonical admission; public read-only roles do not grant native-effect authority. Existing Machine
access and `session.spawn_new`/`session.message.send` remain normal Actions after enrollment. Role exposure consumes 50 §6: daemon/same-plugin declarations; read-only roles may be public, effectful roles always
require canonical admitted custody. No native-effect shortcut. Ordinary Add → Connect handles existing Spaces/VMs; no managed import/disconnect
specialization.

## 7. Plugin extensibility and closed seams

**Consumed provisioner contract:** 50 §7 owns public family, activation, author fixture and credential custody. This leaf needs its actual producer/carrier and native success/failure/cancel/recovery characterization; the Lima/Hetzner roadmap does not gate independent work (D42).

Use 50s1's `definePlugin({ machineProvisioners, actions })` adapter and single `activate(api)` ABI. Strict portable leaf
launch/resource schemas and role references project through `PLUGIN_CONTRIBUTION_CATALOG_V2`, CLI projection and
existing registration rights. One Cua native adapter services separately qualified local/BYOC/Fleet contributions;
extending it requires the same contract, not a new host registry or a generic mode that invents lifecycle parity.

Native executable resolution/validation uses the public managed dependency/executable contract and binary-safe spawn,
with the dependency owned by the leaf package. Do not require system Node/Python/package managers to run shipped host
code. Bundled versus user-installed native component is selected only after license/platform qualification. Generated
projections remain owned by `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`; update manifest/membership
inputs, then regenerate once at the integrated batch, never hand-edit generated arrays.

Plugin UI supplies facts, localized labels and supported public presentation slots, importing `@happier-dev/plugin-ui`
only. 70's shared anatomy is the allowed extension; the public UI component does not choose permissions, retain
credentials or purchase compute. Closed host seams: row writer, approval/currentness, enrollment proof, lifecycle,
prompt custody, worker admission, sharing keys and computer driver. No Agent/model-provider family misuse or
host-internal imports.

## 8. UI composition and motion

```text
MachinesSettingsView / NewSessionMachineSelectionContent / Preset settings / Managed detail
  51 ManagedMachineConfigurator (one validated draft/fact owner)
    70 provider/controller choice anatomy
    SelectionTiles + 70 image preview/caption extension
    Collection + 70 radio/comparison cells (Cua runtime/size)
    existing Item/ItemGroup form rows: storage, credential, Keep
    51 MachineConfigurationReceipt + its metric reconciliation → existing panel on desktop / sheet on phone
  50 progress/detail body → ordinary Machine destination
  63 shared computer content → 64 native display adapter when supported
```

Keep selection immediate, keyboard arrows roving within radio choices, one selected accessible value and persistent
focus. Receipt values update from the same selected facts; do not debounce business state. Lab's 90ms text blur and
320ms bars are decorative: use `motionTokens.durationMs.fast/base`, `durationMs.slow` only for the nonsemantic meter,
and shared `inPlaceMorph` for receipt height/content. Phone summary uses existing panel/popover overlay tokens with
scrim, focus containment and focus return. Reduced motion removes blur/scale travel and uses the existing reduced-motion
morph. Do not animate progress to simulate installation or reset browser/Session state when the viewer floats.

## 9. Lifecycle, cancellation and recovery

50 persists unsubmitted → may-exist before native effect → bound exact resource; only native proof permits
confirmed-absent. Lume successful create is not boot or daemon-online; Cua registry presence is not native execution.
Labels/names help locate an uncertain effect but are not a vendor idempotency guarantee. Lost create response cannot
trigger another create; return unknown and preserve native query/manual cleanup facts.

Bound → install → current enrollment → ordinary online are 50's existing distinct facts. Retry reads the same
storage/name or sandbox/Space id. Cancel invalidates start/enrollment continuation, then destroys only owned compute
under current approval; late returned identities still bind for cleanup and cannot enroll a canceled attempt. Local
controller/credential/plugin unavailable leaves the exact row and cleanup guidance, not absence. Uninstalling a native
plugin cannot erase the last resource ref.

52 governs selected retention and accepted pending-input wake. Unknown/queued/preparing work blocks unused-stop
inference; deadline behavior remains explicitly interrupting. Stop semantics are runtime facts: disk retention does not
imply RAM continuity. Wake must use the same native identity and same ordinary Session; no substitute VM after absence.
Physical controller reassignment is unsupported unless inspection proves the same actual controller
installation/resource custody; no offline child restart service.

For created local Spaces, delete confirms exact owned sandbox cleanup and relevant registry removal; ordinary connected
Machines are outside managed destroy authority. Record resource existence separately when registry removal succeeds but
native deletion fails. Cua app persistent agents, teleport/volume sync and shared relay are not used to smuggle Happier
Session/sharing/workspace authority.

## 10. Compatibility and predecessor data

Inspected `../0.2` HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`; scoped status/diff for
`apps/cli/src/api/{client/encryptionKey.ts,api.ts}`, `apps/cli/src/auth`, `packages/plugin-sdk`,
`packages/protocol/src/machines` was clean at authoring. Actual predecessor `resolveMachineEncryptionContext` reads both
dataKey and legacy secret credentials. New local Machines register through 40's owner so those owner-only
Machines/Sessions remain readable; do not copy an Account key into a shared resource or reinterpret token-only as
restricted Machine credentials.

No inspected predecessor native managed-provider writer establishes an old Lume/Cua row format. Treat the new 0.3-only
family/schemas in place; do not preserve r6 draft adapters or invent reverse-reader shims. At implementation/public SDK
publication, 50 rechecks current sibling bytes and immutable supported release provenance, and tests real
predecessor-created Machine/key vectors at 40's ingress. This file does not certify all released SDK directions. Native
existing VMs/Spaces enroll through ordinary Add → Connect without a managed ownership mode. Provider schema changes
after publication follow `docs/compatibility.md`'s SDK evolution owner.

## 11. Ordered implementation slices and deciding checks

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**Native-fact RED:** strengthen the native adapter suite below to discriminate its actual billing/capability/expiry facts. Category invariance and precedence are tested once at 52s1; receipt/control wiring is tested at 51s2.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

Every slice reads this full approved plan and its consumed contracts, then uses current source. Sources/generators stay
local; searches/tests/typechecks/builds use `./apps/stack/bin/hstack-exec -- …` or routed public scripts, never
`*:local` directly. Commands below are intended validation, **not run during plan writing**. Names for new package
scripts are established from nearest plugin conventions, not a second runner.

Observed script precedent: `packages/plugins/claude/package.json` has public `test`, `typecheck` and `build`, with
public dispatch and the canonical compiler owner. Proposed focused commands are `./apps/stack/bin/hstack-exec -- yarn
workspace @happier-dev/plugins-machine-lume test src/machine/provider.test.ts` and the equivalent
`@happier-dev/plugins-machine-cua` command. Use those workspace names with public `typecheck`/`build` at the integrated
boundary; changed host closure uses `yarn workspace @happier-dev/cli typecheck`/`build`, UI `@happier-dev/app`, Protocol
`@happier-dev/protocol` and SDK `@happier-dev/plugin-sdk`, through the same executor. Add standard plugin
`tsconfig.json` and `vitest.config.ts` only as needed by that existing package convention; a passing root test that
excluded the new leaf is not evidence.

Documentation co-lands with native behavior: extend the existing Machines section at
`apps/docs/content/docs/apps/control-panel.mdx:64` with these qualified local options/prerequisites and exact
created-resource cleanup versus ordinary Connect; update `apps/docs/content/docs/apps/remote-hosts.mdx` only if the
consumed SSH setup contract changes. Coordinate the shared Machines hunk with 51 and 54–56, not a new per-provider docs
tree. 50 owns common family/SDK guidance in `docs/plugin-platform.md` and its published architecture projection; leaves
supply their concrete examples there without redefining the seam. Label current 0.3 development/preview availability
honestly and do not repair unrelated old Relay copy. Read `apps/docs/AGENTS.md` and the docs skill before implementation
edits; docs checks accompany the coherent package batch.

### 53s1 — Lume after Lima/public-family readiness

- Consumes 50s1 actual family/Lima, 50s2 private enrollment and 51s1 facts; provides LP-R1–R4 Lume create → exact-resource install → ordinary Machine, options
  and truthful power/cleanup.
- Touch `machine-lume` package files above, first-party membership inputs, shared 51 option renderer only for missing public slots co-owned with 70; no generic
  host Lume branch. Role schemas consume 50's outputs. Any carrier correction belongs at 50's owner and co-lands with this leaf.
- **RED:** NEW `packages/plugins/machine-lume/src/machine/provider.test.ts`, through real declared leaf and 50 acquisition/bootstrap owner: simulate native
  create acceptance followed by dropped HTTP response, recover the exact storage/name, retry install, and assert one acquired resource and current normal
  registration; a native HTTP 400 and disconnected controller must not settle confirmed-absent. Mock HTTP/SSH/OS only, not row policy, registry, schema or
  enrollment logic. Focused 50 owner test may hold the composed uncertainty assertion instead of duplicating it.
- GREEN implements minimal native mapping and carrier; extend existing credential-file and registration tests if that seam changes. A canceled attempt's late
  native result must be cleanup-only, never a composer continuation.
- Run leaf focused tests using its public workspace test script; then `yarn workspace @happier-dev/plugins-machine-lume typecheck` and `build`, CLI public
  `typecheck` /`build` for projection/dependency closure, and Protocol/SDK/UI public typecheck/build only if their source changes. All through the executor for
  routed categories. Strengthen existing public author fixture/catalog checks once per integrated family batch.
- Complete only when all four 51 hosts consume real facts, no direct native create/power remains, pending rows reopen, same-resource retry works, and the
  runnable §12 segment passes. License/platform-only hardware validation is a named release check, not a made-up per-feature certification gate.

### 53s2 — Cua local sandbox

- Consumes 53s1-established seam and 50s2–s3; provides separately declared `local-sandbox`, pinned Cua adapter/license/platform facts and LP-R1–R4 ordinary
  enrollment without cloud fallback.
- Touch `machine-cua` package/front door, `nativeClient.ts`, `localSandbox.ts`, strict local schemas, translations and membership inputs. Public adapter
  transport is bounded by actual native contracts; do not bundle unqualified restricted binaries.
- **RED:** same package's NEW `src/machine/provider.test.ts` : selecting local namespace/runtime followed by create/install failure must remain recoverable
  under that exact native id; a valid cloud/Fleet response in a local request is refused instead of accepted or silently retried elsewhere. Assert native stop
  unsupported for the chosen runtime is returned as unsupported, not rm/recreate. Mock native executable/process/HTTP/SSH only; real schemas, role dispatch and
  managed owner stay live.
- GREEN maps local identity/lifecycle and private postboot carrier; run focused RED→GREEN plus public `@happier-dev/plugins-machine-cua` typecheck/build and
  changed CLI/Protocol/SDK/UI lanes once at coherent batch. Finish includes contributed options in every host and documented licensing/capture prerequisites; no
  Cua Session/agent/volume-sync consumer introduced.

### 53s3 — Cua Spaces local creation and exact cleanup

- Consumes 53s2 native boundary, 50 created-resource/bootstrap carrier semantics, 51s2–s3 and 52s3 cleanup; provides created local Space and exact
  sandbox/registry cleanup. Existing Spaces remain ordinary Connect.
- Touch `machine-cua/src/machine/{localSpace.ts,schemas.ts,provider.test.ts}`, shared native client only where truly common, manifest/activation/translations.
  No import specialization, adoption store or provider Connect Action is introduced.
- **RED:** real native adapter with native registry/HTTP/process boundaries: deleting the created Space maps exact sandbox cleanup and registry disposition;
  registry-success/native-delete-failure returns incomplete cleanup rather than absence, and a neighboring unowned sandbox stays untouched. Generic
  row/currentness decisions remain 50/52 tests, not leaf copies. Strengthen existing 51/70 UI test to assert selected image/runtime value and receipt survive
  phone summary/back, not raw styles.
- GREEN implements exact created-resource operations. Run Cua public tests/typecheck/build and risk-selected adjacent 50/52/51 tests; changed UI public
  typecheck/build once at integration. Completion requires no ordinary connected resource presented as managed delete, no token in row/receipt/log fixture and
  live detail recovery.

Ready native work may overlap after its actual 50 producer and shared Cua carrier exist; roadmap order s1 → s2 → s3 is scheduling, not acceptance gating;
shared Cua `nativeClient.ts` edits coordinate actual hunks with 56. All slices must migrate/remove competing introduced
consumers atomically; registration alone is not completion.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 53s1 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `bb91a546bb`, `b21f46377a` | [C53](../../reviews/2026-10-02-lane12-replan/impl-C/C53.md) records Lume exact native operations/private carrier GREEN; [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md) repairs image/create recovery. [CD1/CD2](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) qualify storage/name identity and buffered bootstrap IO. | Common gate; current bundled Lume declaration, shared four-host options/receipt, ordinary enrollment→same-resource Retry→inspect/power/cleanup through 50/52. | Actual Lume/macOS/Apple Silicon images, storage/stop/license and native capture; physical devices and signing. |
| 53s2 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `ce9b346ec3`, `633acda94d`, `51b7cbf32d`, `b21f46377a` | [C53](../../reviews/2026-10-02-lane12-replan/impl-C/C53.md), [FX3A](../../reviews/2026-10-02-lane12-replan/impl-C/FX3A.md), [FX5](../../reviews/2026-10-02-lane12-replan/impl-C/FX5.md) and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) record local sandbox identity, abort/recovery/cleanup and fresh selection hints GREEN; [CD2](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) keeps private native IO at the host bootstrap seam. | Common gate; regenerate stale Cua options declarations identified by RVF-3; composed local create→private install→ordinary Join/retry and shared configurator/receipt. | Installed Cua runtime/OS/image/license and real local lifecycle/capture; physical devices and signing. |
| 53s3 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `633acda94d`, `51b7cbf32d`, `b21f46377a` | [C53](../../reviews/2026-10-02-lane12-replan/impl-C/C53.md), [FX3A](../../reviews/2026-10-02-lane12-replan/impl-C/FX3A.md) and [FX5](../../reviews/2026-10-02-lane12-replan/impl-C/FX5.md) record created-Space sandbox versus registry cleanup and exact recovery GREEN; FX13 supplies fresh input publication fixes under [CD2](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md). | Common gate; generated Cua projection and created Space→enroll→same-id recovery→partial cleanup journey; ordinary connected Spaces retain their separate Connect ingress. | Actual Spaces/native sandbox deletion versus unregister and licensing/platforms; physical clients and signing. |

## 12. Live QA segment and release prerequisites

Consume 50 §12’s acquisition journey plus 51/52’s owned segments and the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule.

Run Lume image/storage selection, then Cua local namespace/runtime and created Space cleanup through the shared
creation journey. Preserve exact storage/name/sandbox identity through failed install/Retry and cancel/late join. Space
registry removal without sandbox deletion stays incomplete; a neighboring ordinary connected resource is untouched.
Native macOS/display availability consumes 64. Shared 51/70 UI proof covers phone summary/Back, keyboard and focus;
leaf tests add only the distinct native selection/outcome cases.

Real native spend/destruction needs an authorized target. Name an unavailable runtime prerequisite; never claim a
boundary fixture proves real vendor success. External hardware/tenant evidence consumes the index’s sole
[Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; no per-leaf release gate or representation.

## 13. Economy and explicit non-goals

No provider registry, provider-specific Machine table, cloud fallback, cleanup escrow, controller failover, new
queue/wake service, universal guest count, local-Team prohibition, hourly-to-month estimate, image downloader
duplicating native image authority, private VNC/browser viewer, Cua persistent-agent/teleport/volume-sync integration,
native Session runtime, hidden guest Account credential or release packaging gate. Generic family/enrollment and final
environment are consumed from 50/24; until-delete policy is 52's, not a leaf timer. Three strict leaves are justified by
D5/D12, not a universal virtualization framework.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

- **Empirical, 53s1:** exact Lume image/host limits, license, native stop/disk semantics and private SSH carrier; reject any unsupported selected image before
  effect with sourced reason, not a guessed cap.
- **Empirical, 53s2:** pin actual Cua SDK/native daemon version, enumerate supported runtime/OS combinations and license components, prove private credential
  carrier/log behavior. 64 owns macOS control; Windows/Linux/macOS executable and path seams remain first-class where the native runtime actually supports them.
- **Empirical, 53s3 / 50:** created registration identity and exact sandbox deletion evidence; no speculative cross-engine collision search. If the normal
  enrollment carrier cannot serve a qualified route, report the affected requirement and smallest amendment; do not drop the leaf or ship fake ordinary-Machine
  support.

History: see archive-r8.4 and the review folder
