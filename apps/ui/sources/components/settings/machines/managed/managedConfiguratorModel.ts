import { z } from 'zod/mini';
import type { MachineProvisionerOptionsResultV1, MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedControllerV1, ValidatedLaunchSnapshotV1, ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { MachineRetentionDefaultsV1, MachineRetentionOverrideV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { InputHints } from '@happier-dev/protocol/inputs/inputFields';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { MACHINE_PROVISIONER_DIMENSIONS_V1, type MachineProvisionerDimensionV1, projectMachineProvisionerSelectionV1, readMachineProvisionerSelectionForLaunchV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { managedSizeMemoryRecommendation } from './managedSizeMemoryRecommendation';

export type ManagedConfiguratorDraft = Readonly<{
    provisioner: MachineProvisionersListResultV1['provisioners'][number];
    controller?: ManagedControllerV1; name: string;
    enrollmentIdentity?: ManagedMachineEnrollmentIdentityV1;
    /** Derived defaults follow guest selection; an explicit caller identity remains intentional. */
    enrollmentIdentityDefaulted?: true;
    credentials?: ValidatedLaunchSnapshotV1['credentials'];
    /** Future setup belongs to the preset revision, never native provisioner choices. */
    setup?: MachineSetupV1;
    /** Explicit editable values may be temporarily invalid; only the declared options schema admits a probe. */
    optionsSelectors?: Readonly<Record<string, unknown>>;
    /** A deliberate form edit may advance its native review; ordinary refreshes cannot substitute a launch. */
    optionsSelectorsEdited?: true;
    options: MachineProvisionerOptionsResultV1 | null;
    selected: ManagedConfiguratorSelection | null;
    /** Unsaved, explicit dimension selections; executable projection belongs to Protocol. */
    dimensionSelection?: Partial<Record<ManagedConfiguratorDimension, string>>;
    choicesSchema: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
    optionStatus: 'current' | 'loading' | 'unavailable';
    check?: MachineProvisionerCheckResultV1;
    categoryPreferences?: MachineRetentionDefaultsV1;
    override?: MachineRetentionOverrideV1;
    preset?: Readonly<{ id: string; revision: number; name?: string }> & MachineRetentionOverrideV1;
    /** Exact public preset review; a member cannot replace its launch or spending policy. */
    delegatedFacts?: ManagedConfigurationFactsV1;
}>;
export type ManagedConfiguratorDimension = MachineProvisionerDimensionV1;
/** Adopt the current catalog before its check/options read, retaining the person's draft. */
export function refreshManagedConfiguratorProvisioner(draft: ManagedConfiguratorDraft,
    provisioner: ManagedConfiguratorDraft['provisioner'], controller?: ManagedControllerV1): ManagedConfiguratorDraft {
    if (!pluginJsonValuesEqual(draft.controller ?? null, controller ?? null)) return draft;
    const selections = managedConfiguratorCredentialSelections(draft, provisioner);
    const next = setManagedConfiguratorCredentials(draft, selections);
    if (next.provisioner === provisioner) return next;
    return { ...next, provisioner, choicesSchema: createManagedConfiguratorDraft({ provisioner,
        controller: next.controller, name: next.name }).choicesSchema, optionStatus: 'loading', check: undefined };
}
const dimensions = MACHINE_PROVISIONER_DIMENSIONS_V1;
type Projection = ReturnType<typeof projectMachineProvisionerSelectionV1>;
type ManagedConfiguratorSelection = Readonly<{
    id: string; title: MachineProvisionerOptionsResultV1['dimensions']['size'][number]['title'];
    launch: Extract<Projection, { kind: 'ready' }>['launch'];
    guestPlatform?: Projection['guestPlatform'];
    enrollmentRole?: Projection['enrollmentRole'];
    prices?: Projection['prices']; nativeFacts?: Projection['nativeFacts'];
    billing?: Projection['billing']; retention?: Projection['retention']; effectReview?: Projection['effectReview'];
}>;
/** One selected-variant capability input for configuration, policy and admission facts. */
export function managedConfiguratorCapabilities(draft: Pick<ManagedConfiguratorDraft, 'provisioner' | 'selected'>
    & Partial<Pick<ManagedConfiguratorDraft, 'options' | 'dimensionSelection'>>, projection?: Projection | null) {
    const current = projection === undefined ? draft.options ? projectMachineProvisionerSelectionV1({ options: draft.options,
        selection: draft.dimensionSelection ?? {}, launchSchema: draft.provisioner.descriptor.launchSchema }) : null : projection;
    return { billing: current?.billing ?? draft.selected?.billing ?? draft.provisioner.descriptor.billing,
        retention: current?.retention ?? draft.selected?.retention ?? draft.provisioner.descriptor.retention };
}
export function managedConfiguratorDimensionSelection(draft: ManagedConfiguratorDraft): Partial<Record<ManagedConfiguratorDimension, string>> {
    const selection = draft.dimensionSelection ?? Object.fromEntries(dimensions.flatMap(dimension => {
        const fact = draft.selected?.nativeFacts?.[dimension];
        return fact && draft.options?.dimensions[dimension].length ? [[dimension, fact.id]] : [];
    }));
    // Networking comes with the machine rather than being a prerequisite pick: until the person chooses another,
    // the provider's first declared variant stands, visibly selected, so size, image and place complete the choice.
    const network = selection.network ?? draft.options?.dimensions.network[0]?.id;
    return network ? { ...selection, network } : selection;
}
export function managedConfiguratorProjection(draft: ManagedConfiguratorDraft, selection = managedConfiguratorDimensionSelection(draft)) {
    return draft.options ? projectMachineProvisionerSelectionV1({ options: draft.options, selection,
        launchSchema: draft.provisioner.descriptor.launchSchema }) : null;
}
export function managedConfiguratorMissingDimension(draft: ManagedConfiguratorDraft,
    projection = managedConfiguratorProjection(draft)): ManagedConfiguratorDimension | undefined {
    if (draft.optionStatus !== 'current' || projection?.kind !== 'incomplete') return undefined;
    const selection = managedConfiguratorDimensionSelection(draft);
    return dimensions.find(dimension => draft.options!.dimensions[dimension].length > 0 && selection[dimension] === undefined);
}
export function managedConfiguratorDimensionChoices(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension) {
    const selection = managedConfiguratorDimensionSelection(draft);
    const rows = (draft.options?.dimensions[dimension] ?? []).map(option => {
        // This row supplies its candidate already. Other siblings cannot affect
        // that candidate's projection; retain all cross-dimension constraints.
        const projection = managedConfiguratorProjection({ ...draft, options: draft.options ? { ...draft.options,
            dimensions: { ...draft.options.dimensions, [dimension]: [option] } } : null }, { ...selection, [dimension]: option.id });
        return { choice: { id: option.id, title: option.title, nativeFacts: projection?.nativeFacts,
            prices: projection?.prices.length ? projection.prices : undefined }, available: projection?.kind !== 'unavailable' && projection?.kind !== 'invalid',
            ...(projection?.kind === 'invalid' && projection.code === 'invalid_launch' ? { invalidLaunch: true as const } : {}),
            unavailableReason: projection?.unavailableReason,
            selectable: option.available !== false,
            recommendedMemoryBytes: dimension === 'size' ? managedSizeMemoryRecommendation(projection?.nativeFacts?.size?.memoryBytes,
                managedConfiguratorCapabilities(draft, projection).billing.location) : undefined };
    });
    const retained = draft.selected?.nativeFacts?.[dimension];
    const retainedId = draft.dimensionSelection?.[dimension];
    if (retained && retainedId !== undefined && !rows.some(row => row.choice.id === retainedId)) rows.push({ choice: { id: retainedId,
        title: dimensions.filter(key => draft.dimensionSelection?.[key]).length === 1 ? draft.selected!.title : retained.title,
        nativeFacts: draft.selected?.nativeFacts, prices: draft.selected?.prices }, available: false, selectable: false, unavailableReason: undefined,
        recommendedMemoryBytes: dimension === 'size' ? managedSizeMemoryRecommendation(draft.selected?.nativeFacts?.size?.memoryBytes,
            managedConfiguratorCapabilities(draft).billing.location) : undefined });
    return rows;
}
function selectedProjection(draft: ManagedConfiguratorDraft, projection: Extract<Projection, { kind: 'ready' }>,
    selection = managedConfiguratorDimensionSelection(draft)): ManagedConfiguratorSelection {
    const options = dimensions.flatMap(dimension => draft.options?.dimensions[dimension].filter(option => option.id === selection[dimension]) ?? []);
    return { id: 'selection', title: options.length === 1 ? options[0]!.title : draft.name,
        launch: projection.launch, prices: projection.prices.length ? projection.prices : undefined,
        nativeFacts: projection.nativeFacts, billing: projection.billing, retention: projection.retention, effectReview: projection.effectReview,
        guestPlatform: projection.guestPlatform, enrollmentRole: projection.enrollmentRole };
}
/** Declared enrollment purpose and selected guest facts are the only default authority. */
export function managedConfiguratorEnrollmentDefault(draft: Pick<ManagedConfiguratorDraft, 'provisioner' | 'selected'> & Partial<Pick<ManagedConfiguratorDraft, 'options'>>): Readonly<{
    identity: ManagedMachineEnrollmentIdentityV1;
    unavailableReason?: 'dedicated_identity_requires_linux';
    /** A declared server whose guest isn't known yet: its dedicated identity waits on the selection. */
    awaitingGuestPlatform?: true;
    /** The waiting server has an image list to choose from; without one (no account, still reading) there is nothing to prompt for. */
    guestImageOffered?: true;
}> {
    const role = draft.selected?.enrollmentRole ?? draft.provisioner.descriptor.enrollmentRole;
    if (role === 'sandbox') return { identity: { kind: 'guestProcess', role: 'sandbox' } };
    const guestPlatform = draft.selected?.guestPlatform;
    if (role === 'server' && guestPlatform === 'linux') return { identity: {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'preauthorized',
    } };
    return { identity: { kind: 'existingUser', role: 'personal' },
        ...(role !== 'server' ? {} : guestPlatform !== undefined ? { unavailableReason: 'dedicated_identity_requires_linux' as const }
            : { awaitingGuestPlatform: true as const, ...(draft.options?.dimensions.image.length ? { guestImageOffered: true as const } : {}) }) };
}
function refreshEnrollmentDefault(draft: ManagedConfiguratorDraft): ManagedConfiguratorDraft {
    if (!draft.enrollmentIdentityDefaulted) return draft;
    const identity = managedConfiguratorEnrollmentDefault(draft).identity;
    // Keep the person's administrator choice while the declared identity is unchanged.
    if (draft.enrollmentIdentity?.kind === identity.kind && draft.enrollmentIdentity.role === identity.role) return draft;
    return { ...draft, enrollmentIdentity: identity };
}
/** All executable selector assignments and constraints are applied by the shared Protocol owner. */
export function selectManagedConfiguratorDimension(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension, id: string): ManagedConfiguratorDraft {
    if (!draft.options?.dimensions[dimension].some(option => option.id === id && option.available !== false)) return draft;
    const selection = { ...managedConfiguratorDimensionSelection(draft), [dimension]: id };
    const projection = managedConfiguratorProjection(draft, selection);
    return refreshEnrollmentDefault({ ...draft, dimensionSelection: selection, selected: projection?.kind === 'ready' ? selectedProjection(draft, projection, selection) : null,
        optionsSelectorsEdited: projection?.kind === 'ready' ? undefined : draft.optionsSelectorsEdited });
}
export function createManagedConfiguratorDraft(input: Pick<ManagedConfiguratorDraft, 'provisioner' | 'controller' | 'name' | 'enrollmentIdentity' | 'credentials' | 'setup' | 'optionsSelectors' | 'categoryPreferences' | 'override' | 'preset' | 'delegatedFacts'>): ManagedConfiguratorDraft {
    return { ...input,
        enrollmentIdentity: input.enrollmentIdentity ?? managedConfiguratorEnrollmentDefault({ provisioner: input.provisioner, selected: null }).identity,
        enrollmentIdentityDefaulted: input.enrollmentIdentity === undefined ? true : undefined,
        options: null, selected: input.delegatedFacts ? { id: `preset:${input.preset?.id}`, title: input.name,
            launch: input.delegatedFacts.launch.choices, nativeFacts: input.delegatedFacts.nativeFacts,
            prices: input.delegatedFacts.prices, billing: input.delegatedFacts.billing, retention: input.delegatedFacts.retentionCapabilities } : null,
        optionStatus: input.delegatedFacts?.optionStatus ?? 'loading',
        ...(input.delegatedFacts ? { check: { available: input.delegatedFacts.optionStatus === 'current' } } : {}),
        choicesSchema: createPluginJsonSchemaZodValueAdapter(input.provisioner.descriptor.launchSchema) };
}
/** Saved launchs use the existing persistence projection; current edits remain strictly admitted. */
export function managedConfiguratorOptionsSelectors(draft: ManagedConfiguratorDraft, inputSchema: PluginJsonSchemaV2, hints?: InputHints) {
    const schema = createPluginJsonSchemaZodValueAdapter(inputSchema);
    // A fresh launch starts from the provider's declared field defaults; a saved one reads only what it stored.
    const seeded = (value: Readonly<Record<string, unknown>>) => hints ? seedInputByFieldHints({ inputHints: hints }, value) : value;
    const parsed = draft.optionsSelectors !== undefined ? schema.safeParse(seeded(draft.optionsSelectors))
        : draft.preset && draft.selected ? createStoredReadSchema(schema).safeParse(draft.selected.launch)
            : schema.safeParse(seeded({}));
    return parsed.success ? PluginJsonValueV2Schema.parse(parsed.data) : null;
}
export function setManagedConfiguratorOptionsSelectors(draft: ManagedConfiguratorDraft,
    selectors: Readonly<Record<string, unknown>>): ManagedConfiguratorDraft {
    return { ...draft, optionsSelectors: selectors, optionsSelectorsEdited: true, optionStatus: 'loading' };
}
/** Only the current occurrence's purpose options authorize a retained qualified ref. */
export function managedConfiguratorCredentialSelections(draft: Pick<ManagedConfiguratorDraft, 'credentials'> & Partial<Pick<ManagedConfiguratorDraft, 'selected' | 'optionsSelectors'>>,
    provisioner: ManagedConfiguratorDraft['provisioner']): NonNullable<ManagedConfiguratorDraft['credentials']> {
    return (provisioner.credentialPurposes ?? []).flatMap(({ purpose, options }) => {
        if (!isMachineProvisionerCredentialPurposeRequiredV1(provisioner.descriptor, purpose.purpose,
            draft.optionsSelectors ?? draft.selected?.launch)) return [];
        const selected = draft.credentials?.find(credential => qualifiedPurposeKey(credential.purpose) === qualifiedPurposeKey(purpose)
            && options.some(option => sameQualifiedConnectedAccountRef(option.value, credential.account)));
        return selected ? [selected] : [];
    });
}
/** Credential edits preserve the launch while retiring the previous native review. */
export function setManagedConfiguratorCredentials(draft: ManagedConfiguratorDraft,
    credentials: ManagedConfiguratorDraft['credentials']): ManagedConfiguratorDraft {
    if (pluginJsonValuesEqual(draft.credentials ?? [], credentials ?? [])) return draft;
    return { ...draft, credentials: credentials?.length ? credentials : undefined, optionStatus: 'loading', check: undefined };
}
/**
 * `selectors` are the form values the read was asked with. A free-form host (Cua) answers with one size that
 * assigns exactly what the form sent: the form already made that choice, so the row is selected, never re-asked.
 */
export function refreshManagedConfiguratorOptions(draft: ManagedConfiguratorDraft, options: MachineProvisionerOptionsResultV1,
    selectors?: unknown): ManagedConfiguratorDraft {
    let selection = {
        ...(!draft.selected && options.base ? readMachineProvisionerSelectionForLaunchV1(options, options.base.launch) : {}),
        ...managedConfiguratorDimensionSelection(draft),
    };
    // A fully qualified form already supplied this sole native fact. Keep its
    // visible row selected rather than asking the person to repeat that input.
    const supplied = (assignment: Readonly<{ path: string; value: unknown }>) =>
        pluginJsonValuesEqual(readInputPath(options.base?.launch, assignment.path), assignment.value)
        || selectors !== undefined && pluginJsonValuesEqual(readInputPath(selectors, assignment.path), assignment.value);
    for (const dimension of dimensions) {
        const entries = options.dimensions[dimension];
        const only = entries.length === 1 ? entries[0] : undefined;
        const editedMissing = draft.optionsSelectorsEdited === true && !entries.some(entry => entry.id === selection[dimension]);
        if ((selection[dimension] === undefined || editedMissing) && only && options.base && only.assignments.every(supplied)) {
            selection[dimension] = only.id;
        }
    }
    if (draft.selected) selection = { ...readMachineProvisionerSelectionForLaunchV1(options, draft.selected.launch), ...selection };
    const next = { ...draft, options, dimensionSelection: selection, optionStatus: 'current' as const };
    selection = managedConfiguratorDimensionSelection(next);
    const projection = managedConfiguratorProjection(next, selection);
    const sameLaunch = projection?.kind === 'ready' && draft.selected && pluginJsonValuesEqual(projection.launch, draft.selected.launch);
    const selected = projection?.kind === 'ready' && (!draft.selected || sameLaunch || draft.optionsSelectorsEdited === true)
        ? selectedProjection(next, projection) : draft.selected;
    return refreshEnrollmentDefault({ ...next, dimensionSelection: selection, selected,
        optionsSelectorsEdited: projection?.kind === 'ready' ? undefined : draft.optionsSelectorsEdited });
}
export function managedConfiguratorFacts(draft: ManagedConfiguratorDraft, projection?: ReturnType<typeof managedConfiguratorProjection>): ManagedConfigurationFactsV1 | null {
    if (draft.delegatedFacts) {
        const facts = draft.delegatedFacts;
        return draft.preset?.id === facts.preset?.id && draft.preset?.revision === facts.preset?.revision
            && draft.name === facts.launch.name && pluginJsonValuesEqual(draft.controller, facts.controller)
            && pluginJsonValuesEqual(draft.selected?.launch, facts.launch.choices) ? facts : null;
    }
    const selected = draft.selected;
    if (!selected || selected.launch === undefined || !draft.name.trim()) return null;
    const current = projection === undefined ? managedConfiguratorProjection(draft) : projection;
    const capabilities = managedConfiguratorCapabilities(draft, current);
    const credentials = draft.credentials?.filter(credential => isMachineProvisionerCredentialPurposeRequiredV1(
        draft.provisioner.descriptor, credential.purpose.purpose, selected.launch));
    try { return buildManagedConfigurationFactsV1({ choicesSchema: draft.choicesSchema,
        launch: { provider: draft.provisioner.contribution, schemaVersion: draft.provisioner.descriptor.schemaVersion,
            name: draft.name, choices: selected.launch, ...(credentials?.length ? { credentials } : {}) }, controller: draft.controller,
        optionStatus: draft.optionStatus,
        provisioner: draft.provisioner.descriptor,
        ...(current ? { optionProjection: current } : {}),
        billing: capabilities.billing, retentionCapabilities: capabilities.retention,
        prerequisites: draft.check?.prerequisites ?? [], localResources: draft.check?.localResources,
        prices: selected.prices,
        nativeFacts: selected.nativeFacts, machineOverride: draft.override, preset: draft.preset, setup: draft.setup,
        categoryPreferences: draft.categoryPreferences }); }
    catch (error) {
        if (error instanceof z.core.$ZodError) return null;
        throw error;
    }
}
export function managedConfiguratorAcquireInput(draft: ManagedConfiguratorDraft, homeId: string): ManagedAcquireInputV1 | null {
    const facts = managedConfiguratorFacts(draft);
    if (!facts || facts.optionStatus !== 'current' || draft.check?.available === false || !draft.enrollmentIdentity) return null;
    if (draft.preset) return ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: draft.enrollmentIdentity,
        selection: { kind: 'preset', homeId, id: draft.preset.id, revision: draft.preset.revision },
        controller: facts.controller, retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage, reviewedFacts: facts });
    const { setup: _environment, ...oneOffFacts } = facts;
    return ManagedAcquireInputV1Schema.parse({ enrollmentIdentity: draft.enrollmentIdentity, selection: { kind: 'one-off', homeId, launch: facts.launch,
        controller: facts.controller, retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage }, reviewedFacts: oneOffFacts });
}
