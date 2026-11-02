import { parseRelayAccessConfig, relayAccessProviderDescriptors, type RelayAccessConfig, type RelayAccessProviderDescriptor } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskSnapshot } from '@happier-dev/cli-common/systemTasks';

import { t, type TranslationKey } from '@/text';

export type RelayAccessConfigStepFieldId = string;
export type RelayAccessConfigStepProviderId = string;
export type RelayAccessConfigStepDraft = Readonly<Record<string, string>>;
export type RelayAccessCredentialRefs = readonly RelayAccessConfig['credentialRefs'][number][];

export type RelayAccessConfigStepField = Readonly<{
    id: string; label: string; placeholder: string;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
}>;

type DraftComparison = Readonly<{
    configuredDraft: RelayAccessConfigStepDraft;
    normalizedDraft: RelayAccessConfigStepDraft;
    configuredCredentialRefs?: RelayAccessCredentialRefs;
    credentialRefs?: RelayAccessCredentialRefs;
}>;

export type RelayAccessConfigStepDefinition = Readonly<{
    providerId: string;
    descriptor: RelayAccessProviderDescriptor;
    testIDPrefix: string;
    fields: readonly RelayAccessConfigStepField[];
    hint: string;
    readConfiguredDraft: (snapshot: RelayAccessTaskSnapshot | null) => RelayAccessConfigStepDraft;
    normalizeDraft: (draft: RelayAccessConfigStepDraft) => RelayAccessConfigStepDraft;
    isSaveNeeded: (params: DraftComparison) => boolean;
    isPrimaryDisabled: (params: Readonly<{ needsSave: boolean; normalizedDraft: RelayAccessConfigStepDraft; credentialRefs?: RelayAccessCredentialRefs }>) => boolean;
    createConfig: (params: Readonly<{ normalizedDraft: RelayAccessConfigStepDraft; credentialRefs?: RelayAccessCredentialRefs }>) => Promise<RelayAccessConfig | null>;
}>;

/** Home's form presentation is projected from the same declarations as config admission. */
export const relayAccessConfigStepCatalog: Readonly<Record<string, RelayAccessConfigStepDefinition>> = Object.freeze(
    Object.fromEntries(relayAccessProviderDescriptors.flatMap(descriptor => {
        const step = descriptor.homeUi?.configStep;
        if (!step || !descriptor.definition.targets.includes('homeRelay')) return [];
        const emptyDraft = () => Object.fromEntries(step.fields.map(field => [field.id, '']));
        const normalizeDraft = (draft: RelayAccessConfigStepDraft): RelayAccessConfigStepDraft => Object.fromEntries(step.fields.map(field => {
            const value = (draft[field.id] ?? '').trim();
            return [field.id, field.format === 'url' ? value.replace(/\/+$/, '') : value];
        }));
        const createSelection = (draft: RelayAccessConfigStepDraft, credentialRefs: RelayAccessCredentialRefs = []) => {
            if (descriptor.definition.credentialPurposes.some(requirement => requirement.required
                && !credentialRefs.some(ref => ref.purpose === requirement.purpose))) return null;
            return parseRelayAccessConfig({ provider: descriptor.provider, config: normalizeDraft(draft), credentialRefs: [...credentialRefs] });
        };
        const definition: RelayAccessConfigStepDefinition = {
            providerId: descriptor.id, descriptor,
            testIDPrefix: step.testIDPrefix,
            fields: step.fields.map(field => ({ id: field.id, label: t(field.labelKey as TranslationKey),
                placeholder: t((field.placeholderKey ?? field.labelKey) as TranslationKey), autoCapitalize: 'none', autoCorrect: false })),
            hint: t(step.hintKey as TranslationKey),
            readConfiguredDraft: snapshot => {
                if (!snapshot?.configured || snapshot.providerId !== descriptor.id) return emptyDraft();
                const selection = parseRelayAccessConfig(snapshot.selection);
                const config = selection?.config;
                if (!config || typeof config !== 'object' || Array.isArray(config)) return emptyDraft();
                const fields = config as Readonly<Record<string, unknown>>;
                return normalizeDraft(Object.fromEntries(step.fields.map(field => {
                    const value = fields[field.id];
                    return [field.id, typeof value === 'string' ? value : ''];
                })));
            },
            normalizeDraft,
            isSaveNeeded: ({ configuredDraft, normalizedDraft, configuredCredentialRefs = [], credentialRefs = [] }) =>
                !createSelection(configuredDraft, configuredCredentialRefs)
                || step.fields.some(field => normalizedDraft[field.id] !== configuredDraft[field.id])
                || JSON.stringify(configuredCredentialRefs) !== JSON.stringify(credentialRefs),
            isPrimaryDisabled: ({ needsSave, normalizedDraft, credentialRefs }) => needsSave && !createSelection(normalizedDraft, credentialRefs),
            createConfig: async ({ normalizedDraft, credentialRefs }) => createSelection(normalizedDraft, credentialRefs),
        };
        return [[descriptor.id, definition]];
    })),
);
