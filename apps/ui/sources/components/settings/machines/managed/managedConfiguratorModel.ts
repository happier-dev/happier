import type { MachineProvisionerOptionsResultV1, MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedControllerV1, ValidatedLaunchSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { MachineRetentionDefaultsV1, MachineRetentionOverrideV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { isMachineProvisionerCredentialPurposeRequiredV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';

export type ManagedConfiguratorDraft = Readonly<{
    provisioner: MachineProvisionersListResultV1['provisioners'][number];
    controller: ManagedControllerV1; name: string;
    credentials?: ValidatedLaunchSnapshotV1['credentials'];
    /** Future setup belongs to the preset revision, never native provisioner choices. */
    environment?: MachineEnvironmentV1;
    /** Explicit editable values may be temporarily invalid; only the declared options schema admits a probe. */
    optionsSelectors?: Readonly<Record<string, unknown>>;
    choices: MachineProvisionerOptionsResultV1['choices'];
    selected: MachineProvisionerOptionsResultV1['choices'][number] | null;
    /** Unsaved, explicit dimension selections until a complete returned native variant matches. */
    dimensionSelection?: Partial<Record<ManagedConfiguratorDimension, string>>;
    choicesSchema: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
    optionStatus: 'current' | 'loading' | 'unavailable';
    check?: MachineProvisionerCheckResultV1;
    categoryPreferences?: MachineRetentionDefaultsV1;
    override?: MachineRetentionOverrideV1;
    preset?: Readonly<{ id: string; revision: number; name?: string }> & MachineRetentionOverrideV1;
}>;
export type ManagedConfiguratorDimension = 'size' | 'image' | 'location' | 'duration';
const dimensions: readonly ManagedConfiguratorDimension[] = ['size', 'image', 'location', 'duration'];
type Choice = MachineProvisionerOptionsResultV1['choices'][number];
/** One selected-variant capability input for configuration, policy and admission facts. */
export function managedConfiguratorRetentionCapabilities(draft: Pick<ManagedConfiguratorDraft, 'provisioner' | 'selected'>) {
    return draft.selected?.retention ?? draft.provisioner.descriptor.retention;
}
export function managedConfiguratorDimensionSelection(draft: ManagedConfiguratorDraft): Partial<Record<ManagedConfiguratorDimension, string>> {
    return draft.dimensionSelection ?? Object.fromEntries(dimensions.flatMap(dimension => {
        const fact = draft.selected?.nativeFacts?.[dimension];
        return fact ? [[dimension, fact.id]] : [];
    }));
}
function compatibleDimensionChoice(choice: Choice, selection: Partial<Record<ManagedConfiguratorDimension, string>>) {
    return dimensions.every(dimension => !selection[dimension] || choice.nativeFacts?.[dimension]?.id === selection[dimension]);
}
/** Options selectors constrain their corresponding launch fields; query-only fields have no launch value. */
function compatibleLaunchSelectors(launch: unknown, selectors: Readonly<Record<string, unknown>>): boolean {
    // Scalar launches have no named fields. Every options field is query-only for that native shape.
    const fields = launch && typeof launch === 'object' && !Array.isArray(launch) ? launch : {};
    return compatibleLaunchSelectorValues(fields, selectors);
}
function compatibleLaunchSelectorValues(launch: unknown, selectors: unknown): boolean {
    if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) return pluginJsonValuesEqual(launch, selectors);
    if (!launch || typeof launch !== 'object' || Array.isArray(launch)) return false;
    const values = launch as Record<string, unknown>;
    return Object.entries(selectors).every(([key, value]) => !(key in values) || compatibleLaunchSelectorValues(values[key], value));
}
export function managedConfiguratorDimensionChoices(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension) {
    const candidates = [...draft.choices, ...(draft.selected ? [draft.selected] : [])];
    const ids = [...new Set(candidates.flatMap(choice => choice.nativeFacts?.[dimension]?.id ? [choice.nativeFacts[dimension]!.id] : []))];
    const remainingSelection = { ...managedConfiguratorDimensionSelection(draft), [dimension]: undefined };
    return ids.map(id => {
        const choice = candidates.find(candidate => candidate.nativeFacts?.[dimension]?.id === id)!;
        const selectable = draft.choices.filter(candidate => candidate.available !== false && candidate.nativeFacts?.[dimension]?.id === id
            && compatibleLaunchSelectors(candidate.launch, draft.optionsSelectors ?? {}));
        const applicable = selectable.filter(candidate => compatibleDimensionChoice(candidate, remainingSelection));
        const representative = applicable[0] ?? choice;
        // A conditional or unavailable comparison must never borrow an arbitrary region/network quote.
        const prices = applicable.length === 1 ? representative.prices : undefined;
        return { choice: prices === representative.prices ? representative : { ...representative, prices }, available: applicable.length > 0,
            selectable: selectable.length > 0 };
    });
}
/** Native launch values remain indivisible. A dimension change never synthesizes provider selectors. */
export function selectManagedConfiguratorDimension(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension, id: string): ManagedConfiguratorDraft {
    const independentDimensions = managedConfiguratorRetentionCapabilities(draft).finiteOnly && draft.provisioner.descriptor.nativeDurationInput
        ? dimensions.filter(key => key !== 'duration') : dimensions;
    // A bound duration is edited through the declared options field, not selected a second time.
    const selection = { ...Object.fromEntries(Object.entries(managedConfiguratorDimensionSelection(draft))
        .filter(([key]) => independentDimensions.some(dimensionKey => dimensionKey === key))), [dimension]: id };
    const matching = draft.choices.filter(candidate => candidate.available !== false && compatibleDimensionChoice(candidate, selection)
        && compatibleLaunchSelectors(candidate.launch, draft.optionsSelectors ?? {}));
    const choice = matching[0];
    if (!draft.choices.some(candidate => candidate.available !== false && candidate.nativeFacts?.[dimension]?.id === id)) return draft;
    // A fixed finite lifetime is part of the complete native variant. Requiring
    // its Ends control before that variant is selected would make it unreachable.
    // Distinct native duration alternatives still require an explicit selection.
    const fixedFiniteDuration = choice?.retention?.finiteOnly === true && choice.nativeFacts?.duration
        && matching.every(candidate => candidate.nativeFacts?.duration?.id === choice.nativeFacts?.duration?.id);
    const complete = independentDimensions.every(key => !draft.choices.some(candidate => candidate.nativeFacts?.[key])
        || !!selection[key] || key === 'duration' && fixedFiniteDuration);
    return { ...draft, dimensionSelection: complete && choice ? undefined : selection, selected: complete && choice ? choice : null };
}
export function createManagedConfiguratorDraft(input: Pick<ManagedConfiguratorDraft, 'provisioner' | 'controller' | 'name' | 'credentials' | 'environment' | 'categoryPreferences' | 'override' | 'preset'>): ManagedConfiguratorDraft {
    return { ...input, choices: [], selected: null, optionStatus: 'loading',
        choicesSchema: createPluginJsonSchemaZodValueAdapter(input.provisioner.descriptor.launchSchema) };
}
/** Saved recipes use the existing persistence projection; current edits remain strictly admitted. */
export function managedConfiguratorOptionsSelectors(draft: ManagedConfiguratorDraft, inputSchema: PluginJsonSchemaV2) {
    const schema = createPluginJsonSchemaZodValueAdapter(inputSchema);
    const parsed = draft.optionsSelectors !== undefined ? schema.safeParse(draft.optionsSelectors)
        : draft.preset && draft.selected ? createStoredReadSchema(schema).safeParse(draft.selected.launch)
            : schema.safeParse({});
    return parsed.success ? parsed.data : null;
}
export function setManagedConfiguratorOptionsSelectors(draft: ManagedConfiguratorDraft,
    selectors: Readonly<Record<string, unknown>>): ManagedConfiguratorDraft {
    return { ...draft, optionsSelectors: selectors, optionStatus: 'loading' };
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
/** Credential edits preserve the recipe while retiring the previous native review. */
export function setManagedConfiguratorCredentials(draft: ManagedConfiguratorDraft,
    credentials: ManagedConfiguratorDraft['credentials']): ManagedConfiguratorDraft {
    if (pluginJsonValuesEqual(draft.credentials ?? [], credentials ?? [])) return draft;
    return { ...draft, credentials: credentials?.length ? credentials : undefined, optionStatus: 'loading', check: undefined };
}
export function refreshManagedConfiguratorOptions(draft: ManagedConfiguratorDraft, options: MachineProvisionerOptionsResultV1): ManagedConfiguratorDraft {
    const current = options.choices.find(choice => choice.id === draft.selected?.id)
        ?? (draft.selected?.id.startsWith('preset:')
            ? options.choices.find(choice => pluginJsonValuesEqual(choice.launch, draft.selected?.launch)) : undefined);
    const unchanged = current && draft.selected && pluginJsonValuesEqual(current.launch, draft.selected.launch);
    return { ...draft, choices: options.choices, selected: unchanged ? current : draft.selected, optionStatus: 'current' };
}
export function selectManagedConfiguratorChoice(draft: ManagedConfiguratorDraft, id: string): ManagedConfiguratorDraft {
    const selected = draft.choices.find(choice => choice.id === id);
    return selected ? { ...draft, selected, dimensionSelection: undefined } : draft;
}
export function managedConfiguratorFacts(draft: ManagedConfiguratorDraft): ManagedConfigurationFactsV1 | null {
    const selected = draft.selected;
    if (!selected || selected.launch === undefined || !draft.name.trim()) return null;
    const parsed = draft.choicesSchema.safeParse(selected.launch);
    if (!parsed.success) return null;
    const current = draft.choices.find(choice => choice.id === selected.id);
    const available = current && current.available !== false && pluginJsonValuesEqual(current.launch, selected.launch);
    const credentials = draft.credentials?.filter(credential => isMachineProvisionerCredentialPurposeRequiredV1(
        draft.provisioner.descriptor, credential.purpose.purpose, parsed.data));
    return buildManagedConfigurationFactsV1({ choicesSchema: draft.choicesSchema,
        launch: { provider: draft.provisioner.contribution, schemaVersion: draft.provisioner.descriptor.schemaVersion,
            name: draft.name, choices: parsed.data, ...(credentials?.length ? { credentials } : {}) }, controller: draft.controller,
        optionStatus: draft.optionStatus !== 'current' ? draft.optionStatus : available ? 'current' : 'unavailable',
        billing: draft.provisioner.descriptor.billing, retentionCapabilities: managedConfiguratorRetentionCapabilities(draft),
        prerequisites: draft.check?.prerequisites ?? [], localResources: draft.check?.localResources,
        prices: selected.prices,
        nativeFacts: selected.nativeFacts, machineOverride: draft.override, preset: draft.preset, environment: draft.environment,
        categoryPreferences: draft.categoryPreferences });
}
export function managedConfiguratorAcquireInput(draft: ManagedConfiguratorDraft, homeId: string): ManagedAcquireInputV1 | null {
    const facts = managedConfiguratorFacts(draft);
    if (!facts || facts.optionStatus !== 'current' || draft.check?.available === false) return null;
    const { environment: _environment, ...oneOffFacts } = facts;
    return ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId, launch: facts.launch,
        controller: facts.controller, retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage }, reviewedFacts: oneOffFacts });
}
