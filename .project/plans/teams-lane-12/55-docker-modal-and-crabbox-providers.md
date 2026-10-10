# Lane 12.55 — Docker Sandboxes, Modal and Crabbox Machine providers

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**  
Date: **2026-10-06**  
Plan-writing owner: **PE2**. No source/native execution, vendor spend or credential access is authorized by this draft.

Supersedes: [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md)
Docker Sandboxes, Modal and Crabbox; preserve the requested leaves while replacing assumed VM
lifetime/stop guarantees with qualified native facts. 
Extends: `50-managed-resources-and-enrollment.md` s1–s3 with finite/sandbox native contributions,
`51-managed-presets-and-creation.md` s1–s3 with native availability/lifetime facts, `52-managed-retention-and-wake.md`
s1–s3 with supported native intents and expiry. 
Consumes: 50s1 family/SDK and 50s2–s3 durable acquisition/private enrollment/recovery; 51s1–s3 common
configuration/receipt/presets; 52s1–s3 exact intent/retention/wake/cleanup; `24-native-execution-environments.md` s1–s3
final environment; `25-devcontainer-child-machines.md` s1–s3 ordinary Docker child scope (not a second implementation
here); `40-machine-content-key-lifecycle.md` s1–s3 normal Machine registration;
`41-machine-sharing-and-project-terminals.md` s1–s3 current access; `42-requester-sessions-and-work-visibility.md` s1–s2
ordinary requester Sessions; `63-shared-computer-browser-pip.md` s1–s3 viewer; `64-native-macos-and-display-capture.md`
s1–s3 native capture; `70-shared-ui-and-plugin-presentation.md` s1 choices/status and s4 fidelity/export reconciliation;
`71-action-placement-and-parity-integration.md` s1–s3 Action placement/approval. 
Provides: 55s1 Docker Sandboxes, 55s2 Modal and 55s3 Crabbox to 50s2–s3, 51s1–s3 and 52s1–s3. The roadmap lists Fly → Docker Sandboxes → Modal → Crabbox → remote Cua; independent work depends on its actual
producer/carrier, not the preceding vendor (D42). Adapter research can overlap after 50s1; no leaf exposes
acquisition before its producer/lifetime is real.

Authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,5–10; `SYNTHESIS.md` D1–D42.
`lanes/deep-E.md`/`provider-candidates.md` are discovery evidence, not native certification. Proposed symbols/files are
NEW.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE2 names the Machine-provider plan-writing lane (plans 53–56).

## 1. Outcome and user value

- **SP-R1 — full breadth:** create Docker Sandboxes, Modal or supported Crabbox compute through the same reviewed Machines/preset/composer paths, install
  Happier, and use an ordinary Machine/Session.
- **SP-R2 — native lifetime truth:** a finite vendor lifetime is the single capability-derived Ends control from 51; no second indefinite Keep selection. Stop,
  release, expiry and destruction are not interchangeable; a missing same-resource resume cannot be hidden by buying a replacement.
- **SP-R3 — exact custody/recovery:** one durable managed id precedes native effect and retains possible live identity/cleanup after dropped results, process
  loss or credentials/plugin/controller removal.
- **SP-R4 — private enrollment:** no bearer in public metadata, images, environment, command arguments, output or uploaded scripts; native carrier is proven,
  not presumed secret because it uses stdin.
- **SP-R5 — no foreign workspace owner:** Crabbox native sync/hydration and sandbox agent conveniences do not duplicate canonical workspace/Session ownership.
  Unsupported native route is diagnosed before effect rather than silently copying workspace data.

Lab anatomy: final lab `.happier/design-lab/lane12-final/` (D27): `m-add A/Ap`, `m-config A/Ap/L/Lp` shared option/receipt hierarchy, `m-detail A/Ap`,
`m-pick A/Ap/Aprog`, `m-presets A/Ap`, `m-life A` uncertainty/pending boards and `b-wake S`. Docker/Modal/Crabbox lack dedicated final lab
cards but remain required D12 leaves, composed from 51/70 primitives rather than dropped or drawn with invented parity.

### Primary vendor basis — bounded fetches 2026-10-05

| Leaf | Version and primary URLs | Observed contract |
| --- | --- | --- |
| Docker Sandboxes | **sbx v0.46.0**, [release](https://github.com/docker/sbx-releases/releases/tag/v0.46.0); [usage](https://docs.docker.com/ai/sandboxes/usage/) | Create alone need not keep a running session; foreground versus detached exec and sandbox filesystem/removal differ. Actual guest daemon lifetime requires measurement. This is Docker Sandboxes, not ordinary `docker run`. |
| Modal | Sandbox API, dated rolling JS docs: [guide](https://modal.com/docs/guide/sandboxes), [JS Sandbox reference](https://modal.com/docs/sdk/js/latest/Sandbox) | Native timeout defaults/maximum are vendor constraints, not Happier idle policy. A new sandbox from snapshot is a new resource, not same-id Start. Exact installed JS package version is not established by `/latest/`. |
| Crabbox | **v0.71.0**, [release list](https://github.com/openclaw/crabbox/releases); immutable [README](https://raw.githubusercontent.com/openclaw/crabbox/v0.71.0/README.md), [run command](https://raw.githubusercontent.com/openclaw/crabbox/v0.71.0/docs/commands/run.md) | `--script-stdin` content can be uploaded/retained and enter failure bundles. Exact-id/kept/no-sync behavior is route-specific; some native backends cannot disable native sync. |

Crabbox's current fetched release is newer than prior research's 0.69/0.70; plan basis is 0.71.0. Docker release was
current as fetched; neither release fact proves Happier's guest daemon works. Modal guide documents a five-minute
default and maximum 24-hour sandbox lifetime; 55s2 pins the actual owned JS package/API and uses explicit reviewed
native duration, never an implicit five-minute product cutoff. Release/platform/license and source docs are not live
allocation evidence.

## 2. Flows, navigation, states and exact copy

Desktop: Settings → Machines → Add → Create → provider → 51 configurator with exact controller/credential, qualified
native template/image/backend and native lifetime. Ordinary Docker stays in 25, not an alternative here. 51 derives the
single lifetime control: durable routes show Keep; finite-only routes show Ends {expiry} bound to the native duration,
without a second Keep row. Offer only actual supported power capabilities. Save preset/Use selects, reviewed Create
allocates and opens managed progress; current join leads to the ordinary Machine. Detail retains creation choices and
the truthful expiry/resource/cleanup facts.

Phone/browser: select a capable remote controller, configure the same facts in push rows/comparison cards, review
lifetime/cost in the sticky sheet, approve and follow the same managed id. Back preserves draft; closing progress does
not cancel or terminate native foreground execution. Missing controller/plugin/credential remains an actionable
pending/unavailable state with exact cleanup responsibility. Do not render a disabled “Wake” as an unexplained local
failure after a finite resource expires.

CLI/Agent/MCP/Voice: discover/check/options read only; acquire and native-supported mutation Actions require the same
human approval. Receive managed id/operation, inspect and retry install on the same native resource. Existing
Session/worker/control Actions use the ordinary Machine after enrollment. Client-only display/link operations require an
answering app through 71; standalone CLI does not secretly start a UI or possess cloud credentials. There is no
provider-only agent command with broader lifecycle or native shell authority.

Use shared 50/51/52 keys for acquiring/installing/joining/cancel/error, rather than another generic status store.
Generic states below consume 50 §2's `managedMachines.*` keys and 52's native-expiry consequences. Only genuine Docker
daemon-lifetime and Crabbox route/sync/release diagnostics project from leaf `src/ui/translations.ts`; no generic
machineSandbox state family. Exact English:

| Proposed key | English | State / recovery |
| --- | --- | --- |
| `managedMachines.options.empty/loading/error` | 50 §2's exact option states | Native prerequisite; draft retained, read Retry only |
| `managedMachines.controller.waiting` / `.permission.refused` | 50 §2's exact states | Exact managed id retained; no bearer fallback |
| `machineDocker.lifetime.unavailable` | “This sandbox can't keep Happier running with the current setup.” | Unavailable until the actual daemon lifetime/carrier is qualified |
| `managedMachines.power.pending` | 50 §2's exact native-pending state | Descriptor supplies Docker title/noun |
| `managedRetention.nativeExpiry` | 52 §2's exact expiry consequence | 51's one Ends control; native/validated duration, not indefinite Keep |
| `managedMachines.resume.unsupported` | 50 §2's exact unsupported resume state | No automatic purchase |
| `machineCrabbox.sync.unsupported` | “This backend would copy your workspace automatically. Review its supported setup.” | Diagnose authoritative-workspace copying; safe private bootstrap staging is not automatically excluded |
| `machineCrabbox.release.consequence` | “Ending this instance releases its native resource.” | Exact route-specific delete/release review; not universal Stop |
| `machineCrabbox.expiry` | “This native lease can end before your Keep policy. Check its expiry below.” | Native idle/maximum/coordinator lease facts, not an indefinite `--keep` promise |
| `managedMachines.cleanup.unknown` / `.capture.unavailable` | 50 §2's exact common states | Exact native recovery; ordinary Session remains usable |

The row's `until-delete` means no earlier Happier-selected effect, not an indefinite product lifetime promise. 51 shows
finite-only Ends with native duration/expiry as the one lifetime control; durable defaults consume 52 D21 binding
category default. Price shows only native returned/source-dated amount/unit and retained-resource consequence; no demo
monthly estimate. Any unavailable route retains the provider entry with exact diagnosis, not a silent switch to plain
Docker/cloud.

Consume 51 §2/§8's sole receipt/configurator metric, motion and phone rules and 70's neutral selection anatomy; no leaf
density slots or receipt. At 390px preserve native template/backend/lifetime labels through readable prioritized
columns. Consume 52 D21 rather than copying the lab unused-stop default.

## 3. Current owners and source-verified map

**D21 facts:** report native locality, stopped compute billing, separate storage charges and capabilities through 50 §5; policy resolves only at 52 §5.

Observed source basis HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`; shared dirty work preserved, broad inventory
through `hstack-exec`. The map distinguishes an existing carrier from a proposed leaf.

| Path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `packages/protocol/src/plugins/contributions/families.ts:12` `definePluginContributionFamilyV2`; `catalog.ts:933` catalog | EXTEND | Consume 50's single strict `machineProvisioners` family and declared role references |
| `packages/plugin-sdk/src/definePlugin.ts:2963` `definePlugin` | EXTEND | Public closed author grammar; no raw `contributes` workaround |
| `packages/plugin-sdk/src/managed-services/contract.ts:220` `ManagedServiceSpec`; `:323` `ManagedServices` | REUSE / REFINE | Native process/credential lifetime through the existing supervisor/SDK owner, only extend a proven missing carrier consumed by this slice |
| `apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.ts:14` credential-file owner | REUSE | Private local materialization/cleanup; never import host internals from leaf |
| `apps/cli/src/plugins/projection/families.ts:52` projection family; `runtime/api/registrationRightsHost.ts:118` registration host | REUSE | Generated catalog + occurrence rights, not a sandbox registry |
| `packages/cli-common/src/systemTasks/nativeRemoteSshBootstrap.ts`; `kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` | CONSUME (50s2) | SSH-reachable Crabbox consumes incumbent trust/install/enroll/progress and one controller-held resource keypair; Docker/Modal retain native exec carriers |
| `apps/cli/src/auth/remoteTerminalEnrollment.ts:89`; `persistTerminalEnrollmentCredential.ts:15` | REUSE / REFINE | 50 owns current protected guest credential/registration and key adoption |
| `packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts:177` payload installer | REUSE | Binary-safe guest payload, no Node/package-manager dependency |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16` | EXTEND | 51's shared provider/preset/detail wiring only |
| `packages/plugin-ui/src/components/SelectionTiles.tsx:85`; `Collection.tsx:698` | EXTEND | 70 public choice/comparison slots consumed by these leaves |
| `apps/ui/sources/components/ui/motion/motionTokens.ts:4` | REUSE | Shared motion, reduced-motion and overlays |

New packages: `packages/plugins/machine-docker-sandboxes/`, `machine-modal/`, `machine-crabbox/`; each owns
`package.json`, `src/{manifest.ts,activate.ts,index.ts}`,
`src/machine/{provider.ts,schemas.ts,nativeClient.ts,provider.test.ts}`, `src/ui/translations.ts`. Dependencies/native
executable requirements belong to the importing leaf. First-party membership inputs feed
`apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`, regenerated once at coherent integration; no
hand-written generated arrays.

Existing relevant tests: `packages/protocol/src/plugins/contributions/catalog.test.ts`,
`packages/plugin-sdk/src/definePlugin.externalFixture.test.ts`, CLI
`plugins/runtime/invocation/services/managedServiceCredentialFileOwner.test.ts` and
`auth/persistTerminalEnrollmentCredential.runtimeOrigin.test.ts`; UI
`components/sessions/new/components/NewSessionMachineSelectionContent.test.tsx`; public
`SelectionTiles.rnw.test.tsx`/`Collection.rnw.test.tsx`. Existing native provider tests are not asserted; leaf tests
above are NEW.

## 4. Split-brains and exact removals

Canonical winners: 50 row/enrollment/catalog; 51 configurator/presets; 52 power/expiry/retention/wake; 24 final
environment; existing managed-services supervisor for a genuine native foreground hold; ordinary Session and 63/64
viewer. Existing inspected family/managed corridor has no Docker Sandboxes/Modal/Crabbox managed leaf.

Plain Docker/Devcontainer remains 25's different native child path; never add a Docker Sandboxes alias there. Docker's
agent CLI and Crabbox jobs/coordinator session or sync modes do not become Happier runtime/queue/workspace authorities.
Modal snapshot creates a new resource only under explicit acquire; no resume shim that secretly substitutes a new id.
Native resource inspect/delete is evidence underneath 50, not a second paid identity store.

All Machines Add/composer/preset/detail consumers migrate to the same facts and Action owner. Remove any direct `sbx` UI
launch, Modal constructor in UI, Crabbox one-shot auto-replace/retry, automatic authoritative-workspace sync/hydration, copied credential
ENV/script, provider-owned keepalive daemon or image-specific viewer introduced in this corridor. Existing native
external executables remain real system boundaries, not new host owners. Manual SSH/connect remains valid released
ingress; it cannot conceal missing managed acquisition/currentness.

## 5. Contracts, persistence, RPC and events

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 policy:** consume 52 §5 and 51’s single Keep/Ends control. Native expiry and unsupported power remain leaf facts.

**Reader/input classification:** Persisted/stored: DockerSandboxesLaunchV1, DockerSandboxesResourceV1, ModalLaunchV1,
ModalResourceV1, CrabboxLaunchV1 and CrabboxResourceV1 (lease/namespace/backend/native identity/expiry) in 50/51
rows/presets/recovery. Input/wire/event: those native
leaf shapes at acquisition/report ingress, bootstrap/role/options/lifecycle requests/outcomes and
MachineProvisionerContributionV1.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

The public caller sees canonical 50 managed ids/operations and 52 native-supported intents. No user-facing native
constructor is an authority. Import 50's `ManagedMachineV1`, `ManagedResourceV1`, `MachineProvisionerContributionV1`,
strict acquisition outputs and 51 recipes. Proposed leaf shapes:

```ts
type DockerSandboxesLaunchV1 = Readonly<{ templateId: string; name: string }>;
type DockerSandboxesResourceV1 = Readonly<{ sandboxId: string; sandboxName: string }>;
type ModalLaunchV1 = Readonly<{
  imageReference: string; appReference: string;
  resources: { cpu: number; memoryMb: number };
  timeoutMs: number;
}>;
type ModalResourceV1 = Readonly<{ sandboxId: string; appId: string }>;
// Implementation narrows backendId to the pinned native schema's qualified enum.
type CrabboxLaunchV1 = Readonly<{
  backendId: string; transport: 'direct' | 'coordinator';
  nativeImageId: string; nativeSizeId: string;
}>;
type CrabboxResourceV1 = Readonly<{
  backendId: string; namespace: string; leaseId: string;
  nativeInstanceId?: string; transport: 'direct' | 'coordinator';
}>;
```

Native shapes consume the index Stored contracts rule. Names/native ids validated at the native owner; no arbitrary shell or image script.
Crabbox backend is an actual validated finite native choice, not a persisted opaque options bag. A coordinator endpoint
is a local credential/connection fact; only its nonsecret qualified locator approved by 50 can be added to recovery, not
a bearer URL. Modal `timeoutMs` follows selected JS units and native maximum; valid near-boundary durations remain
accepted. Native guide defaults are disclosed, but finite-only user lifetime is selected once through 51's Ends control;
canonical row retention cannot create a second duration picker. Resource expiry is 50's provider observation/native
expiry fact, never a new provider timer table. Absence is confirmed only through native termination/lookup semantics,
not expiry expectation alone.

Docker name/id and physical installation qualify exact local resource; Modal sandbox/app, Crabbox backend/instance
qualify remote resource and its approved same-controller custody. Role schemas emit strict versioned native refs.
Preset/settings/row/metadata fields are only 50/51/52's; no leaf Prisma migration, RPC registration, SandboxSession
table or event bus. Native process terminal and authenticated controller observation travel through existing
managed-services/Action/report owners, not provider-defined host lifecycle events.

Docker lifecycle qualification is load-bearing: characterize foreground exec keeping the ordinary guest daemon alive, UI
detachment, controller process quit/restart and native removal. Use the existing managed-services supervisor for a
needed real foreground process; do not add an artificial keeper or private native daemon patch. If only an incompatible
host-held interactive session can keep compute alive, record the exact unmet SP-R1/D4 requirement and smallest amendment
rather than claiming unattended/retained Machine behavior.

Modal uses a leaf-owned in-process JS SDK or HTTP API with bundled dependency closure. Python CLI/Node/package-manager
spawns are not shipped dependencies. Native exec/file transport must privately deliver 50 enrollment. Modal
terminate/expiry is deletion, not stop-with-disk unless a pinned native contract actually proves it; snapshot is
optional explicit new acquisition, not silent wake.

Crabbox must explicitly address the canonical retained **lease id**, provider and namespace, not a friendly slug or
underlying instance id, using characterized keep and workspace-isolation semantics for that route. Default one-shot run
creates/releases and is not safe recovery. Use the native lease handle emitted before sync/command execution where
supported; inspect/status/stop use that exact handle. Native idle timeout and maximum TTL are separate expiry facts:
current run docs expose 30-minute/90-minute defaults and coordinator policy, not indefinite retention from `--keep`.
Select/disclose native policy explicitly and never translate Until I delete it into an unproven no-expiry flag.
`--script-stdin` may carry **nonsecret** binary setup only: source documents uploaded content-addressed scripts and
failure bundles, so never send credentials this way. SSH-reachable Crabbox allocation consumes 50's privately generated
per-resource keypair, receives only host-supplied public-key material in its validated native acquisition input (outside
reusable preset), and returns `ManagedBootstrapCarrierV1` address/user/host-key evidence/credential reference.
`remote.ssh.bootstrapMachine.v1` at `systemTasks/kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` owns host
trust, private binary install, approvals, enrollment/cancel/progress and same-resource Retry. Native file/exec routes
retain 50’s native carrier. Characterize native logging/uploads; no Crabbox SSH installer. No automatic copying of
the user’s authoritative workspace or competing workspace writer. A private bootstrap staging root may be copied only
when its actual roots, lifetime and private credential transport preserve 20/24/31’s preparation contract. Forced-copy
routes (including Blacksmith Testbox) are an empirical task, not a blanket exclusion; reject only demonstrated
authoritative-workspace copying or secret upload. Direct/coordinator routes remain separately characterized.

### Current policy and owner decisions

- **SETTLED — 50 MR-D1 and 52 RT-D1; native leaf remains facts-only (50 privacy):** Home-visible recovery is minimum nonsecret native
  id/controller/intent/cleanup; credentials, private endpoints and scripts stay local. Proposed refs: Docker name/id, Modal app/Sandbox id, Crabbox
  backend/instance/transport kind. Qualify any sensitive names before publication, no opaque native bags.
- Consume 51 §5 **MP-D1** for optional cap semantics; native capacity/TTL is not a new cap or Team budget.
- Consume 52 §5 **RT-D1/D21** for erasure and retention defaults; native expiry/cleanup evidence remains this leaf's responsibility.

## 6. Action specs, surfaces and approval

Consume 50/51/52 §6 domain schemas and the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog) for approval and eligible dispatch.

Checks never create an sbx/Modal resource or run Crabbox sync. Inspect runs no native script or lifetime extension;
ended resources cannot resume/retry into replacement. Delete never prunes unrelated resources; physical Docker control stays fixed.

Role Actions consume 50 §6’s declaration/admission rule: read-only roles may be public; native effects require
host-private custody on every route. Existing Machine/session/computer Actions apply after enrollment. Finite resource ended → UI may offer explicit
Create another through the same acquire Action/new managed id and normal approval; no automatic lifecycle translation or
provider-specific replacement Action.

## 7. Plugin authoring and closed responsibilities

**Consumed provisioner contract:** 50 §7 owns public family, activation, author fixture and credential custody. This leaf needs its actual producer/carrier and native success/failure/cancel/recovery characterization; the Lima/Hetzner roadmap does not gate independent work (D42).

Use 50's single `machineProvisioners` family, closed `definePlugin` authoring, generated catalog projection and
`activate(api)` occurrence rights. Native adapters may vary their codecs/transport and expose truthful strict facts.
Public `ManagedServiceSpec`, managed executables/dependencies and credential materialization capabilities are the seam;
`packages/plugin-sdk/src/managed-services/io.ts` is absent, not an import target. If a private carrier is missing, 50
extends the one public IO owner with this actual consumer; no second secret service.

First-party native dependency install/license/platform validation has one owner and binary-safe invocation on supported
OSes. Docker Sandboxes native redistribution and Crabbox/Cua-related dependencies require actual license qualification;
an executable release is not a grant to bundle it. Modal SDK belongs to its package and does not assume system Node. No
arbitrary VM template or command becomes host-authorized without final 24 execution/environment checks.

Public UI uses `@happier-dev/plugin-ui` facts/slots from 70. Row/policy/approval, guest identity, pending queue, Session
lifecycle, sharing, worker selection, workspace sync and viewer stay closed host contracts. Do not register these as
model Providers or Agent runtimes; no provider id checks in generic host, separate runtime registry, schema fallbacks or
new feature gate.

## 8. UI composition, accessibility and motion

```text
51 shared configurator on Machines / composer / preset / detail
  ItemGroup: exact controller + credential prerequisites
  SelectionTiles + 70 preview/caption: template/image
  Collection + 70 comparison/radio: native size/backend/runtime
  existing Item/form rows: capability-derived Keep OR finite Ends (one lifetime control)
  51 MachineConfigurationReceipt: price source + native expiry + supported lifecycle consequences
  existing footer / summary sheet: reviewed Create / Save preset
50 progress/detail → 52 permitted native intents / exact cleanup
63 shared viewer → 64 supported native capture, or explicit unavailable
```

Consume 51 §8's radio/async-selection/phone/focus/reduced-motion contract and sole capability-derived Keep/Ends control.
Native unknown expiry stays visible text, not a fabricated countdown; the shared receipt announces native
lifetime/consequence.

## 9. Lifecycle, cancellation and failure recovery

Consume 50 §9's row-before-effect/uncertainty/recovery and 52 §9's intent/retention/wake/cleanup invariants. This leaf
supplies native evidence: native accept/foreground exit is not enrolled/absent; each route characterizes what exit
actually means. Native resource quotas/timeout boundaries come from their owner, not a leaf timeout.

Docker: native sandbox created → exact exec/daemon carrier → normal current join. Observe when native sessions end and
whether disk/resource remains; lifecycle and billing facts stay separate. Closing UI cannot release the supervisor's
resource hold. Controller death/native daemon lifetime is a qualification question, not permission to invent restart
persistence or a keeper service. Native rm observed against exact id; forced rm requires disclosed current
work/dependency approval, never prune-all.

Modal: create → native running/exec/file → install/join, then selected vendor expiry or explicit terminate. Vendor
expiry is observable loss of the same resource, not an unused-stop. Preserve ordinary Session history and
draft/accepted-work recovery at their canonical owners. 52 may wake only if the same native resource supports it;
missing/expired Sandbox returns unavailable/absent proof, not snapshot recreation. Do not add hidden keepalive/renew
loops.

Crabbox: retained exact instance → nonsecret setup → private credential carrier → normal join. Lost coordinator reply
keeps native id/recovery; retry must not use replacement defaults. Supported retained/private-staging operations are explicit;
lease/release does not promise disk/RAM retention. Native deletion/stop may release rather than power off, so only
declared capabilities are offered. Actual GUI/capture on Linux/macOS is qualified through 64, not a custom Crabbox
desktop runtime.

Consume 50/52's cancellation, late-identity, controller-loss, admission/retention and accepted-input wake contracts
without a leaf policy/queue. Shared owner tests prove those decisions; the leaf tests below discriminate native
lifetime, expiry, transport and exact-id mappings.

## 10. Compatibility

Predecessor inspection basis: `../0.2` HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`, scoped auth/key, plugin SDK and
Protocol Machine paths clean. Actual predecessor encryption context accepts legacy secret and dataKey; 40 preserves
these owner-only ingress vectors. New sandbox guests use normal registration, not copied Account keys or
token-only-as-restricted claims. Ordinary Sessions/Machine selection, manual connection and historic transcripts remain
readable through their existing owners after native expiry.

No inspected 0.2 managed Docker-Sandboxes/Modal/Crabbox row establishes an old native schema here. Refactor new 0.3
family/adapter intermediates in place, without dual writers or unreleased compatibility modes. 50/publication owner
rechecks moving sibling relevant bytes and immutable supported released contracts; this scoped source inspection does
not certify all artifacts. Never encode an undeployed template as a lasting contract. Native executable/API version
qualification is explicit and changing published strict schemas follows the existing SDK doctrine.

## 11. Ordered consumed slices and tests

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**Native-fact RED:** strengthen the native adapter suite below to discriminate its actual billing/capability/expiry facts. Category invariance and precedence are tested once at 52s1; receipt/control wiring is tested at 51s2.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

Commands are proposed verification, not executed evidence. Native trial/spend needs exact authorized targets. Broad
analysis/tests/typechecks/builds route through `./apps/stack/bin/hstack-exec -- …`; public workspace scripts own
compiler and runner, no bare `tsc` or `*:local`. Source membership/generator edits remain local and regenerate once at
final coherent batch.

Follow observed public `test`/`typecheck`/`build` scripts in `packages/plugins/claude/package.json`, including
package-owned test/compiler configuration so the new leaf is not excluded. Focused pattern:
`./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/plugins-machine-docker-sandboxes test
src/machine/provider.test.ts`, replacing workspace with `@happier-dev/plugins-machine-modal` or
`@happier-dev/plugins-machine-crabbox` for each leaf. Run the corresponding public `typecheck`/`build`, and changed
CLI/UI/Protocol/SDK public workspace lanes (`@happier-dev/cli`, `@happier-dev/app`, `@happier-dev/protocol`,
`@happier-dev/plugin-sdk`) through the executor at the coherent boundary.

Documentation co-lands in existing `apps/docs/content/docs/apps/control-panel.mdx:64` Machines section: qualified Docker
native lifetime, Modal/vendor expiry and Crabbox exact-lease/private-carrier/workspace-isolation limits. Coordinate the shared hunk
with 51/53/54/56, do not make a duplicate provider page tree. Update `apps/docs/content/docs/apps/remote-hosts.mdx` only
for a real consumed SSH setup contract change. 50 owns `docs/plugin-platform.md`/published projection for the common
family; supply native examples without a parallel SDK explanation. Mark actual 0.3 development/preview availability;
read docs AGENTS/skill and run relevant checks when editing. Unrelated old Relay copy is not this lane's scope.

### 55s1 — Docker Sandboxes lifetime-first vertical

- Consumes 50 actual family/private carrier/same-resource owner, 51 options and 52 supported native lifecycle; provides SP-R1–R4 only with actual guest daemon
  lifetime.
- Touch `machine-docker-sandboxes` files from §3, membership inputs and consumed existing managed-services/50 carrier if a demonstrated gap needs refinement.
  No custom keeper/background registry/native private patch.
- **RED:** NEW `packages/plugins/machine-docker-sandboxes/src/machine/provider.test.ts` : real native adapter receives create with no live session and returns
  allocated-but-not-ready evidence, not native running proof. Foreground exec exit maps retained resource/cleanup identity instead of absence; probe issues no
  native acquire. 50 owns enrollment decisions, 52 owns recovery/admission, and the canonical supervisor test owns actual hold lifetime. Mock native
  process/OS/exec-file boundary only, not supervisor/row/schema/enrollment logic. Extend canonical supervisor test if its hold lifetime changes.
- GREEN minimum native mapping plus real qualified carrier/hold at existing supervisor. Focused tests first, public
  `@happier-dev/plugins-machine-docker-sandboxes` typecheck/build and CLI public typecheck/build for importing closure; changed Protocol/SDK/UI public lanes
  once integrated.
- Completion: all four 51 hosts consume truthful lifecycle facts, supported routes actually join an ordinary Machine, no duplicate Docker child path,
  foreground hold and exact deletion recover correctly, runnable §12 segment passes. If lifetime cannot satisfy required behavior, mark affected implementation
  **AMENDMENT_REQUIRED**, not green from mocked readiness.

### 55s2 — Modal finite Sandbox

- Consumes 50 exact native identity/carrier and 52 native-expiry observation; provides SP-R1–R4 finite ordinary Machine without replacement wake.
- Touch `machine-modal` package/client/schema/test/translations and membership inputs, owned dependency/package lock by normal dependency owner; no Python
  runtime launcher.
- **RED:** NEW `packages/plugins/machine-modal/src/machine/provider.test.ts` : requested explicit duration survives SDK units/maximum validation; native
  expiry/termination maps ended/unavailable rather than stopped-with-disk, and no supported Start capability is claimed; 52's generic expired-resource wake test
  proves no replacement acquire. Assert boundary-valid duration is accepted and out-of-native-contract duration returns typed refusal before purchase. Mock
  vendor HTTP/SDK transport and clock, not adapter/domain policy/expiry schema. Same-resource bootstrap uncertainty test reuses 50 composed owner coverage.
- GREEN in-process native API/SDK integration, exact termination observation and private postboot file/exec; run public leaf tests/typecheck/build and relevant
  50/52 owner tests; CLI/Protocol/SDK/UI lanes if touched.
- Completion: one finite Ends control with visible native expiry in all hosts, same resource enrollment/retry, no fake power capability or snapshot wake,
  explicit new acquire only, native sensitive outputs absent. Native vendor lifetime stays a provider constraint, not a new product idle default.

### 55s3 — Crabbox retained exact-id routes

- Consumes 50 private carrier/row and 24/31 canonical workspace/admission; provides SP-R1–R5 exact native retained resource with qualified Linux/macOS/capture
  facts.
- Touch `machine-crabbox` package/client/schema/test/translations/membership inputs. Pinned backend/transport qualification belongs in the native leaf, not
  generic host branching.
- **RED:** NEW `packages/plugins/machine-crabbox/src/machine/provider.test.ts` : retry after dropped coordinator result addresses the same retained id with
  the characterized isolated workspace/staging route and cannot run default replace/create; uploaded stdin script/failure bundle must contain no enrollment bearer. Forced copy of the authoritative workspace refuses before effect; a route confined to private nonsecret staging
  remains usable without introducing another workspace writer. Mock executable/HTTP/SSH/file boundaries, not route qualification/schema/managed admission. Assert preserved native resource rather
  than incidental helper call counts alone.
- GREEN nonsecret setup plus separate private credential file/transport, exact-id create/inspect/delete mapping and unsupported route diagnostics. Run leaf
  public tests/typecheck/build, canonical credential-file/registration/managed owner tests as affected, CLI importing closure and touched shared package public
  lanes.
- Completion: current 0.71.0 flags actually support selected routes, no automatic authoritative-workspace copies/hydration or secret uploads; characterized private staging remains usable, normal
  enrollment/recovery and exact cleanup reachable in all hosts; no coordinator Session/agent/sync split-brain.

Adapter research may run in parallel after 50s1; s1 → s2 → s3 is roadmap order, not an independent-work gate (D42). Public
family/catalog/external-author fixture checks amortize once per integrated batch. Final slice completion includes all
consumer migration and introduced bypass removal, focused RED→GREEN, package lanes and runnable live evidence;
declaration-only or still-running checks cannot close it.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 55s1 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `bb91a546bb`, `e2fce97c6b`, `b21f46377a` | [C55](../../reviews/2026-10-02-lane12-replan/impl-C/C55.md) and [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md) record Docker Sandboxes qualified routes/native facts/foreground carrier GREEN; [FX6](../../reviews/2026-10-02-lane12-replan/impl-C/FX6.md) supplies host credential/cleanup corrections. [CD2/CD12](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) preserve native transport and one finite lifetime control. | Common gate; ordinary guest enrollment and existing supervisor lifetime through UI detach/controller loss, exact retained cleanup and shared Ends receipt; plain Devcontainer remains its distinct owner. | Actual Docker Sandboxes executable/virtualization/foreground lifetime/network/license on supported platforms; physical devices and signing. |
| 55s2 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `bb91a546bb`, `e2fce97c6b`, `7ef13082ec`, `53b3fb93f9` | [C55](../../reviews/2026-10-02-lane12-replan/impl-C/C55.md) and [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md) record owned in-process Modal native IO/duration binding GREEN; [FX7](../../reviews/2026-10-02-lane12-replan/impl-C/FX7.md)/[FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md) and [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) cover one native Ends control under [CD12](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md). | Common gate including the Modal worker/dependency build from RVD; source-driven ordinary enroll/retry and expiry/no-replacement recovery with the same shared duration/receipt owner. | Authorized Modal tenant, actual SDK exec/file/duration/expiry/billing/termination; native platforms, physical devices and signing. |
| 55s3 | IMPLEMENTED (focused GREEN) | `c8fb44dd2d`, `bb91a546bb`, `e2fce97c6b`, `51b7cbf32d`, `b21f46377a` | [C55](../../reviews/2026-10-02-lane12-replan/impl-C/C55.md), [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md) and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) record exact lease, private nonsecret staging and coordinator-only check GREEN. [CD8](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) accepts existing temporary-key orphan unknown/recovery; no new custody mechanism. | Common gate; regenerate stale Crabbox check declaration identified by RVF-3, then captured coordinator/direct credential→exact lease→private bootstrap→ordinary Join/retry/cleanup without authoritative workspace copying. | Actual Crabbox executable/backends/direct/coordinator keep/expiry/upload/billing/exact cleanup; native platforms, physical devices and signing. |

## 12. Live QA segment and release prerequisites

Consume 50 §12’s acquisition journey plus 51/52’s owned segments and the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule.

Add Docker actual foreground/detach/controller-quit lifetime, Modal duration/expiry/unsupported same-resource wake,
and Crabbox exact lease/private-staging/native-upload observations to the shared creation journey. Closing the UI
does not release Docker’s real supervisor hold. Crabbox confines any native staging copy to characterized nonsecret
bootstrap roots and never uploads the enrollment bearer or authoritative workspace. Each ended route needs explicit
new acquisition, not automatic replacement.

Real native spend/destruction needs an authorized target. Name an unavailable runtime prerequisite; never claim a
boundary fixture proves real vendor success. External hardware/tenant evidence consumes the index’s sole
[Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; no per-leaf release gate or representation.

## 13. Economy and deliberate exclusions

No generic sandbox lifecycle service, private Docker keeper, foreground replacement daemon, independent durable restart
state, Modal snapshot auto-resume, TTL extension loop, provider queue, second secret vault, automatic authoritative-workspace
sync/hydration, Crabbox jobs/pools/coordinator Session owner, custom viewer, system Node/Python launcher, global sandbox
prune, guessed retry budget or release representation. Whole D12 provider breadth stays required; exclusions remove
disproportionate machinery, not the feature. Native expiry facts and strict native identities are justified by actual
vendor contracts, not abstract hardening.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

- **Empirical 55s1:** Docker 0.46.0 actual controller OS/virtualization/network prerequisites, daemon foreground/detach/controller-quit lifetime, exact
  removal/retained disk and license/component redistribution. Honor actual native networking prerequisites and the user’s chosen policy, including broad access; no Happier Home-only egress cage.
- **Empirical 55s2:** pin actual JS SDK version, timeout units/max and exact Sandbox lookup/termination, private exec/file carrier and image architecture.
  Snapshot/new Sandbox remains a separate explicit acquire, not an available resume capability.
- **Empirical 55s3:** pinned 0.71.0 backend flag/keep/no-sync semantics, cleanup/release/prices and private postboot carrier; script-stdin is already falsified
  as a private secret carrier. Verify supported Linux/macOS routes and 64 capture; an archive name alone does not establish a Windows backend.
- **Empirical 50/52:** native absence evidence and same-resource controller reassignment where remote. If native lifetime/carrier contradicts required ordinary
  Machine behavior, present the smallest amendment with exact evidence; do not add secret fallback, hidden purchase or cut the provider.

History: see archive-r8.4 and the review folder
