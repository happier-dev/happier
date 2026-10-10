# Lane 12.54 — Hetzner, DigitalOcean Droplets and Fly Machine providers

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.4**  
Date: **2026-10-06**  
Plan-writing owner: **PE2**. No implementation, cloud purchase or credential access is approved by this draft.

Supersedes: [archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md)
Hetzner, DigitalOcean Droplets and Fly; keeps all D5/D12 leaves, retires duplicate generic
controller/receipt logic. 
Extends: `50-managed-resources-and-enrollment.md` s1–s3 with three cloud contributions,
`51-managed-presets-and-creation.md` s1–s3 with native option/billing facts, `52-managed-retention-and-wake.md` s1–s3
with qualified power/cleanup adapters. 
Consumes: 50s1 catalog/SDK, 50s2 durable acquire/private enrollment and 50s3 pre-enrollment recovery; 51s1–s3 single
configuration/preset/composer model; 52s1–s3 exact intent/retention/wake/reassignment/erasure;
`24-native-execution-environments.md` s1–s3 final execution boundary; `40-machine-content-key-lifecycle.md` s1–s3
registration/key adoption; `41-machine-sharing-and-project-terminals.md` s1–s3 current admission;
`42-requester-sessions-and-work-visibility.md` s1–s2 requester Session identity;
`70-shared-ui-and-plugin-presentation.md` s1 neutral choices/status and s4 receipt fidelity/export reconciliation;
`71-action-placement-and-parity-integration.md` s1–s3 Action placement/approval. 
Provides: 54s1 Hetzner first VPS, 54s2 DigitalOcean Droplets and 54s3 Fly to 50s2–s3, 51s1–s3 and 52s1–s3. Hetzner
follows Lima as the second reference; after that seam proof, remaining D12 qualification returns to 53s1–s3 → Droplet →
Fly →55/56. Adapter research may overlap, not executable leaf qualification.

Authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,5–10; `SYNTHESIS.md` D1–D42;
`lanes/deep-E.md` and `lanes/provider-candidates.md` are discovery only. NEW symbols below describe proposed leaves, not
shipped SDK exports.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE2 names the Machine-provider plan-writing lane (plans 53–56).
- FX means foreign-exchange conversion.

## 1. Outcome and user value

- **CP-R1:** a reviewed configuration creates one exact cloud resource, becomes a normal Happier Machine after current private enrollment, and is usable from
  desktop/phone/CLI/Agent/MCP/Voice without a provider-specific Session.
- **CP-R2:** purchase uncertainty, installation retry and cancellation retain one managed row and native identity. A lost create response never triggers a
  second paid allocation.
- **CP-R3:** power, RAM, disk, online state and billing are separate facts. Hetzner/DO stopped resources still bill; Fly stop/suspend has different
  storage/continuity consequences.
- **CP-R4:** one explicit controller installation owns native effects; authorized reassignment keeps the same native resource/credential, with no automatic
  failover or cleanup principal.
- **CP-R5:** the same provider choices, consequences and approval appear in all four 51 hosts; no guessed monthly conversion, Team budget or provider-specific
  UI purchase path.

Lab basis: final lab `.happier/design-lab/lane12-final/` (D27): `m-add A/Ap`, `m-config A/Ap/Ap2` cloud comparison table/image/location/receipt,
`m-detail A/Ap` read-only
creation detail, `m-pick A/Ap/Aprog`, `m-presets A/Ap`, `m-life A`, `b-wake S`. The final lab's first VPS is
Hetzner; DO and Fly inherit the shared anatomy, not a promise that all native fields/prices are identical.

### Primary vendor basis — fetched 2026-10-05

| Leaf | API/version evidence and URL | Observed semantics |
| --- | --- | --- |
| Hetzner Cloud | REST **v1** [docs](https://docs.hetzner.cloud/); current official [server client source](https://raw.githubusercontent.com/hetznercloud/hcloud-python/main/hcloud/servers/client.py), rolling `main`, HTTP 200 | Explicit create, server identity, native power/shutdown/delete and separate action observation. `user_data` is an input, not evidence of private secret custody. |
| Hetzner billing | Current [billing FAQ](https://docs.hetzner.com/cloud/billing/faq/) | Powered-off Servers remain chargeable; attached resources can have separate costs. |
| DigitalOcean | OpenAPI **2.0**, [official specification](https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml); [Droplet create operation](https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/droplets/droplets_create.yml) | `/v2/droplets` creation and returned action references are distinct from completed readiness. Bind exact Droplet id and observe actions/resource. |
| DigitalOcean billing | Current [pricing](https://docs.digitalocean.com/products/droplets/details/pricing/) | Off Droplets remain billable. Current v5 versus bundled plans differ in pricing/cap behavior; do not apply one formula across sizes. |
| Fly | Machines REST **v1**, [resource API](https://docs.fly.io/machines/api/machines-resource/); [suspend/resume](https://docs.fly.io/reference/suspend-resume/) | Stable Machine id is not the changing instance id. Suspend can restore memory but snapshots can be lost, requiring cold start. Stop resets rootfs; persistent volume and snapshot are different resources. |

The Hetzner JS reference and several spec URLs were unavailable/404; the official SDK source was the bounded fallback,
not a secondary tutorial. SDK source is contract evidence only: no Python runtime dependency is proposed. These rolling
pages/specs are dated, not immutable releases. 54s1–s3 record the actual fetched spec revision/native tool or owned SDK
package version before implementation; REST version already has an explicit basis. Native runtime/tenant qualification
was not run during authoring.

## 2. Flows, navigation, exact copy and lab reconciliation

Desktop: Settings → Machines → Add → Create → selected provider → 51 configurator. Select credential and exact
controller, native region/type/image, optional qualified storage/network inputs, Keep and wake policy. The price receipt
has source/time/unit and separate retained-resource consequences. Save preset/Use does not allocate; reviewed Create
returns managed id and progress immediately. Preset settings, composer and Machine detail mount this same configuration
model. After enrollment, navigate to the ordinary Machine/Session; detail creation fields become read-only while
Keep/power remains Action-backed.

Phone: provider/controller push rows → same choice state with size table rendered through 70's narrow comparison layout
→ sticky receipt sheet → reviewed approval → progress. Preserve draft/scroll/focus on back. A phone never holds cloud
provider authority just because it renders options. An offline controller shows pending current id, not a
duplicate-create suggestion. Cloud choices are native-discovered; expired region/type availability revalidation refuses
before effect with saved draft.

CLI/Agent/MCP/Voice: discover/list/check/options; submit the same current reviewed launch; inspect/cancel/retry same id;
set native-supported power, retention or deletion through canonical Actions. All mutations default Ask first, no
voice-specific false flag. Existing `session.spawn_new` and worker admission use the enrolled Machine. Opening a console
is validated URL navigation through the answering-client owner in 71, not a provider management effect or secretly
authenticated proxy. No app means a client-only navigation request returns unsupported; daemon provider effects can
still run through normal placement.

State strings common to 50/51/52 stay centralized. Common state keys below consume 50 §2's sole `managedMachines.*`
owner with descriptor title/noun and validated capability/observation facts. Only Fly-specific storage/continuity
diagnostics retain leaf translation keys; generic stopped-billing consequences are selected from 50/52 facts, never
separately translated per cloud. Exact proposed English:

| Key | English | State / recovery |
| --- | --- | --- |
| `managedMachines.credential.required` | 50 §2's exact credential state | Ordinary Connected Account repair |
| `managedMachines.options.loading/error/unavailable` | 50 §2's exact choice states | Draft retained; revalidate before native acquire |
| `managedMachines.controller.waiting` / `.permission.refused` | 50 §2's exact states | No credential substitution or inferred absence |
| `managedMachines.power.pending` | 50 §2's exact native-pending state | Native observation, no timer success |
| `managedMachines.billing.stopped` | 50 §2's retained-charge consequence | Hetzner/DO billing fact supplies charges; no per-provider duplicate sentence |
| `machineFly.suspend.continuity` | “Resume may cold-start. Keep important data on its volume.” | Suspend review/detail; no RAM guarantee |
| `machineFly.stop.rootfs` | “Stopping resets the root filesystem. Its volume is kept.” | Stop only after exact selected storage is known |
| `managedMachines.cleanup.unknown` / `.price.unavailable` | 50 §2's exact common states | Native console guidance; no invented price |
| `managedController.move` | 52 §2's exact controller movement copy | Same-resource review, no new allocation |

Do not copy demo “€ per month” from hourly multiplication. Use exact returned native prices/caps with provenance, and
unknown where missing; changing currency is not an FX service. Native image names/CPU/RAM/region stay native facts, not
hard-coded marketing presets. Retention consumes 52's settled D21 resolver using the descriptor's stopped-billing fact,
not provider IDs: running-only gets Stop after 1 h unused + wake; stopped-billed/unknown gets Until I delete it.
Explicit category/preset/machine overrides and 51's truthful native capability/expiry qualification remain available; no
retention choice is pending ratification.

Consume 51 §2/§8's sole MachineConfigurationReceipt/configurator metric, motion and phone rules and 70's neutral
Collection/SelectionTiles anatomy; no leaf density slots or receipt. This leaf's 390px column priorities preserve native
region/type, stopped charges and volume ownership in readable text.

## 3. Current owners and verified change map

**D21 facts:** report native locality, stopped compute billing, separate storage charges and capabilities through 50 §5; policy resolves only at 52 §5.

Source basis: HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`, shared dirty checkout preserved; exact paths below
checked, relevant broad discovery routed via `hstack-exec`. Runtime mechanics do not establish historical design intent.

| Path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `packages/protocol/src/plugins/contributions/catalog.ts:933` `PLUGIN_CONTRIBUTION_CATALOG_V2`; `families.ts:12` `definePluginContributionFamilyV2` | EXTEND | Consume 50's family and role schemas; add leaf manifest declarations, not a second catalog |
| `packages/plugin-sdk/src/definePlugin.ts:2963` `definePlugin` | EXTEND | Closed Machine-provider authoring through public SDK |
| `apps/cli/src/plugins/projection/families.ts:52` `definePluginProjectionFamilyV2` | REUSE | Generated normalized leaf projection; no generic cloud-id branches |
| `apps/cli/src/plugins/runtime/api/registrationRightsHost.ts:118` `createContributionRegistrationHost` | REUSE | Manifest-qualified action/contribution registration |
| `apps/cli/src/plugins/runtime/invocation/services/managedServiceCredentialFileOwner.ts:14` credential file owner | REUSE | Private local materialization and cleanup via SDK capability, no host import from leaf |
| `packages/cli-common/src/systemTasks/nativeRemoteSshBootstrap.ts`; `kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind` | CONSUME (50s2) | Canonical SSH task trust/install/enroll/cancel/progress and controller-held per-resource keypair; leaf returns only 50's bootstrap carrier |
| `apps/cli/src/auth/remoteTerminalEnrollment.ts:89` enrollment; `persistTerminalEnrollmentCredential.ts:15` persist | REUSE / REFINE | 50's current Home/resource/attempt proof and normal registration, not cloud guest credentials invented here |
| `packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts:177` `installVersionedPayload` | REUSE | Existing binary payload selection/integrity/promotion for guest OS/architecture |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16` `MachinesSettingsView` | EXTEND | 51 owns Create/detail navigation over these facts |
| `packages/plugin-ui/src/components/SelectionTiles.tsx:85`; `Collection.tsx:698` | EXTEND | 70's common image/radio comparison slots consumed by Hetzner/DO/Fly |
| `apps/ui/sources/components/ui/motion/motionTokens.ts:4` `motionTokens` | REUSE | Shared selection, receipt and overlay motion |

New owners: `packages/plugins/machine-hetzner/`, `machine-digitalocean/`, `machine-fly/`; each contains `package.json`,
`src/{manifest.ts,activate.ts,index.ts}`, `src/machine/{provider.ts,schemas.ts,nativeClient.ts,provider.test.ts}`,
`src/ui/translations.ts`. Exact domain placement follows the plugin source convention, not retired CLI
backend/model-provider trees. Membership inputs feed `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`;
regenerate once per coherent integrated membership batch.

Coverage inventory reused: Protocol `plugins/contributions/catalog.test.ts`, SDK `definePlugin.externalFixture.test.ts`,
CLI `auth/persistTerminalEnrollmentCredential.runtimeOrigin.test.ts`,
`plugins/runtime/invocation/services/managedServiceCredentialFileOwner.test.ts`, UI
`NewSessionMachineSelectionContent.test.tsx`, plugin UI `SelectionTiles.rnw.test.tsx` and `Collection.rnw.test.tsx`. New
native tests are explicitly NEW, not claimed existing.

## 4. Split-brain contraction and consumer migration

50 owns paid identity and enrollment, 51 owns recipe/receipt, 52 owns policy/intent, 40/41/42 own
registration/access/Session scope. Native client adapters own only vendor codecs/transport. No existing inspected
family/managed corridor provides these cloud leaves; do not mistake an Action Operation or server-created Session for
durable resource ownership.

Migrate Machines Add, composer, preset settings and detail to one 51 model. No UI-specific create, cloud-init secret
injector, restart Session wrapper, provider profile table or vendor-specific host controller remains. Existing manual
SSH/pairing is retained as an independent ordinary Machine ingress, not a second managed purchase owner. Native action
state is retained as evidence, not a rival lifecycle state machine. DO's separate Agent Harness candidate is not the
ordinary Droplet contribution and gets no hidden route in this plan.

Fly's app/volume control is restricted to the exact bound resource and explicitly owned attachments; never delete a
shared app or unrelated volume. Do not activate Fly Proxy autostart/autostop alongside 52 as a second power
decision-maker. If native settings contain autonomous power behavior, inspection reports it and acquire requires a
consistent reviewed choice at 52, not a silently competing controller.

## 5. Contracts and persistence

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 policy:** consume 52 §5 and 51’s single Keep/Ends control. Native expiry and unsupported power remain leaf facts.

**Reader/input classification:** Persisted/stored: HetznerLaunchV1, HetznerResourceV1, DropletLaunchV1,
DropletResourceV1, FlyLaunchV1 and FlyResourceV1 including owned attachment/app/volume objects in 50/51
rows/presets/recovery. Input/wire/event: those native
leaf shapes at acquisition/report ingress, bootstrapSshPublicKey carrier, options/bootstrap/lifecycle requests/outcomes
and MachineProvisionerContributionV1.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

Public usage: obtain current safe options → `machines.managed.acquire` with reviewed launch → receive managed
id/operation → inspect by id → ordinary enrollment/Session. 50's tolerant stored-row reader/canonical writer and strict
Action/contribution contracts are imported, not redeclared here. Proposed leaf Zod/portable outputs:

```ts
type HetznerLaunchV1 = Readonly<{
  serverTypeId: string; imageId: string; locationId: string;
  publicNetworking: { ipv4: boolean; ipv6: boolean };
}>;
type HetznerResourceV1 = Readonly<{
  serverId: number;
  owned: { volumeIds: readonly number[]; primaryIpIds: readonly number[] };
}>;
type DropletLaunchV1 = Readonly<{
  regionSlug: string; sizeSlug: string; imageId: number | string;
  publicNetworking: { ipv6: boolean };
}>;
type DropletResourceV1 = Readonly<{ dropletId: number; ownedVolumeIds: readonly string[] }>;
type FlyLaunchV1 = Readonly<{
  app: { name: string; ownership: 'created' | 'existing' };
  region: string; imageReference: string;
  guest: { cpuKind: string; cpus: number; memoryMb: number };
  volume: { kind: 'create'; sizeGb: number } | { kind: 'attach'; volumeId: string };
}>;
type FlyResourceV1 = Readonly<{
  app: { name: string; ownership: 'created' | 'existing' }; machineId: string;
  volume: { id: string; ownership: 'created' | 'attached' };
}>;
```

Native shapes consume the index Stored contracts rule; server ids positive native integers, typed native slugs validated against current
options, dimensions in native units/ranges. `cpuKind` uses the native validated enum, not an unrestricted execution
selector. Fly volume is explicit because stop/cold-start cannot promise rootfs persistence; a user-approved attach never
becomes owned deletion. Fly app ownership is explicit like volume ownership: native acquire records a successfully
created app as created; selecting an existing app never authorizes app deletion. Destroy includes an explicitly reviewed
created app after exact Machine/owned-volume cleanup and proof that it contains no unrelated resources; app cleanup
error stays incomplete. Only include attachment ids actually returned/proven owned; an empty owned list is not
permission to delete discovered neighbors. A plain native launch tag/recovery correlation does not provide idempotency.
Existing credential owner supplies the credential reference and native scope; no extra provider connection/account table
or unverified project id is invented.

`ManagedResourceV1.value` contains only selected nonsecret ids above; active IPs, connection keys and URLs are local
derived transport facts unless 50's privacy qualification approves an exact nonsecret field. `instance_id` is an
observed Fly version fact, never replaces stable `machineId`. Price projection is exactly 50's
`{amount,currency,unit,source,observedAt}` plus returned cap/retained-resource facts; no live cost engine. These choices
flow to 51 preset/revision and launch snapshot. No leaf Prisma schema, metadata blob, settings writer, RPC route or
event bus: effects use existing Action transport and authenticated controller observation with expected row intent
revision. Ordinary daemon-online updates do not prove native start/stop/delete completion.

Native SSH acquire input is `{launch: HetznerLaunchV1 | DropletLaunchV1, bootstrapSshPublicKey: string}` specialized per
leaf: 50 generates one resource keypair privately on the exact controller before allocation, injects only the public key
through the vendor's native key/create API, and retains its credential reference for same-resource Retry. This
host-supplied public key is not a preset recipe field; leaf schemas/roles validate it separately. Bound resource
bootstrap returns only 50's `ManagedBootstrapCarrierV1` SSH address/user/host-key evidence/credential reference. The
host invokes `remote.ssh.bootstrapMachine.v1` at
`packages/cli-common/src/systemTasks/kinds/remoteSshBootstrapMachineKind.ts#createRemoteSshBootstrapMachineTaskKind`,
retaining incumbent trust prompts, binary selection, provisioning/enrollment approvals, cancellation and progress. No
leaf SSH installer.

Bootstrap creates no Account credentials in user_data, image ENV, public endpoints, metadata, argv or logs. A nonsecret
first-stage binary/setup script may use native user_data; protected postboot SSH/native exec/file carries 50's current
enrollment payload. SSH host identity/trust and private credential materialization remain at 50's reused
`remote.ssh.bootstrapMachine.v1` task owner; vendor bearer stays on the exact controller. Fly's private transport must
be measured, not assumed to be SSH because other clouds are. If no protected Fly path can be proven, that route's
acquire-to-enroll remains unqualified pending native-carrier characterization through 50; do not call a public callback
with a reusable bearer.

### Current policy and owner decisions

- **SETTLED — 50 MR-D1 and 52 RT-D1; native leaf remains facts-only (50 privacy):** expose minimum nonsecret exact ids/controller/intent/cleanup in Home
  recovery; keep cloud credential, SSH keys, carrier and sensitive endpoints local. Proposed visible fields: Hetzner server/owned attachment ids, DO
  Droplet/owned volume ids, Fly app/Machine/volume ownership. 50 qualifies potentially sensitive app naming before exposure.
- Consume 51 §5 **MP-D1** for optional cap semantics; native capacity/TTL is not a new cap or Team budget.
- Consume 52 §5 **RT-D1/D21** for erasure and retention defaults; native expiry/cleanup evidence remains this leaf's responsibility.

## 6. Actions: same specs, all surfaces

Consume 50/51/52 §6 domain schemas and the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog) for approval and eligible dispatch. No `hetzner.create`/`fly.resume` public bypass.

Fly inspect never uses an auto-waking health URL. Unsupported Suspend refuses. Delete reviews retained IP/volume
attachments and exact app ownership; retry never repurchases compute.

Native role Actions consume 50 §6’s declaration/admission rule; read-only roles may be public and effects always
require host custody. Native CLI/SDK arbitrary commands are not user Actions. Console link, copying a public recovery id and opening an enrolled
Machine are ordinary presentation/clipboard/navigation operations at 71's existing client boundary; where that boundary
lacks an existing spec, 71 supplies its canonical Action rather than this leaf adding UI-only behavior.

## 7. Extensibility and closed host responsibilities

**Consumed provisioner contract:** 50 §7 owns public family, activation, author fixture and credential custody. This leaf needs its actual producer/carrier and native success/failure/cancel/recovery characterization; the Lima/Hetzner roadmap does not gate independent work (D42).

Register one `machineProvisioners` contribution per cloud through 50's closed SDK author grammar, manifest-declared role
references and `activate(api)`; catalog normalization and generated projection stay authoritative. HTTP native APIs are
preferred thin boundaries; if an SDK reduces complexity its exact package dependency belongs to that leaf and bundles
with the host's internal closure. Do not spawn system Node/npm/Python as product runtime. Windows, macOS and Linux
controllers share HTTP effects; SSH/path/process adapters must preserve their actual platform contracts.

Facts and localized option display project through existing plugin UI contributions and `@happier-dev/plugin-ui` exports
from 70. Permission, current approval, Home/resource identity, price-policy meaning, retention, queue, enrollment,
sharing and Session lifecycle remain closed canonical host owners. Do not add per-leaf feature gates or use capability
diagnostics as authorization. No native-client general-purpose credential bag is persisted.

## 8. UI composition and motion

```text
51 ManagedMachineConfigurator (Machines Add / composer / preset / detail)
  existing ItemGroup → credential + exact controller rows
  SelectionTiles + 70 preview slot → native image choices
  Collection + 70 radio comparison cells → size/price/CPU/RAM
  existing form choices → region + qualified networking/storage
  51 MachineConfigurationReceipt + 52 retention consequence rows
  existing footer / phone sheet → reviewed Create or Save preset
50 Managed progress/detail → 52 current power/cleanup controls
```

Consume 51 §8's shared receipt/radio/async-selection/phone/focus/reduced-motion contract in every cloud host; native
price units, stopped charges and volume ownership remain domain facts. No provider-local receipt state or mobile shell.

## 9. Native lifecycle, failure, cancellation and recovery

50 §9 owns row-before-effect, create uncertainty and same-resource recovery; 52 §9 owns current
intent/retention/wake/cleanup. This leaf supplies native observations under those contracts. Exact native lookup/list
correlation can recover a candidate only when unique and qualified; ambiguous candidates remain unknown with exact
query/native console guidance rather than selecting the first or adding a candidate-resolution Action/UI. 52 permits reviewed non-destructive archive/hide with retained recovery, uncertain cost and resource counts (D42);
native absence is still required to claim deletion. Native limits/timeouts come
from vendor/containing operation, not guessed leaf budgets.

Hetzner/DO: create acceptance → native action/resource readiness → protected install → current normal registration.
Shutdown request is not stopped proof; graceful failure leaves truthful state and an explicit separately approved force
action if the existing power contract supports it. Powered-off servers/Droplets keep billing and may retain attachments;
delete observes the exact resource plus created attachments, with partial cleanup visible.

Fly: create exact app/Machine plus owned or attached volume; native start/stop/suspend and wait report transitions.
Inspect uses direct API, not a proxy request that could auto-wake. Suspension can keep RAM but does not guarantee
continuity; ordinary Session/daemon reconnect survives cold start, persisted work stays on the volume. Update/rebuild
changing instance id is not a fresh managed Machine; no automatic snapshot/recreate branch. Created app cleanup is
included only under the ownership/empty-of-unrelated-resources proof and explicit approval above; existing app is
retained. Incomplete app cleanup remains visible, not a leaked silently forgotten per-Machine app.

Consume 50/52's cancellation, late-identity, controller-loss, accepted-input wake and retention invariants without a
leaf policy/queue. 50/52 tests own those generic decisions; cloud tests below discriminate native evidence,
attachment/app ownership and billing.

## 10. Compatibility

Authoring predecessor basis: `../0.2` HEAD `51f8ac630607ce4041cc6a774de824c330f421f3`; scoped Machine auth/key, plugin
SDK and Protocol Machine paths clean. `apps/cli/src/api/client/encryptionKey.ts` actually accepts legacy secret and
dataKey contexts. Cloud Machines enter normal registration, so 40 owns backward-readable owner-only data and fresh
resource keys; no native cloud bearer or Account key gets promoted into a shared Machine key.

No observed predecessor managed cloud-provider row contract needs preservation. New 0.3 family/launch/native schemas
replace draft intermediates in place, not dual-write or preserve unshipped MP adapters. Existing ordinary Machines,
Session targets, manual SSH/pairing, keys and pending behavior remain under their existing compatibility owners. 50/40
recheck actual current sibling changes and immutable released component provenance before implementation/publication,
using real old-created vectors; this plan's scoped inspection is not full artifact certification. Native existing
apps/volumes may be attached explicitly, but adoption never grants delete ownership implicitly. Once public schemas
ship, evolve through the single SDK/protocol doctrine.

## 11. Slices, RED → GREEN and completion

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**Native-fact RED:** strengthen the native adapter suite below to discriminate its actual billing/capability/expiry facts. Category invariance and precedence are tested once at 52s1; receipt/control wiring is tested at 51s2.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

Execute through current moving source; do not create a packaged release representation. Public workspace scripts select
the canonical compiler/runner. For routed tests/typechecks/builds use `./apps/stack/bin/hstack-exec -- <command>`; never
invoke finite/`:local` implementation tasks. Intended public package scripts below are established with each new leaf
from existing plugin conventions; no command is claimed run in this draft.

Use the observed `packages/plugins/claude/package.json` public `test`/`typecheck`/`build` convention, including
necessary package-owned `tsconfig.json`/`vitest.config.ts` so the new leaf is actually included. Focused command
pattern: `./apps/stack/bin/hstack-exec -- yarn workspace @happier-dev/plugins-machine-hetzner test
src/machine/provider.test.ts`; replace workspace with `@happier-dev/plugins-machine-digitalocean` or
`@happier-dev/plugins-machine-fly` for those slices. Use each same workspace's public `typecheck` and `build`; changed
hosts use public `@happier-dev/cli`, `@happier-dev/app`, `@happier-dev/protocol`, `@happier-dev/plugin-sdk` scripts
through the executor, once at the coherent package boundary.

Documentation co-lands: extend `apps/docs/content/docs/apps/control-panel.mdx:64`'s existing Machines section with
qualified cloud choices, stopped billing/Fly storage continuity and exact cleanup.
`apps/docs/content/docs/apps/remote-hosts.mdx` changes only if real consumed SSH setup behavior changes. Coordinate this
shared Machines hunk with 51/53/55/56; no provider-specific duplicate page tree. 50 owns family/SDK guidance in
`docs/plugin-platform.md` and its published projection; provide native examples to that same owner. Mark actual 0.3
development/preview availability, not shipped stable support. Read docs package instructions/skill before source-doc
changes and run its relevant checks; unrelated Relay terminology cleanup is excluded.

### 54s1 — Hetzner first VPS

This cloud reference consumes the actual 50 family/durable row/private carrier and an invoked acquire consumer.
UI creation additionally consumes 51’s minimum facts/receipt and 70 table. It proves the cloud path without making
Lima+Hetzner+four-host UI a universal qualification gate (D42).

**Cloud-account reference proof:** contribute manual/OAuth credential modes/native API purpose through existing
qualified Connected account descriptor/selector/refresh/repair owners, not provisioner credential API/model Providers.
Capture actual selected account/native project scope at plan 50 acquire; group resolution once. SavedSecret owns bootstrap
private key and managed row retains validated ref; private-file lease is temporary delivery. RED changes group/default
and disposes lease/restarts controller, then retries same paid VPS with same account/key/resource. Ordinary Session plus
inspect/stop/delete proves the cloud interface; independent leaves need only their actual producer/carrier.

- Consumes 50s1–s3 private carrier/durable identity and 51s1 facts; provides CP-R1–R5 native cloud create/inspect/install/power/delete and current billing.
- Touch all `machine-hetzner` files from §3, membership inputs, missing shared option slots only through 51/70. No independent server route/table.
- **RED:** NEW `packages/plugins/machine-hetzner/src/machine/provider.test.ts`, real declared native adapter: accepted POST with dropped reply maps to
  uncertain observation; qualified native lookup returns the exact server id, HTTP authorization/network errors do not decode as confirmed absence, and
  public-key injection/cloud-init/argv/log outputs contain no Happier bearer. 50 tests own row/currentness/retry/registration; no duplicate composed host test
  here. Mock HTTP/SSH/OS boundary only, not schemas, managed admission, approval or registration. Keep composed same-row assertions at 50's owner if already
  covered, add native discrimination here.
- GREEN native mapping/50 SSH carrier and host-generated public-key injection; adjacent credential-file and normal-registration tests if changed. Run leaf
  public tests, `@happier-dev/plugins-machine-hetzner` public typecheck/build; CLI public typecheck/build for new projection/bundled closure; Protocol/SDK/UI
  public typecheck/build if touched. Existing public author/catalog tests once per integrated family batch.
- Complete when all four hosts use real options, stopped-billing consequence is present in review/detail, same-resource recovery and current enrollment pass,
  direct native bypasses absent, and runnable §12 segment succeeds.

### 54s2 — DigitalOcean Droplets

- Consumes established 50 seam and 54s1 qualification pattern; provides real Droplet contribution, not Agent Harness.
- Touch `machine-digitalocean` package/client/schema/test/translations/membership inputs. Distinct native API mapping; do not generalize vendor coincidence
  into a new cloud lifecycle framework.
- **RED:** NEW `packages/plugins/machine-digitalocean/src/machine/provider.test.ts` : create response with in-progress action must not publish ready/enrolled;
  action failure retains exact Droplet cleanup. Select one current v5 and one bundled price fact and assert receipt preserves native unit/cap rather than
  synthesizing the same monthly estimate. Mock HTTP/SSH, real schemas/facts/managed owner.
- GREEN implement exact action/resource observation and private bootstrap; run focused public leaf tests/typecheck/build, risk-selected 50/52 tests and changed
  CLI/Protocol/SDK/UI public lanes once per coherent batch. Complete after actual ordinary Machine wiring, no hard-coded pricing conversion, off still-bills
  disclosure and exact-id deletion.

### 54s3 — Fly Machines

**Fly cold-rootfs continuity gate:** characterize native volume/boot support and mount persistent volume at actual guest
Happier home selected by `configuration.ts#happyHomeDir` and canonical path/config owners. Retain settings,
active-server credential/installation-Machine association, Agent native thread/state and workspace; native state paths
use supported config/symlinks, no arbitrary secret cloud-init. Install normal guest daemon cold-boot entry with existing
service/install owner. RED discards ephemeral rootfs, cold-boots same stopped Fly Machine on retained volume, asserts
same Machine/Session/native thread/workspace and actual resumed work; sentinel file alone insufficient. Missing native
support stays explicit blocked characterization, not backup service or RAM guarantee.50s2/52 consume this same-resource
continuity.

- Consumes 50 exact resource/credential carrier, 52 native intent/wake and 51 native volume/price facts; provides Machine/app/volume-scoped contribution with
  qualified suspend/stop/cold-start behavior.
- Touch `machine-fly` package/client/schema/test/translations/membership inputs; shared 51 volume choice only at the existing model owner.
- **RED:** NEW `packages/plugins/machine-fly/src/machine/provider.test.ts` : inspect suspended Machine without issuing a start/proxy health request; native
  resume with discarded snapshot/cold start maps the stable Machine id and truthful lost-RAM/storage facts. 50/52 own ordinary registration and same-Session
  reconnect tests. Destroy owned Machine with attached pre-existing volume and existing app leaves both; created app/owned-volume cleanup requires exact
  ownership and no unrelated resources, with app deletion failure returned as incomplete cleanup. Mock HTTP/private native exec/file boundary, not
  row/ownership/Session logic.
- GREEN native transitions, exact stable identity and storage qualification; run leaf public tests/typecheck/build and touched shared packages' public lanes.
  Adjacent real pending-input wake test at 52 verifies same Session/resource, no new provider queue. Completion requires no inferred RAM continuity, rootfs stop
  consequence, no app-wide destruction and real Action/ordinary enrollment wiring.

Independent adapter research and implementation can overlap once 50 producer/carrier exists. Roadmap order
s1 → s2 → s3 is scheduling, not a gate on independent native qualification; UI shared-hunk edits coordinate with 51/70. Final coherent batch covers membership generator output and
importing CLI dependency closure once. No slice closes from declaration/registration alone or defers a required
integrated check without its named later owner/prerequisite.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 54s1 | IMPLEMENTED (focused GREEN) | `bb91a546bb`, `e2fce97c6b`, `51b7cbf32d`, `b21f46377a` | [C54](../../reviews/2026-10-02-lane12-replan/impl-C/C54.md), [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md), [FX6](../../reviews/2026-10-02-lane12-replan/impl-C/FX6.md) and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) record native options/prices, credential custody, exact attachments and row-only/native-operation recovery GREEN; [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) independently checks both recovery arms. | Common gate; cloud/public-author host consumer and selected credential→SSH→ordinary enrollment→same-row retry/inspect/power/cleanup; stopped billing and current price facts remain visible. | Authorized Hetzner tenant, real transport/billing/attachments/exact cleanup; native platforms, physical devices and signing. |
| 54s2 | IMPLEMENTED (focused GREEN) | `bb91a546bb`, `e2fce97c6b`, `51b7cbf32d`, `b21f46377a` | [C54](../../reviews/2026-10-02-lane12-replan/impl-C/C54.md), [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md) and [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) record real native action/row recovery, pricing shapes and safe carrier GREEN; [RVF-3](../../reviews/2026-10-02-lane12-replan/impl-C/RVF-3.md) verifies row-only and native-operation neighbors. | Common gate; canonical membership/DTOs, ordinary Droplet enrollment and same-resource retry, exact attachment disposition and truthful stopped billing across the shared hosts. | Authorized DigitalOcean tenant, real actions/pricing/billing/SSH/exact cleanup; native platforms, physical devices and signing. |
| 54s3 | IMPLEMENTED (focused GREEN) | `bb91a546bb`, `8a9eec3d81`, `e2fce97c6b`, `b21f46377a` | [FX3B](../../reviews/2026-10-02-lane12-replan/impl-C/FX3B.md), [FX4](../../reviews/2026-10-02-lane12-replan/impl-C/FX4.md) and [FX6](../../reviews/2026-10-02-lane12-replan/impl-C/FX6.md) record Fly owned-app/volume, buffered install, boot-only recovery and current credential GREEN; [CD2/CD6](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) bind buffered IO and persistent-home foreground daemon boot. | Common gate; rebuilt Fly bundled projection and composed ordinary enrollment/Stop/wake/recovery; source fixtures do not prove real rootfs-loss cold boot with the same Machine/Session/native thread and workspace. | Authorized Fly tenant, real volume/boot/suspend/storage/billing and owned cleanup; native platforms, physical devices and signing. |

## 12. Live QA segment and release checks

Consume 50 §12’s acquisition journey plus 51/52’s owned segments and the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule.

Add cloud-native price/region/attachment observations to the shared creation journey. Hetzner/DO off-compute charges
remain visible; Fly storage charges are separate from stopped compute classification. Fly cold-rootfs boot retains the
same Machine/Session/native thread/workspace on its volume and actually resumes work. Exact delete keeps attached
pre-existing volumes/apps and reports partial owned-app cleanup. Pending-effect cloud Move/archiving consume 52’s
reviewed future-custody/list semantics, not an indefinite settlement gate.

Real native spend/destruction needs an authorized target. Name an unavailable runtime prerequisite; never claim a
boundary fixture proves real vendor success. External hardware/tenant evidence consumes the index’s sole
[Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; no per-leaf release gate or representation.

## 13. Economy and exclusions

No cloud controller service, credential escrow, automatic failover, generic cloud registry, shared provider table,
hourly×month estimate, currency conversion engine, Team budget, proxy-autowake owner, polling scheduler independent of
50, extra retry ceiling, provider queue, provider-specific Session/viewer, destroy-app convenience, native user_data
bearer or new enrollment auth authority. REST clients are thin native leaves; HTTP similarity does not justify
centralizing distinct vendor semantics. All D5/D12 outcomes remain in scope; difficult native carrier work is not
silently omitted.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

- **Empirical 54s1:** refresh official v1 spec/client revision, real exact-id absence semantics, SSH host identity/private carrier, returned prices/network
  attachments; billing FAQ is not a substitute for account price discovery.
- **Empirical 54s2:** pin actual spec revision/SDK if used, current sizes/images/region price shapes and action terminal/cleanup semantics, guest payload
  architecture/SSH path.
- **Empirical 54s3:** qualify protected exec/file/guest carrier and volume ownership, native suspend eligibility and cold start, stopped/suspended storage
  price from current API/account. Do not turn doc memory guidance into a universal Happier size cap.
- **Empirical 50/52:** exact same-resource controller reassignment and privacy across row/operation/log projections. A genuinely unavailable protected carrier
  requires the smallest affected amendment, not a secret-bearing fallback or removal of the Fly leaf.

History: see archive-r8.4 and the review folder
