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

export type ManagedConfiguratorDraft = Readonly<{
    provisioner: MachineProvisionersListResultV1['provisioners'][number];
    controller: ManagedControllerV1; name: string;
    credentials?: ValidatedLaunchSnapshotV1['credentials'];
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
export function managedConfiguratorDimensionSelection(draft: ManagedConfiguratorDraft): Partial<Record<ManagedConfiguratorDimension, string>> {
    return draft.dimensionSelection ?? Object.fromEntries(dimensions.flatMap(dimension => {
        const fact = draft.selected?.nativeFacts?.[dimension];
        return fact ? [[dimension, fact.id]] : [];
    }));
}
function compatibleDimensionChoice(choice: Choice, selection: Partial<Record<ManagedConfiguratorDimension, string>>) {
    return dimensions.every(dimension => !selection[dimension] || choice.nativeFacts?.[dimension]?.id === selection[dimension]);
}
export function managedConfiguratorDimensionChoices(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension) {
    const candidates = [...draft.choices, ...(draft.selected ? [draft.selected] : [])];
    const ids = [...new Set(candidates.flatMap(choice => choice.nativeFacts?.[dimension]?.id ? [choice.nativeFacts[dimension]!.id] : []))];
    return ids.map(id => {
        const choice = candidates.find(candidate => candidate.nativeFacts?.[dimension]?.id === id)!;
        const available = draft.choices.find(candidate => candidate.available !== false && candidate.nativeFacts?.[dimension]?.id === id);
        return { choice: available ?? choice, available: !!available };
    });
}
/** Native launch values remain indivisible. A dimension change never synthesizes provider selectors. */
export function selectManagedConfiguratorDimension(draft: ManagedConfiguratorDraft, dimension: ManagedConfiguratorDimension, id: string): ManagedConfiguratorDraft {
    const independentDimensions = draft.provisioner.descriptor.retention.finiteOnly && draft.provisioner.descriptor.nativeDurationInput
        ? dimensions.filter(key => key !== 'duration') : dimensions;
    // A bound duration is edited through the declared options field, not selected a second time.
    const selection = { ...Object.fromEntries(Object.entries(managedConfiguratorDimensionSelection(draft))
        .filter(([key]) => independentDimensions.some(dimensionKey => dimensionKey === key))), [dimension]: id };
    const choice = draft.choices.find(candidate => candidate.available !== false && compatibleDimensionChoice(candidate, selection));
    if (!draft.choices.some(candidate => candidate.available !== false && candidate.nativeFacts?.[dimension]?.id === id)) return draft;
    const complete = independentDimensions.every(key => !draft.choices.some(candidate => candidate.nativeFacts?.[key]) || !!selection[key]);
    return { ...draft, dimensionSelection: complete && choice ? undefined : selection, selected: complete && choice ? choice : null };
}
export function createManagedConfiguratorDraft(input: Pick<ManagedConfiguratorDraft, 'provisioner' | 'controller' | 'name' | 'credentials' | 'categoryPreferences' | 'override' | 'preset'>): ManagedConfiguratorDraft {
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
        billing: draft.provisioner.descriptor.billing, retentionCapabilities: draft.provisioner.descriptor.retention,
        prerequisites: draft.check?.prerequisites ?? [], localResources: draft.check?.localResources,
        prices: selected.prices,
        nativeFacts: selected.nativeFacts, machineOverride: draft.override, preset: draft.preset, categoryPreferences: draft.categoryPreferences });
}
export function managedConfiguratorAcquireInput(draft: ManagedConfiguratorDraft, homeId: string): ManagedAcquireInputV1 | null {
    const facts = managedConfiguratorFacts(draft);
    if (!facts || facts.optionStatus !== 'current' || draft.check?.available === false) return null;
    return ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId, launch: facts.launch,
        controller: facts.controller, retention: facts.retention, wakeOnAcceptedMessage: facts.wakeOnAcceptedMessage }, reviewedFacts: facts });
}
