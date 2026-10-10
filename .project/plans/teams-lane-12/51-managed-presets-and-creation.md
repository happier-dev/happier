# Lane 12.51 — Machine presets and the shared creation configurator

Status: **APPROVED 2026-10-08 — implemented, awaiting integration gate (see §11 status)**  
Contract revision: **r9.8** (D53, 2026-10-09)  
Date: **2026-10-06**  
Plan-writing owner: **PE1**. Implementation approval: none.

Supersedes: [archived Machine plan](../../reviews/2026-10-02-lane12-replan/archive-r6/05-managed-machines.md) F25/F30 preset/creation UI portions;
[archived provider plan](../../reviews/2026-10-02-lane12-replan/archive-r6/06-machine-provider-integrations.md) the options/configuration
presentation portions. No `ManagedMachineProfile`/`managedMachine.profile.*` alias is implemented for unpublished draft
names. 
Extends: `50-managed-resources-and-enrollment.md` 50s2/50s3 with reusable launch recipes and configuration consumers;
`70-shared-ui-and-plugin-presentation.md` s1 has this plan's real single-choice table consumer, not a separate family
spine. 
Consumes: `50-managed-resources-and-enrollment.md` 50s1 options/check/family, 50s2 row-before-effect/acquire, 50s3
pre-enrollment collection; `52-managed-retention-and-wake.md` 52s1 retention and 52s2 wake semantics;
`23-ordinary-agent-authoring.md` s1/s2 ordinary composer seed/start; `41-machine-sharing-and-project-terminals.md` s1/s2
membership/admission; `42-requester-sessions-and-work-visibility.md` s1/s2 shared requester Session custody;
`70-shared-ui-and-plugin-presentation.md` s1/s4 neutral table/status and anatomy;
`71-action-placement-and-parity-integration.md` s1–s3 approval, placement and answering-client parity. 
Consumes: INT `.project/plans/2026-09-29-unified-agent-work/PLAN.md` §3 I3 status/glossary and FIN finalization
`03-account-actions-library-and-live-state.md` §5.3 inline triggers; recipe selection never allocates or grants trigger authority.
Provides: 51s1 recipe/options/fact contracts to `53-local-lume-and-cua-providers.md` s1–s3,
`54-hetzner-digitalocean-and-fly-providers.md` s1–s3, `55-docker-modal-and-crabbox-providers.md` s1–s3 and
`56-cua-byoc-and-fleet-providers.md` s1/s2; 51s2 configurator/receipt to 50s3 and 52s3; 51s3 dedicated new-compute
selection to `60-bots-session-identity-and-pins.md` s2 without making compute mandatory.

Authority: `.project/reviews/2026-10-02-lane12-replan/ARCH-SYNTHESIS.md` §§1.5,2,3E,5–9 and `SYNTHESIS.md` D1–D42. Final
labs win over older alternative layouts and prototype policy guesses. NEW paths/types below are proposals, not claims of
existing exports.

Reading terms:

- Numbered plan references and slice ids follow the program index. D-number references identify binding product decisions.
- F-number references identify stable user-feature ids in the program index.
- Final-lab frame ids name exact design variants in `lane12-final`; requirement and invariant ids remain stable.
- PE1 names the managed-resource core plan-writing lane (plans 50–52).
- EC is the Account settings entity-catalog plan at `../2026-10-06-account-settings-entity-catalogs/PLAN.md`; S-number references name its slices.
- FX means foreign-exchange conversion.
- DTO means data transfer object; CAS means compare-and-set.

## 1. Outcome and user value

- **MP-R1:** save a personal or Team-accessible future recipe, review exactly who can use/manage it, archive/restore it without changing any machine it created.
- **MP-R2:** configure one-off creation, preset editing, enrolled detail and phone through one validated choice/fact model. Cloud size is a comparison table,
  images are preview cards, location is a grid; local resources show measured host headroom rather than invented prices.
- **MP-R3:** receipt remains visible at the decision point and states real billing, retention, controller and approval consequences. Missing price is unknown,
  not zero; stopped storage/native expiry remain explicit.
- **MP-R4:** selecting Use, opening a configurator, saving a preset and returning from it never allocates. Explicit reviewed Create/Send reaches 50's one
  durable acquire owner and then the normal Session owner.
- **MP-R5:** Machine settings, composer and public plugin consumers use the same shared primitives and canonical Action contract, preserving drafts/focus under
  asynchronous options and navigation.

Lab references: final lab `.happier/design-lab/lane12-final/` (D27): `m-presets A/Ap/M/Mp` (Machines preset/detail and local preset); `m-add A/Ap`;
`m-config A/Ap/Ap2` size table/image/location/receipt; `m-config L/Lp`
local resources; `m-detail A/Ap/B/B2/Bp` immutable creation receipt/current work and archive rule; `m-pick A/Ap/Aprog` composer;
`m-life A` billing/recovery states; `m-defaults A/Ap` category defaults. Keep defaults are settled by D21 at 52 §5
and derive from stopped-billing descriptor facts; no per-provider preset default. Local-Team eligibility follows current
membership policy and native licensing evidence; fixed local placement alone is no prohibition.

## 2. User-facing flows, surfaces and exact copy

Desktop Machines: extend the incumbent rail with a searchable/collapsible Presets section after machines/pools. A row
opens `/settings/machines/presets/[presetId]` (**NEW**, Home-qualified through the existing route query/address owner).
New preset opens `/settings/machines/presets/new`; collection creation menu links here and to the existing Add route.
Preset detail: header/name/owner → read-only recipe receipt and Edit choices → Keep it → Who can use/manage → optional
simultaneous limit → Managed from → linked created resources/history → Use/Create one/Archive. Edits apply only to later
allocations. Team summary, if present, links here; it does not own another editor.

Creation: Add → existing Connect | Create entry → 50 provider check → one configurator → review receipt → Create (normal
approval). A credential or prerequisite repair uses its existing Action, then refreshes current options. Do not silently
install/connect on opening the page. Provider choices follow D5/D12 order from the catalog; unavailable contributions
remain explanatory when repair is possible, not fabricated ready choices.

Phone/native/web: same fields/facts, pushed provider and choice pages, sticky bottom summary/action, tap summary opens
receipt sheet (`m-config Ap2`). Size comparison retains column labels/units and radio semantics at narrow width; use
horizontal table scrolling or a shared equivalent stacked representation, not a second price/selection algorithm.
Receipt sheet/keyboard/safe area do not cover selected option or action. Back restores draft/scroll/caret and chosen
rows; opening/closing a sheet never creates or cancels resources.

Composer: incumbent Run on picker shows existing Machine/pool destinations, then **New machine** with accessible presets
and One-off. Use commits a draft target and returns; Create one may open configuration but explicit admission remains
separate. Show controller and selected Keep in the existing selected-target accessory; price stays in the
selected-option table/shared receipt under MP-D3. After reviewed Send/Create, 50 supplies managed id and actual
create/install/join progress. Original message/options/Home/current start intent remain in ordinary composer custody
until valid normal start. Changed target/Home/archived preset revision produces a typed conflict or returns to review;
never buy a replacement behind the user's back. Retry install uses the same bound id; cancellation distinguishes local
draft from paid cleanup. Bot composer consumes exactly this transaction without an implicit send.

Detail: after enrollment display current work first, immutable size/image/place/name snapshot and preset revision
provenance second; receipt beside it/read-only, live Keep policy separately editable via 52. Before enrollment 50's
managed detail holds the same receipt. “Made from” links to the accessible preset or shows unavailable provenance
without disclosing another audience's recipe. Archive is independent of those rows.

CLI/Agent/MCP/Voice: list/get presets and options; create/update/archive/restore via schemas; specify preset id +
reviewed revision or one-off choices to 50 acquire. Headless get returns receipt facts, not a request to click a card.
Mounted Use/open-choice is presentation/ordinary composer target selection through 71; no answering app gives typed
unavailable, not a successful invisible draft. All mutating operations retain configured human approval.

New English keys (all locales receive the key; reuse existing common action labels):

| Key | English string | State |
| --- | --- | --- |
| `machinePresets.title` | “Machine presets” | Collection/header |
| `machinePresets.empty` | “Save the choices you use to create machines.” | Empty; New preset |
| `machinePresets.loading` | “Loading machine presets…” | Initial loading |
| `machinePresets.loadFailed` | “Machine presets couldn’t load. Try again.” | Error; retained dated list |
| `machinePresets.ownerPersonal` | “Yours” | Owner meta |
| `machinePresets.futureOnly` | “Edits apply to new machines. Existing machines keep their choices.” | Edit/detail |
| `machinePresets.use` | “Use preset” | Draft target only |
| `machinePresets.createOne` | “Create one” | Reviewed acquire, not row-body click |
| `machinePresets.saveAs` | “Save as preset” | Recipe creation; no native effect |
| `machinePresets.archived` | “This preset is archived. Its machines are unchanged.” | Archived; Restore |
| `machinePresets.conflict` | “This preset changed. Review the latest choices before saving or creating.” | Revision conflict; preserve draft |
| `machinePresets.accessLost` | “You no longer have access to this preset.” | Refused; no protected fields |
| `machinePresets.offline` | “Last saved {time}. Connect to save or create.” | Offline display only |
| `machinePresets.audience` | “Who can use it” | Audience section |
| `machinePresets.canUse` | “Can use” | Existing member/Team grants |
| `machinePresets.canManage` | “Can manage” | Manage includes editing/archiving, not guest key disclosure |
| `machinePresets.limitNone` | “No simultaneous limit” | Default, no Team budget |
| `machinePresets.limitHelp` | “A stopped resource can still be billed. This is not a spending budget.” | Optional control consequence |
| `machinePresets.fromRevision` | “Made from {name} · revision {revision}” | Immutable provenance |
| `managedMachines.options.loading/error/unavailable` | 50 §2's exact common choices strings | Previous choice retained; revalidate before Create |
| `managedMachines.price.unavailable/checked` | 50 §2's exact common price strings | Source/currency/unit/time facts, unknown not free |
| `managedMachines.billing.stopped` | 50 §2's consequence interpolated with observed retained charges | No per-leaf stopped-billing translation |
| `managedMachines.local.footprint` | 50 §2's local consequence | Native-confirmed billing/resource facts only |
| `managedConfiguration.headroom` | “Left for {controller}” | Measured local cores/memory/disk, unknown not zero |
| `managedConfiguration.managedFrom` | “Managed from” | Exact controller; local physical restriction explained |
| `managedRetention.untilDelete` | 52 §2's canonical Keep choice | D21 category resolution at 52; finite-only providers keep one Ends control and disclose unavailable Stop/wake |
| `managedConfiguration.readOnly` | “These are the choices this machine was created with.” | Detail; not a resize affordance |
| `managedConfiguration.optionUnavailable` | “This option isn’t available on {controller}.” | Docker/Crabbox route or previously selected native option is unsupported/unavailable; keep the draft, show its actual prerequisite/repair, disable Create until an explicit supported selection is reviewed. Never silently substitute a backend/template. |
| `managedMachines.creation.approval` | 50 §2's canonical approval state | Before admission |

The meaning-specific billing labels are selected from strict provider facts, not title-string inference. Native finite
expiry copy says when the provider ends the resource; unsupported stop is unavailable, not a disabled hidden Delete
substitute. Creation failures/progress/cancel keys come from 50; retained policy/wake/cleanup keys from 52.

For finite-only no-stop-and-keep routes, consume 52 §5's **Ends after 1 h unused** policy and show native expiry
separately in that same lifetime control. Unavailable retained wake is disclosed; no implied replacement.

Metric reconciliation: `packages/plugin-ui/src/presentation/layout/pageMetrics.ts:12` owns page inset 18/sheet 16,
ordinary row 52, compact row 40 and section gap 28. Lab 56/48 rows and 30 gaps are visual reference, not global
replacement. Use public PageHeader/ItemGroup/Item measured layout and tabular numeric styles. 70s1 owns any actual
missing table anatomy with this consumer; widths depend on available pane/large text, not new machine quotas.

## 3. Current owners and change map

**D21 storage map:** preset override fields stay on 51's ManagedMachinePreset row. Configurator/create/receipt and
Machine composer read52's pure category resolver over50 descriptor facts plus the canonical Account category preference.
No preset body/list or instance/status enters settings.

Observed moving checkout HEAD `dcdc500965b063a7537ad473d5829ac5a8dacf90`, 2026-10-05. Existing launch profiles are Agent
launch settings, not managed recipes. Searches of the Machine collection, composer destination model and Protocol
Machine corridor found no existing managed-preset owner; implementation rechecks this before adding the proposed model.

| Verified path:line + symbol | Verdict | Exact change |
| --- | --- | --- |
| `apps/ui/sources/components/settings/machines/MachinesSettingsView.tsx:16` | EXTEND | Presets are part of this Machines collection/navigation |
| `apps/ui/sources/components/settings/machines/collection/MachineCollectionList.tsx:142,431` list/rail | EXTEND | Home-qualified preset section, selected route/search, create/archive affordances |
| `apps/ui/sources/components/settings/machines/collection/machineCollectionModel.ts:55,111,132` collection/landing/selection | EXTEND | Typed preset and 50 managed-reference rows; no pretend Machine ids |
| `apps/ui/sources/components/settings/machines/collection/useMachineAddOptions.ts:29` | EXTEND | Preset/one-off entry through existing options; no second provider picker |
| `apps/ui/sources/components/sessions/new/components/NewSessionMachineSelectionContent.tsx:57` | EXTEND | New-machine group, shared configuration and progress accessory |
| `apps/ui/sources/components/sessions/new/components/machineSelection/useMachineSelectionListModel.tsx:69,149,289,368` temporary selection/input/hook/commit | EXTEND | Add a separate managed draft target using same list/step owner; preserve existing artifact destination semantics |
| `apps/ui/sources/components/sessions/new/components/machineSelection/buildTemporaryComputerSelectionRows.ts:27` | REUSE | Existing published runner-artifact projection is not a managed allocation/preset lifecycle |
| `apps/ui/sources/components/sessions/new/hooks/useTemporaryComputerAvailability.ts:50,84` projection/hook | REUSE | Keep authenticated artifact availability authority, never treat artifact expiry as retention |
| `packages/plugin-ui/src/components/Collection.tsx:168,211,698` props/selection/render | REFINE (70s1) | Real single-choice comparison semantics/keyboard, safe public props, this live consumer |
| `apps/ui/sources/components/sharing/shareSheetTypes.ts` `ShareSheetAdapter`; `sharing/ShareSheet.tsx` `ShareSheet`; Protocol `teams/principal.ts` `PrincipalRefV1` | REUSE | Preset detail shows a plain owner/current-Team row with derived membership facts using `PrincipalRefV1`; expanded preset sharing is excluded by settled MP-D2; any future approved expansion reuses the incumbent adapter/sheet, with no free-form audience or competing principal union |
| `packages/plugin-ui/src/components/SelectionTiles.tsx:20,85` | REUSE | Image preview/cards and location choices; no ImageCard duplicate |
| `packages/plugin-ui/src/components/Form.tsx:158,263,304,543` TextField/Toggle/Select/Form | REUSE | Normal fields, validation and approved Action input grammar |
| `packages/plugin-ui/src/components/State.tsx:150,196,293,354` loading/empty/error/freshness | REUSE | Explicit async/error/dated facts, not spinner-as-readiness |
| `packages/plugin-ui/src/presentation/layout/pageMetrics.ts:12` | REUSE | Shared metrics and measured responsive page anatomy |
| `apps/ui/sources/components/ui/motion/motionTokens.ts:4,128` | REUSE | Existing transitions and reduced-motion timing |
| `packages/protocol/src/actions/actionSpecs.ts:822,11825` spec/normalization | EXTEND | Preset ids/strict DTOs, placements and actual supported dispatch |
| `apps/server/prisma/schema.prisma:2277` Machine | CONSUME / EXTEND | 50 managed provenance points to NEW preset record, no launch-profile overload |

Relevant existing tests under the mapped owner directories: `MachinesSettingsView.test.tsx`,
`collection/machineCollectionModel.test.ts`, `NewSessionMachineSelectionContent.test.tsx`,
`NewSessionMachineSelectionContent.virtualization.test.tsx`,
`machineSelection/{useMachineSelectionListModel,buildMachineDestinationModel,buildTemporaryComputerSelectionRows}.test.ts[x]`;
public UI `Form.rnw.test.tsx`, `SelectionTiles.rnw.test.tsx`, `Collection.rnw.test.tsx`. New domain tests below do not
masquerade as existing coverage.

## 4. Split-brains contracted here

One preset record/validator/fact projection serves Settings, composer, detail and phone. Delete duplicated
option/price/retention assembly if introduced during migration; read-only detail consumes the immutable launch snapshot,
not current preset choices. Preset is not Agent launch profile, Project manifest, Workflow or Machine pool; never copy
repository/root/Agent configuration into it.

50 owns provider options/action schemas and admitted allocation; 51 supplies strictly validated recipes and
presentation. No provider options alias, raw native button or Save-and-buy path. Existing temporary-computer
runner-artifact publication is **retained as a distinct external delivery contract**: no native provider purchase or
retained resource is inferred from selecting an artifact. New managed targets cannot reuse its package-expiry
field/runner authority. Ordinary Machine/pool selections remain normal destinations. Where shared list/step chrome is
reused, keep one model/commit owner and discriminating mixed-destination tests.

70 owns generic table/card/form anatomy. NEW app MachineConfigurationReceipt composes real public exports, not another
neutral renderer. `packages/plugin-ui/src/components/Foundation.tsx` actually exports `Metadata`; use it for fact/value
anatomy with existing Item/ItemGroup/PageHeader as appropriate. No invented export gap or second Metadata API.

70s1 extends incumbent `packages/plugin-ui/src/presentation/collection/semantics.ts` radio/radiogroup rules and
`packages/plugin-ui/src/presentation/collection/ItemGroup.tsx#HappierItemGroupRadioContext` roving-focus ownership into
table rows; 51 consumes that one owner. Its table suite must not introduce independent radio keyboard state. Existing
Temporary computers are externally published runner artifacts, grouped as **Published temporary computers**; managed
offers are **New machine · presets and one-off**. The shared destination model owns both groups with distinct
descriptions and eligibility; labels never reinterpret artifact expiry as managed retention or put the same resource in
both groups.

## 5. Contracts, settings, persistence, routes and events

Consume the index [Daemon weight](../teams-lane-12-managed-environments-and-workspaces.md#daemon-weight) rule.

**D21 inherited versus overridden recipe:** preset optional retention/wake fields denote explicit overrides; absent
means inherit52's category default/preference at reviewed creation. ManagedConfigurationFactsV1 retains concrete
resolved retention/wake for the receipt; executable selection submits only effect-bearing fields. Creation snapshots both on 50; Reset to category default clears
only the preset overrides, and live Reset uses50/52 current row mutation, never edits the preset. Native finite expiry
is separately validated at the existing one Ends control.

**Reader/input classification:** Persisted/stored: ManagedMachinePresetV1 recipe/controller/retention/cap/archive
fields, ValidatedLaunchSnapshot, retained ManagedConfigurationFactsV1/ProviderPriceFactV1/native billing/option facts
and captured creation drafts. Input/wire/event: ManagedCreationSelectionV1, PresetMutationResult, preset create/update/use/archive requests/outcomes
and native options/price report inputs.
Read/write behavior follows the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts).

Proposed tolerant stored-reader/canonical-writer schemas and strict input/outcome schemas: **NEW**
`packages/protocol/src/machines/managed/managedMachinePresetV1.ts` and `managedConfigurationV1.ts`, reusing 50's
`ValidatedLaunchSnapshot`, `RetentionV1`, qualified provider/credential/Home carriers and existing membership subjects.
Known fields retain validation; mutation/routing/identity/outcome input boundaries are closed; no JSON bag or price
parsed from labels.

```ts
type ManagedMachinePresetV1<Launch> = Readonly<{
  id: string; homeId: HomeId; revision: number; name: string;
  owner: ExistingAccountOrTeamReference;
  recipe: ValidatedLaunchSnapshot<Launch>;
  controller: { machineId: string; installationId: string };
  retention?: RetentionV1; wakeOnAcceptedMessage?: boolean; // explicit preset overrides; absent inherits52 category defaults
  simultaneousLimit?: { maximum: number };
  archivedAt?: number;
}>;
type ProviderPriceFactV1 = Readonly<{
  amount: string; currency: string; unit: string; // 50's validated native decimal fact
  source: ExistingSafeProviderSource; observedAt: number;
  components: readonly ExistingValidatedBillingComponent[];
}>;
type ManagedConfigurationFactsV1<Launch> = Readonly<{
  launch: ValidatedLaunchSnapshot<Launch>;
  optionStatus: 'current' | 'loading' | 'unavailable';
  price?: ProviderPriceFactV1;
  billing: ValidatedBillingCapabilities;
  localResources?: ValidatedObservedHostResourceFacts;
  prerequisites: readonly ValidatedPrerequisite[];
  controller: ExistingQualifiedMachineInstallation;
  retention: RetentionV1; wakeOnAcceptedMessage: boolean;
  preset?: { id: string; revision: number; name?: string };
}>;
type ManagedCreationSelectionV1<Launch> =
  | { kind: 'preset'; homeId: HomeId; id: string; revision: number }
  | { kind: 'one-off'; homeId: HomeId; launch: ValidatedLaunchSnapshot<Launch>;
      controller: ExistingQualifiedMachineInstallation; retention: RetentionV1; wakeOnAcceptedMessage: boolean };
type PresetMutationResult =
  | { kind: 'saved'; preset: ManagedMachinePresetV1<unknown> }
  | { kind: 'conflict'; currentRevision: number }
  | { kind: 'refused'; code: ExistingTypedAdmissionReason };
```

**D53 amendment (r9.8, 2026-10-09) — machine environment.** `ManagedMachinePresetV1` gains optional
`environment?: MachineEnvironmentV1`, revisioned with the preset (edits apply to new machines only):

```ts
type MachineEnvironmentV1 = Readonly<{
  toolchain?: { adapterId: string; config: string }; // a 24s1 characterized native adapter (e.g. mise/nix); global scope
  setupScript?: string;                               // system-wide, runs once; sudo only as the image allows
  secretRefs?: readonly ExistingSavedSecretReference[]; // existing saved secrets, injected into the setup process only
}>;
```

Base image stays the existing recipe field. One host operation `applyMachineEnvironment` (daemon, beside 24's launch
modules in `apps/cli/src/workspaces/environment/`) writes the toolchain config to the adapter's own global location, runs
the adapter's install with its native semantics, then the script, through 24's runner/output owner and 24s1's secret
overlay. Consumers: 50's “Set up” creation stage and `machines.environment.apply`. The Project manifest is not copied;
Project setup layers on top. No standalone Environment entity, no preset env-var store (session variables stay on
Profiles), no devcontainer features on VMs. UI: the preset/configurator gains an “Environment” section (`Form` +
existing code-field anatomy; toolchain choices from the adapter catalog); Machine detail gains “Set up from a preset…”.
Copy: `machinePresets.environment` “Environment”, `.environment.setup` “Setup script”, `.environment.toolchain`
“Tools”, `.environment.secrets` “Secrets for setup”, `machines.environment.apply` “Set up from a preset…”.

ManagedConfigurationFactsV1 is a reviewed presentation/receipt projection, never acquisition authority. Options,
prices, prerequisites and loading/current state are recomputed by their owner; strict executable selection contains only
launch/controller/retention/wake (or preset id/revision). Capture reviewed receipt facts at 50’s row, with no receipt store.
Aliases describe carriers selected at the existing owners, not permission to invent arbitrary ids or duplicate
validators. `unknown` is validated against the chosen contributed launch schema before use. Exact price representation
follows the actual numeric/currency owner; no floating-point aggregate estimator, FX conversion, fabricated
hourly/monthly equivalence or contractual freshness cutoff. A missing fact stays absent. Display the timestamp;
acquisition revalidates currently accepted native choices and approvals if the reviewed effect changes. Unknown or dated
prices are disclosed, never a separate purchase embargo; genuine unsupported native choices still refuse. Prices appear
in the selected-option comparison and shared receipt; ordinary lists/detail do not add standalone price outside that
receipt. This receipt placement is **SETTLED — 51's selected-option table/shared receipt owner (MP-D3)**.

Persistence: 51s1 adds one **ManagedMachinePreset** Prisma model with Home/Account-or-Team owner, revision/archive and
known-field-validated recipe/retention/exact-controller policy with tolerant stored reads. Read/use and management
derive from that owner and current personal/Team membership/administration; no additional audience list or member/group
grant store under settled MP-D2. A plain owner/Team row presents derived access facts using the canonical
`PrincipalRefV1` and `view/admin` vocabulary; it mounts no grant controls or read-only granting sheet. Any future
approved expansion must reuse incumbent `ShareSheetAdapter`/`ShareSheet` and 41's canonical principal/level contract; it
is not pending scope. 50's managed row stores immutable launch plus preset id/revision; no preset-history table or copy
of live allocation state. Recipe visibility does not grant provider secret reads, Machine control, spending or
human-approval waiver. Editing credential refs validates the custodian's actual credential binding; a current Machine
Manage actor uses that binding through 41/50 without requiring read/export of the secret. Team ownership alone is not a
cloud credential principal. Use checks current owner membership/archive/revision/credential visibility at 50's admission
transaction, not only the rendered picker. A preset controller is an exact qualified installation; managed control is
not one of 30's finite/service pool purposes. Missing/offline installation is a typed review/wait result, never pool
selection or automatic failover.

Concurrent edits use the existing expected-revision mutation pattern; no lease/hash manifest. Optional cap counts
admission plus possible/acquired resources in the **same 50 row transaction**, never a client list count;
uncertainty/retained stopped resources are not free capacity under settled MP-D1. Archive/hide preserves recovery rows and counts uncertain/retained resources; only confirmed absence releases capacity. No cap runs by default. MP-D1 defines the cap's single meaning instead of
a one-value `counts` discriminator. Retention/wake resolve through 52 D21; absent preset override inherits the selected
category default, not a blanket false. No global Team budget, pool warm-up or provider-wide cap is added.

**One lifetime control:** 51s2 derives available Keep choices from `MachineProvisionerContributionV1.retention`
and validated native option/expiry facts. Durable routes show canonical Keep; finite-only routes show **Ends {expiry}**
as that one control, writing the provider launch's existing native duration (e.g. Modal timeout/Fleet lease). Until
delete is not another selectable promise for a finite-only resource; the row may retain `until-delete` to mean no
earlier Happier effect without a second lifetime input. If expiry is unknown, show Ends · unavailable/unknown rather
than a fabricated timestamp. Native expiry on a durable route remains an independent fact; a supported selected host
stop/deadline is a distinct effect, not duplicate selection of the same lifetime. No new retention schema/timer is
introduced.

Its native duration and Happier unused-end rule remain distinct facts within this one control: finite-only providers
show **Ends after 1 h unused** plus their validated native expiry, not a promise of retained Stop. Inactivity never
cuts off live work; an earlier vendor expiry remains an independent disclosed ceiling.

**Purpose-qualified creation:** consume 30s2's canonical destination purposes at
`buildMachineDestinationModel.ts`; Project environment selection is not a Launch Profile or FIN Runs on selection.
FIN `WorkflowProjectTargetControl` / `TriggerRunsOnRow` retain their actual machine+folder and owner-only eligibility
through that owner. A managed recipe cannot silently broaden those purposes or turn a pool into a controller.

Server scope: **NEW** `apps/server/sources/app/machines/managed/machinePresetService.ts`, within 50's one proposed
managed domain; route registration under the existing Machine route owner and current Account/Home auth. UI
transport/cache under **NEW** `apps/ui/sources/sync/api/machines/managedMachinePresets.ts`, ordinary typed
invalidation/store conventions; no new websocket bus or authoritative UI registry. CLI execution at the existing Action
front door. Existing mutation/event envelopes carry qualified preset revisions and managed reference invalidations; no
full credential/native bag broadcasts.

Follow `apps/server/AGENTS.md` for all provider schemas/migrations/Tx/afterTx. No native effects inside a transaction.
If implementation edits an applied development migration, its last editor performs retained-db semantic reconciliation
and canonical deploy twice; this planning lane does not mutate the database.

**D20/D24 administration:** consume [41 §5](41-machine-sharing-and-project-terminals.md#5-contracts-persistence-routes-and-events).

### Current policy and owner decisions

- **MP-D1 — SETTLED — 50/51's same-transaction capacity owner:** no simultaneous limit by default and no Team-wide budget; optional explicitly labeled limit
  counts acquired/uncertain resources, including retained stopped resources. Confirmed absence releases capacity; archive/hide alone does not. 51s1 proves real row-count
  semantics; 50 consumes the same transaction, no running-only alternative or second mode.
- **MP-D2 — SETTLED — personal/Team membership owner:** presets derive use/manage from current owner membership/administration, with a plain derived owner/Team
  row and no additional grant store. Fixed local controller does not ban Team use. Recipe visibility does not grant raw provider-credential reads, Machine
  Manage or approval waiver; a current Machine Manage grant separately admits D20 owner-equivalent Machine effects through 41.
- **MP-D3 — SETTLED — 51's same-transaction optional capacity, membership and receipt owners:** selected-option table and shared receipt own price display; no
  standalone list/detail price outside its receipt. 51s2 owns all hosts and unknown-price fallback.
- Consume **MR-D1/MR-D2/MR-D3** from 50 and **RT-D1** from 52. **D21 — SETTLED:** category defaults/user preferences and per-preset/per-machine overrides
  follow plan 52; an absent preset wake override inherits category wake.

## 6. Actions and approval (D16)

**D21 parity:** `machines.presets.create/update` write/reset optional explicit retention/wake overrides through the
preset row owner; `settings.get/set` at 52 edits category defaults, and `machines.managed.retention.update` edits only
an existing resource. “Use category default” shares those semantic producers with UI/Agent/CLI/MCP/eligible Voice.

Approval and eligible surface parity consume the index [Global Action catalog](../teams-lane-12-managed-environments-and-workspaces.md#global-action-catalog). Local unsent choice/view uses the ordinary presentation/composer owner.

| Action | Input → output | Safety/default / effect |
| --- | --- | --- |
| NEW `machines.presets.list` | qualified Home, audience/search/archive, existing page cursor → accessible summaries/page | Read/Allowed; no wake |
| NEW `machines.presets.get` | qualified id → canonical recipe/revision or refused | Read/Allowed; never return secret value |
| NEW `machines.presets.create` | Account/Team owner/name/validated recipe/exact controller/Keep or finite duration/optional limit → saved preset/revision | Shared/execution-bearing mutation/Ask; Save as preset uses this, no allocate |
| NEW `machines.presets.update` | id + expected revision + closed editable patch → saved/conflict/refused | Mutation/Ask; name/config/limit all same owner; audience is derived; existing machines unchanged |
| NEW `machines.presets.archive` | id + expected revision → archived revision/conflict | Mutation/Ask; no stop/delete |
| NEW `machines.presets.restore` | id + expected revision → restored revision/conflict | Mutation/Ask; no allocate |
| NEW `machines.environment.apply` | machine id + preset id/revision → operation id + output reference / typed refusal | Executes code on the machine/Ask first; same `applyMachineEnvironment` owner as 50’s stage |
| Existing `session.spawn_new` and normal composer target selection | unchanged ordinary Session input + resulting enrolled target → normal Session/start result | Existing policy; separate compute approval, never automatic Send |

Configurator radio/image/location choice, unsaved fields, receipt expand/Back and focus are local presentation. Concrete
configurator/settings/history navigation uses existing admitted navigation; headless options/get returns the same safe
DTOs, not a transported radio/clipboard/Use callback. All saved mutations and acquisition remain Actions through
canonical owners.

Managed/provisioner and live-policy contracts consume 50 §6 / 52 §6; credential repair/removal stays at the Connected/SavedSecret owner.

## 7. Plugin extensibility

Consume the one 50s1 `machineProvisioners` descriptor/options schema and declared `activate(api)` Action references. A
leaf supplies strict launch/resource facts, native options, icon/title, platform/prerequisite and supported
billing/retention capability. The host selects authority/approval/credential/controller and validates current
contribution occurrence; unknown opaque option fields never execute.

Public UI uses `@happier-dev/plugin-ui` exports `Collection`, `SelectionTiles`, `PageHeader`, `Item`, `ItemGroup`,
`Form`, `TextField`, `Select`, `Toggle`, `State`, `Status` and `Step`, plus 70s1's precise single-choice table
refinement at its existing public owner. Image preview already exists; only safe declarative preview adaptation may
extend it. A public-author fixture renders real returned option facts, selects one size/image, calls admitted acquire
through host executeAction and handles refusal. No author imports app-private configurator/store or receives cloud
credentials.

Preset mutation/resource custody/audience/cap enforcement and composer continuation stay host-private. Do not export
one-off providers' custom React form, a second options registry, raw native bags, generic receipt engine or
permission-granting widget. Update catalog/SDK/public inference/generated UI/CLI projections through their canonical
scripts together with the real consumer; no manual generated edits or separate archive/install gate.

## 8. UI composition and motion

```text
MachinesSettingsView / ordinary Run on picker / managed detail
  MachineCollectionList + existing list/step selection owner
  NEW ManagedMachineConfigurator (one app composition)
    PageHeader
    Form + ItemGroup (name, exact controller, credential, Keep OR finite Ends)
    Collection table (70s1 single-choice size; tabular CPU/RAM/disk/price)
    SelectionTiles preview/card (image) + choices (location)
    State + FreshnessLine (prerequisite/options/price)
    NEW MachineConfigurationReceipt (ItemGroup/Item sections of same fact model)
      desktop adjacent summary / phone sticky summary → Overlay sheet
    normal approved Action footer
  NEW MachinePresetDetail (same receipt/fields, plain derived owner/Team row, linked rows)
```

No new browser/viewer is created for an image preview or “See its screen”; actual ordinary guest capture support is F64
and its existing capture owner. D12's macOS desktop expansion is not silently omitted because the lab originally said
“needs plan change”.

Map lab panel/step morph to `motionTokens.inPlaceMorph` and `resolveInPlaceMorphTiming`; phone receipt uses existing
Overlay sheet/modal tokens; local selection feedback uses press/release, not staged creation timers. Interrupt from
current visible state; reduced motion crossfades or immediately resolves through existing tokens. Never animate a
submitted native fact into success. Stable ids/selection/caret survive refresh; screen-reader radio group has one tab
stop, arrows/Home/End select supported choices, checked/disabled reasons and headers/units exposed. Restore focus to
summary trigger after receipt dismissal and selected row after Back. Refresh price/facts should not rerender every
Machine/Session subscriber; use scoped subscriptions and stable projections, measure the live table with many real
options before memoization.

## 9. Lifecycle, failures, cancellation and recovery

Unsaved draft → reviewed configuration → either saved preset or explicitly approved acquisition. Only the last
allocates. Selected contribution/credential/controller changes invalidate dependent current options but preserve
compatible field/draft values; no stale result overwrites a newer selection. Changed/removed option stays visible as
invalid and asks user to choose. Native options failure/offline preserves last-known dated display but cannot claim
reviewed current availability. No guessed expiry window or hardcoded retry count.

Preset edits/archive/restore use expected revision/current permission; conflict preserves draft and offers latest
values. Revocation removes protected detail immediately using existing lifetime cleanup. Archive removes it from New
machine offers but history still resolves its id/revision for authorized viewers; no cascade into allocations. A
submitted create is 50's row even if its preset is later archived. Current approval and admission decide whether an
unsubmitted stale selection may proceed.

Price disclosure covers source/time/unit/currency, partial stopped charge, unknown price, native TTL, local footprint,
Team custodian billed, dated observation, retained charge and unknown consequence (`m-life A`). Native capacity/license
constraints require provider proof; no invented two-guest limit or local Team ban. A local Team recipient uses the exact
controller/access path; recipe visibility alone grants neither host-secret reads nor acquire authority; current Machine
Manage separately grants D20 owner-equivalent provider spend via 41/50.

After acquire, 50 owns unknown allocation/failed install/late cancel/recovery. Returning to configuration cannot reset
paid identity; Retry install never reruns native acquire. Ordinary composer cancellation/target retirement suppresses
stale Session continuation but preserves resource recovery. 52 owns already accepted message withdrawal versus
already-delivered state. No 51 stage journal, persistent purchase queue or hidden rollback algorithm.

## 10. Compatibility and the 0.2 frontier

Inspected sibling HEAD `51f8ac630607ce4041cc6a774de824c330f421f3` on 2026-10-05; targeted status/diff for CLI auth/key,
API Machine, server Prisma, SDK/catalog had no staged/unstaged changes. This differs from deep-E's old basis; its
enrollment filenames are absent in the current sibling. The actual sibling Machine key reader
`apps/cli/src/api/client/encryptionKey.ts:35` and Prisma Machine/AccessKey shapes remain 40/42's compatibility
obligation. 51 does not fabricate an older preset shape or share keys.

Preserve readable ordinary Machine, pool, Agent launch-profile and published runner-artifact destination data; new
managed selections are distinct, capability-admitted shapes at the existing composer protocol owner. Old supported
clients/servers retain ordinary operation; do not inject an unskippable new variant into their required response union.
Resolve released SDK/API publication provenance during 51s1 via 50's check; unpublished 0.3 drafts cut in place with all
callers/generated DTOs, no `profile` alias/dual writer/reverse-dev rollback shim. New mutation inputs/outcomes are
closed; safe presentation lists may skip new row kinds only under their actual released contract. Recheck moving sibling
paths before integrated handoff.

## 11. Ordered implementation slices and completion gates

Consume the index [Integrated implementation evidence](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence) rule for owner RED/GREEN, coherent package checks and one composed corridor journey.

**51s2 deciding policy/input test:** receipt uses 52’s real resolved policy; submitted one-off input contains only
selected launch/controller/retention/wake, never price/options/loading facts. Reset/save touches only the preset row;
selection/Back allocates nothing. Category/precedence tests belong once at 52s1.

**Stored-reader proof:** consume the index [Stored contracts](../teams-lane-12-managed-environments-and-workspaces.md#stored-contracts) owner-test rule; strengthen the real changed reader/writer, without repeating the shared helper suite.

**51s1 — Preset owner and safe configuration facts (MP-R1–R3).** Consumes 50s1 schemas/options, 50s2 minimal row
admission/provenance, 41 membership and 70s1 actual table contract. Provides one recipe CRUD/fact model and future-only
immutable snapshot. Files: NEW Protocol
`packages/protocol/src/machines/managed/{managedMachinePresetV1,managedConfigurationV1}.ts`; NEW server
`apps/server/sources/app/machines/managed/machinePresetService.ts` and provider Prisma migrations; existing Action
ids/specs/DTO projections; 50 acquire service consumes preset revision/optional cap atomically; NEW UI
`apps/ui/sources/sync/api/machines/managedMachinePresets.ts`. RED: NEW server
`apps/server/sources/app/machines/managed/machinePresetService.integration.spec.ts` using real integration DB/current
access logic—archive/update a preset after one admitted allocation and assert its launch/native identity unchanged,
stale/revoked caller cannot admit another and Save allocates none. NEW Protocol
`packages/protocol/src/machines/managed/managedConfigurationV1.test.ts` validates absent price remains absent with
stopped/native expiry truth, rejects foreign schema/credential/routing fields and a pool controller in place of the
exact qualified installation before any allocation. Mock only native options/network/clock; not
audience/normalization/admission. GREEN includes current preset Actions→service→50 native boundary. Run focused suites
then public Protocol/Server typecheck/build and provider DB-contract lane; review changed migration's retained-db
reconciliation. Complete only with one store/validator and all affected consumers, no secret disclosure or fake budget.
Public shared table extraction co-lands with 51s2, never dormant.

Each UI creation vertical co-lands the minimum 51 facts/receipt and 70 table it consumes; an invoked headless acquire
can prove 50’s producer independently. Complete four-host UX and preset CRUD remain 51’s required UI boundary. The pure
52 resolver is a real dependency; full live-control/wake is needed only by a consumer that promises those effects.

**Consumed storage and credential contracts:** managed recipe/resource rows remain at their real relational owner.
Connected configuration/purpose catalogs consume EC's single small domain rows and ready typed snapshots; material
remains SavedSecret. No per-account/selection private row or secret/preferences replica. 50s2 captured actual qualified
account/native scope and persisted bootstrap SavedSecret ref survive default/group edits, lease disposal/restart/retry.
Options/configure/repair uses existing qualified purpose/manual/OAuth owner; Manage allows effect, no API credential
read. Real preset/acquire/credential-owner RED proves changed selector and removed material without
allocation/disclosure.

**51s2 — One configurator/receipt in Settings and phone (MP-R2/3/5).** Consumes 51s1, 50 check/repair and 70s1/71
admission. Provides Create one, New preset/Edit/Save-as-preset, current options/receipt and read-only detail block.
**Consumed seam:** `resolveWorkStatusTone` — INT PLAN §3 I3; receipts/status consume canonical words and never infer
native power, permission or price from a label.
51s3 offers “When this session is archived: Keep / Stop / Delete”, default Keep (D42). Only selected Stop/Delete
consumes 52s2’s FIN trigger write after real Session/resource admission. Keep creates no binding; unsupported effects
remain explicit, and failed/unknown selected binding stays visible at the existing trigger owner.
Files: existing MachinesSettingsView/collection/Add route; NEW
`apps/ui/sources/components/settings/machines/managed/{ManagedMachineConfigurator,MachineConfigurationReceipt,MachinePresetDetail}.tsx`;
NEW preset routes under `app/(app)/settings/machines/presets/`; existing public Collection/SelectionTiles/Form
composition and locale keys. RED: NEW `managed/ManagedMachineConfigurator.test.tsx` with real form/fact/Action logic and
canonical UI boundary testkit—select size/image, update options while a newer selection is active, assert receipt
reflects selected current facts; Save invokes preset mutation with **no native allocation**, approval denial preserves
draft; empty/unknown price never displays free; a durable provider presents one Keep control and a finite-only provider
presents one Ends control bound to native duration, with no second lifetime selector. Extend existing
`packages/plugin-ui/src/components/Collection.rnw.test.tsx` (or its current table owner suite after inventory) with
keyboard single radio selection preserving focus. Only router/network/platform/native boundaries mocked, no internal
fact model or Action policy mocks. GREEN mount same composition in create/preset/detail/390px; run relevant UI/Plugin-UI
suites, public typecheck/build for both, source-driven public-author inference/composition check. Complete with all four
hosts, no card/table/receipt duplicate and actual approved footer, accessible reduced-motion/back/keyboard behavior.

**Public UI acceptance:** shared single-choice table uses public Collection selection.single with virtualized List, real
headers/tree-row shape and keyboard/focus owner from 70s1; not manually mounted ItemGroup radio children. Receipt imports
actual Metadata export. RED scrolls large options, keyboard-selects with stable focus and selected receipt on
phone/desktop. Focus, radio choice, unsaved expand/Back and clipboard are local presentation; concrete
workspace/Session/settings navigation uses existing admitted operation. Headless get/options returns data, no fictitious
CLI Use/clipboard Action. Current contribution/managed custody remains50's owner.

**Option-unavailable RED (51s2):** `ManagedMachineConfigurator.test.tsx` uses real options/fact/currentness logic
for Docker and Crabbox unavailable routes and a selected native option removed by refresh. The unavailable row
stays visible with its reason/repair, draft and receipt remain attached to that selection, and Create cannot allocate
until the user explicitly reviews a supported choice. Network/platform boundaries only; no options-model mock.

**51s3 — Ordinary composer transaction and preset history (MP-R1/4/5).** Consumes 51s2 + 50s2/3 + 23 normal start + 42
shared requester + 52s2 pending recovery. Provides New machine/preset/one-off target with real progress and linked
resource history/archive/restore.
**Consumed seams:** `admitAgentStartV1` — ORC PLAN §3.4 / INT PLAN §3 agent-start row; creation continuation keeps
requester policy. `session.trigger.add` / `workflow.trigger.add` — FIN finalization 03 §5.3; bind only after actual
Session/run and created Machine admission through 52, never allocate or pre-authorize from a recipe selection.
Files: existing NewSessionMachineSelectionContent, machineSelection list/destination
models and ordinary draft/start owner; NEW managed draft adapter beside those owners; 50 progress/detail; preset
collection/history route; generated Actions. RED: extend `machineSelection/useMachineSelectionListModel.test.tsx` and
NEW adjacent `managedMachineSelection.test.tsx`—selecting/Use/back never allocates; explicit approved start allocates
once; canceled/replaced Home/target receiving late enrollment cannot start Session; install retry keeps native id;
switching between artifact/normal/managed targets preserves exact Home/expiry semantics, grouped published temporary
computers versus new-machine presets/one-off targets stay distinguishable, and composer accessory has no standalone
price outside the shared receipt. Exercise actual draft/currentness/start logic, native network/OS boundary only. Server
50 integration supplies late-event deciding evidence rather than mocked helper returns. GREEN same
UI→Action→row→enroll→normal composer journey, headless read/acquire parity and phone draft recovery. Run
focused+adjacent destination/Session-start/managed admission suites, UI/CLI/Protocol public typecheck/build once for
coherent current batch; integration source live recipe below. Complete only with all hosts wired and stale continuation
retired, no unsubmitted allocation or second start/paid owner.

**Creation continuation:** offer archive/durable-run-finished Keep / Stop / Delete, default Keep (D42). Keep writes
no binding and does not change retention. Selected supported Stop/Delete configures 52s2’s existing FIN Automation
binding after actual newly created Machine and Session/run admission. Canceled/replaced continuation cannot attach it;
existing selected Machines stay untouched. No scope field, Bot lifecycle or process-local finite id. The real trigger
mutation/creation test at 52s2 distinguishes Keep/no write from selected Stop/Delete/current admitted binding.

Parallelism: source research/options fixtures/locale and UI preparation may proceed after carrier agreement. 51s1
DB/owner and 70 table work can be independent hunks, but executable create exposure waits 50 durable admission; 51s3
waits actual 23/42 start consumer. A prerequisite missing prevents that live gate, not permission to mock an internal
owner or silently drop shared flow. Package commands use public workspace scripts through
`./apps/stack/bin/hstack-exec`, not `*:local`/finite compiler tasks.

**D20 proof:** consume 41’s canonical admission/credential non-disclosure suite. This slice adds only its discriminating managed mutation/credential-currentness cases; no repeated omnibus access matrix.

### Execution state

Execution evidence observed 2026-10-10 from [TRACKING](../../reviews/2026-10-02-lane12-replan/impl-C/TRACKING.md), the linked lane reports and review/fix deltas. Focused GREEN denotes the terminal source checks recorded there, not a new ST run or an integrated completion verdict. Open/partial rows retain deciding evidence gaps; historical failures are not erased by later narrow passes.

**Common Main integration gate (D50):** current touched-package typechecks/builds and relevant broader tests; canonical generated bundled manifests/projections plus SDK DTO regeneration/parity; retained-database migration deploy, including `20261009160000_add_machine_preset_environment`, with applicable provider/schema/FK checks; and the [composed loaded-runtime journey](../teams-lane-12-managed-environments-and-workspaces.md#integrated-implementation-evidence), current runtime identities, cold-daemon evidence and light/dark/phone accessibility/performance comparison. [QAC](../../reviews/2026-10-02-lane12-replan/impl-C/QAC.md) and [QAC2](../../reviews/2026-10-02-lane12-replan/impl-C/QAC2.md) are partial live evidence; [FX16](../../reviews/2026-10-02-lane12-replan/impl-C/FX16.md) supplies source fixes for QAC2 blockers. [QAC3](../../reviews/2026-10-02-lane12-replan/impl-C/QAC3.md) is **in progress** and closes no pending gate.

Release evidence below names the applicable checks in the index's sole [Release checks](../teams-lane-12-managed-environments-and-workspaces.md#release-checks) list; real vendor tenants/billing, native executables/platforms, physical devices and signing remain release-owner evidence.

| Unit | State | Commits | Deciding focused evidence | Main integration remaining | Named release evidence |
| --- | --- | --- | --- | --- | --- |
| 51s1 | IMPLEMENTED (focused GREEN) | `71e10f8f39`, `92c476ae05`, `ac944cbc52`, `d0b68f94e2`, `7ef13082ec` | [C51](../../reviews/2026-10-02-lane12-replan/impl-C/C51.md) records Protocol and real-DB preset CRUD/cap/future-only snapshot GREEN; [C53D](../../reviews/2026-10-02-lane12-replan/impl-C/C53D.md) adds approved [D53](../../reviews/2026-10-02-lane12-replan/SYNTHESIS.md) environment schema/Actions. [CD10/CD11](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) preserve additive migration and deadline-free reusable presets. | Common gate; current preset revision/permission/cap checks and migration deploy; loaded Save allocates nothing, edit/archive/restore leaves existing machines unchanged; D53 references remain protected. | Actual vendor-native options/billing and toolchain/setup execution; native platforms, physical devices and signing. |
| 51s2 | IMPLEMENTED — open items | `ee62fef68b`, `e9931ecea2`, `69af451f9c`, `7ef13082ec`, `e9bbe6459c`, `b21f46377a`, `5de4a3a656`, `f1bf5fbff7`, `53b3fb93f9`, `422f7143ad`, `1122a710fb` | [FX7](../../reviews/2026-10-02-lane12-replan/impl-C/FX7.md), [FX10](../../reviews/2026-10-02-lane12-replan/impl-C/FX10.md), [FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md), [FX13](../../reviews/2026-10-02-lane12-replan/impl-C/FX13.md) and [FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) record real configurator/finite-duration/deadline/qualification GREEN; [FUI2](../../reviews/2026-10-02-lane12-replan/impl-C/FUI2.md), [FUI3](../../reviews/2026-10-02-lane12-replan/impl-C/FUI3.md) and [FUI4](../../reviews/2026-10-02-lane12-replan/impl-C/FUI4.md) implement [TASTE](../../reviews/2026-10-02-lane12-replan/impl-C/TASTE.md) presentation fixes. [CD11/CD12/CD14](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) distinguish one-off deadline from native Ends and selected-launch capabilities. | Common gate; QAC3 configurator/Save/phone summary and lab comparisons remain in progress. Reconcile FUI3's retained icon/picker/disabled-removal presentation leftovers; owner renders do not close loaded keyboard/focus/large-text/reduced-motion/performance. | Real provider option/price/image and native-duration qualification; physical mobile/desktop behavior and signing. |
| 51s3 | IMPLEMENTED — open items | `ee62fef68b`, `e9931ecea2`, `7ef13082ec`, `751f8d9477`, `53b3fb93f9`, `1122a710fb` | [C51C](../../reviews/2026-10-02-lane12-replan/impl-C/C51C.md) records ordinary draft/managed continuation GREEN; [FX7](../../reviews/2026-10-02-lane12-replan/impl-C/FX7.md) repairs pre-spend start admission; [FX11](../../reviews/2026-10-02-lane12-replan/impl-C/FX11.md) repairs addressed source continuation and [FX12](../../reviews/2026-10-02-lane12-replan/impl-C/FX12.md)/[FX15](../../reviews/2026-10-02-lane12-replan/impl-C/FX15.md) supply lifecycle/archive-rule presentation. [CD4/CD5/CD13](../../reviews/2026-10-02-lane12-replan/impl-C/DECISIONS.md) retain FIN ownership and shared-controller limits. | Common gate; reconcile held current composer/catalog/locale producers and C42 requester focused handback, then preset/one-off Use/Back→approved acquire→Join/Set up→normal start→history/archive/restore with no stale continuation. Unloaded source-Session rule discovery remains 52s3/Main's open evidence. | Native enrolled Session continuity and real requester/vendor billing; physical composer/keyboard and signing. |

## 12. Live QA segment

Use the existing checkout's managed development UI/Home/daemon; record observed Home/controller installation, loaded
current-source UI/daemon versions and actual provider contribution. Add this segment to the umbrella's **one composed
journey**, not another QA ledger: Machines → preset with real returned Lima options → change size/image/Keep/controller
→ Save (no VM) → phone receipt/back → Use in ordinary composer → review/deny then approve Create → actual 50
create/install/join → Session start → detail immutable receipt → edit/archive preset → resource unchanged/history linked
→ restore. Exercise a real same-resource failed-install/retry/cancel path via the native boundary; resource recovery is
not a UI timer.

Compare final `m-config A/Ap/L/Lp`/`m-pick A/Ap/Aprog` at desktop and 390px/light/dark, unknown options/price, offline/controller
pending/refused, table keyboard/screen reader, large text, reduced motion, phone keyboard/safe area/focus. Measure
selection/options refresh render locality; no per-row eager Machine subscription. Invoke preset/get/acquire through
CLI/Agent/MCP and eligible Voice normal approval and trace to the same row; concrete admitted app navigation needs an
answering client; local presentation has no transported callbacks. Native macOS/vendor physical checks are the
umbrella's named release checks, not per-feature archive gates. No tests/live operation were executed by this
plan-writing lane.

## 13. Economy notes

Keep one future recipe/revision/archive and immutable acquired snapshot: these serve named user flows. Do not build Team
budget store, cost estimator, second credentials table, warm pool, price-refresh scheduler, preset version-history
service, global cap, copied Agent/Project recipe, custom option form engine or separate receipt SDK architecture.
Optional limit consumes 50's admitted rows, not another reservation table. One normal composer transaction replaces
parallel seed/start logic; existing artifact destinations are distinct publication flow, not a license for a managed
Runner path. Shared neutral primitives co-land with real consumers.

## 14. Open items

Resolve any remaining final-design questions and gaps recorded in `lanes/repoint.md` at their owning slices.

Empirical owner checks: 51s1 current native options/prices/credential visibility/schema and published predecessor
frontier; 51s2 actual public export/table gap and phone/layout measurements; 51s3 actual composer admission/cancellation
and artifact-target neighbor. Any unavailable price/platform fact remains truthful; it does not justify cutting promised
provider breadth.

Residual risk: optional cap semantics require the specified real transaction proof; native fact freshness, current
membership, composer continuation and public table behavior require deciding implementation/live evidence.

History: see archive-r8.4 and the review folder
