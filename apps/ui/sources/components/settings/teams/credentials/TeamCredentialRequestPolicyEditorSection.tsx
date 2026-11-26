import * as React from 'react';
import {
    PROVIDER_REASONING_EFFORT_LEVELS_V1,
    formatProviderReasoningEffortLevelLabel,
    readProviderReasoningEffortOption,
} from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import type {
    TeamCredentialRequestPolicyModelSupportV1,
    TeamCredentialRequestPolicySupportOutputV1,
    TeamCredentialRequestProtocolKindV1,
} from '@happier-dev/protocol/teams';

import { OptionPickerOverlay, type OptionPickerOption } from '@/components/sessions/pickers/OptionPickerOverlay';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { presentProviderModelRow } from '@/providers/models/presentProviderModelRow';
import { t } from '@/text';

import { requestProtocolKindLabel } from './teamCredentialPresentation';
import {
    EMPTY_TEAM_CREDENTIAL_POLICY_DRAFT,
    teamCredentialPolicyFromDraft,
    type TeamCredentialPolicyDraft,
} from './teamCredentialEditorDraft';

export type TeamCredentialRequestPolicyEditorSectionProps = Readonly<{
    draft: TeamCredentialPolicyDraft;
    setDraft: React.Dispatch<React.SetStateAction<TeamCredentialPolicyDraft>>;
    support: TeamCredentialRequestPolicySupportOutputV1;
    busy: boolean;
    testIDPrefix?: string;
}>;

function unique<T>(values: readonly T[]): readonly T[] {
    return [...new Set(values)];
}

function intersect(values: readonly (readonly string[])[]): readonly string[] {
    const [first, ...rest] = values;
    if (!first) return [];
    return unique(first).filter((value) => rest.every((candidates) => candidates.includes(value)));
}

export type TeamCredentialRequestPolicyEditorSupportProjection = Readonly<{
    models: readonly TeamCredentialRequestPolicyModelSupportV1[];
    protocolKinds: readonly TeamCredentialRequestProtocolKindV1[];
    reasoningEffortValues: readonly string[];
    storedPolicyUnsupported: boolean;
}>;

/**
 * Collapses exact application rows into the fields one model-id policy can
 * safely constrain. A field is offered only when every currently allowed
 * model/protocol path can enforce it; unions would overstate enforcement.
 */
export function projectTeamCredentialRequestPolicyEditorSupport(input: Readonly<{
    models: readonly TeamCredentialRequestPolicyModelSupportV1[];
    draft: TeamCredentialPolicyDraft;
}>): TeamCredentialRequestPolicyEditorSupportProjection {
    const byModelId = new Map<string, TeamCredentialRequestPolicyModelSupportV1[]>();
    for (const model of input.models) {
        const rows = byModelId.get(model.descriptor.id) ?? [];
        rows.push(model);
        byModelId.set(model.descriptor.id, rows);
    }
    const models = [...byModelId.values()].map((rows) => rows[0]!);
    const selectedModelIds = input.draft.allowedModelIds ?? [...byModelId.keys()];
    const missingModel = selectedModelIds.some((modelId) => !byModelId.has(modelId));
    const candidateProtocols = unique(input.models.flatMap((model) => model.allowedProtocolKinds));
    const protocolKinds = missingModel || selectedModelIds.length === 0
        ? []
        : candidateProtocols.filter((protocol) => selectedModelIds.every((modelId) => (
            byModelId.get(modelId)?.every((row) => row.allowedProtocolKinds.includes(protocol)) === true
        )));
    const selectedProtocols = input.draft.protocols ?? protocolKinds;
    const missingProtocol = selectedProtocols.some((protocol) => !protocolKinds.includes(protocol));
    const relevantRows = selectedModelIds.flatMap((modelId) => byModelId.get(modelId) ?? []);
    const everyModelProtocolPairCovered = selectedModelIds.every((modelId) => selectedProtocols.every((protocol) => (
        byModelId.get(modelId)?.every((row) => row.allowedProtocolKinds.includes(protocol)) === true
    )));
    const constraintsComplete = !missingModel
        && !missingProtocol
        && relevantRows.length > 0
        && everyModelProtocolPairCovered;
    const reasoningEffortValues = constraintsComplete
        && relevantRows.every((row) => row.reasoningEffort !== null)
        ? intersect(relevantRows.map((row) => row.reasoningEffort!.allowedValues))
        : [];
    const storedPolicyUnsupported = missingModel
        || missingProtocol
        || (input.draft.reasoningEffort !== null && (
            reasoningEffortValues.length === 0
            || input.draft.reasoningEffort.allowedValues.some((value) => !reasoningEffortValues.includes(value))
        ));
    return {
        models,
        protocolKinds,
        reasoningEffortValues,
        storedPolicyUnsupported,
    };
}

/**
 * Controlled request-policy fields shared by resource creation and editing.
 *
 * The Home's value-free support response is the sole availability authority.
 * This component deliberately has no source-kind, route, revision, persistence,
 * or navigation knowledge.
 */
export const TeamCredentialRequestPolicyEditorSection = React.memo(
    function TeamCredentialRequestPolicyEditorSection(
        props: TeamCredentialRequestPolicyEditorSectionProps,
    ) {
        const { draft, setDraft, support, busy } = props;
        const testIDPrefix = props.testIDPrefix ?? 'team-credential-request-policy';
        const parsedDraft = teamCredentialPolicyFromDraft(draft);
        const hasStoredPolicy = parsedDraft !== null;

        const clearStoredPolicy = () => {
            if (busy) return;
            setDraft(EMPTY_TEAM_CREDENTIAL_POLICY_DRAFT);
        };

        if (support.status === 'unavailable') {
            return (
                <ItemGroup description={t('teams.credentials.requestPolicy.catalogUnavailable')}>
                    <Item
                        testID={`${testIDPrefix}-support-unavailable`}
                        title={t('common.unavailable')}
                        showChevron={false}
                    />
                    {hasStoredPolicy ? <Item
                        testID={`${testIDPrefix}-stored-unsupported`}
                        title={t('teams.credentials.requestPolicy.title')}
                        detail={t('teams.credentials.requestPolicy.activeNote')}
                        showChevron={false}
                    /> : null}
                    {hasStoredPolicy ? <Item
                        testID={`${testIDPrefix}-clear`}
                        title={t('teams.credentials.requestPolicy.clear')}
                        destructive
                        disabled
                        showChevron={false}
                    /> : null}
                </ItemGroup>
            );
        }

        const projection = projectTeamCredentialRequestPolicyEditorSupport({
            models: support.models,
            draft,
        });
        const modelOptions: readonly OptionPickerOption<string>[] = projection.models.map((model) => {
            const presentation = presentProviderModelRow({
                modelId: model.descriptor.id,
                name: model.descriptor.name,
                description: model.descriptor.description,
            });
            return {
                value: model.descriptor.id,
                label: presentation.label,
                description: presentation.description,
            };
        });
        const storedModelOptions = (draft.allowedModelIds ?? [])
            .filter((modelId) => !modelOptions.some((option) => option.value === modelId))
            .map((modelId) => ({ value: modelId, label: modelId, disabled: true }));
        const protocolKinds = projection.protocolKinds;
        const effortNames = new Map(projection.reasoningEffortValues.length > 0 ? support.models.flatMap((row) => {
            if (draft.allowedModelIds !== null && !draft.allowedModelIds.includes(row.descriptor.id)) return [];
            return readProviderReasoningEffortOption(row.descriptor)?.options?.map((option) => [option.value, option.name] as const) ?? [];
        }) : []);
        const effortOptions = projection.reasoningEffortValues.map((value) => {
            const level = PROVIDER_REASONING_EFFORT_LEVELS_V1.find((candidate) => candidate === value);
            return {
                value,
                label: effortNames.get(value) ?? (level ? formatProviderReasoningEffortLevelLabel(level) : value),
            };
        });
        const effortLabel = (value: string) => effortOptions.find((option) => option.value === value)?.label ?? value;

        const toggleProtocol = (kind: TeamCredentialRequestProtocolKindV1) => {
            if (busy) return;
            setDraft((current) => {
                const selected = current.protocols ?? [];
                const next = selected.includes(kind)
                    ? selected.filter((candidate) => candidate !== kind)
                    : [...selected, kind];
                return { ...current, protocols: next.length === 0 ? null : next };
            });
        };

        return (
            <>
                {projection.storedPolicyUnsupported ? <ItemGroup description={t('teams.credentials.requestPolicy.catalogUnavailable')}>
                    <Item
                        testID={`${testIDPrefix}-stored-unsupported`}
                        title={t('teams.credentials.requestPolicy.title')}
                        detail={t('teams.credentials.requestPolicy.activeNote')}
                        showChevron={false}
                    />
                    <Item
                        testID={`${testIDPrefix}-clear`}
                        title={t('teams.credentials.requestPolicy.clear')}
                        destructive
                        disabled={busy}
                        onPress={clearStoredPolicy}
                        showChevron={false}
                    />
                </ItemGroup> : null}
                {protocolKinds.length > 0 ? (
                    <ItemGroup
                        title={t('teams.credentials.requestPolicy.protocolsLabel')}
                        description={draft.protocols === null
                            ? `${t('teams.credentials.requestPolicy.subtitle')} ${t('teams.credentials.requestPolicy.protocolsAny')}`
                            : t('teams.credentials.requestPolicy.subtitle')}
                    >
                        {protocolKinds.map((kind) => (
                            <Item
                                key={kind}
                                testID={`${testIDPrefix}-protocol:${kind}`}
                                title={requestProtocolKindLabel(kind)}
                                accessibilityRole="checkbox"
                                selected={draft.protocols?.includes(kind) === true}
                                disabled={busy}
                                onPress={() => toggleProtocol(kind)}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                ) : null}

                {modelOptions.length > 0 ? <ItemGroup>
                    <OptionPickerOverlay
                        title={t('teams.credentials.requestPolicy.modelsLabel')}
                        effectiveLabel={draft.allowedModelIds === null
                            ? t('teams.credentials.requestPolicy.modelsAny')
                            : t('teams.credentials.requestPolicy.modelsAllowed', { count: draft.allowedModelIds.length })}
                        options={[
                            { value: '__any__', label: t('teams.credentials.requestPolicy.modelsAny') },
                            ...modelOptions,
                            ...storedModelOptions,
                        ]}
                        selectedValue={draft.allowedModelIds?.[0] ?? '__any__'}
                        selectedValues={draft.allowedModelIds ?? ['__any__']}
                        emptyText={t('settingsProviders.models.empty')}
                        optionTestIDPrefix={`${testIDPrefix}-model`}
                        canEnterCustomValue={false}
                        onSelect={(modelId) => {
                            if (busy) return;
                            setDraft((current) => {
                                if (modelId === '__any__') return { ...current, allowedModelIds: null };
                                const selected = current.allowedModelIds ?? [];
                                const next = selected.includes(modelId)
                                    ? selected.filter((value) => value !== modelId)
                                    : [...selected, modelId];
                                return { ...current, allowedModelIds: next.length > 0 ? next : null };
                            });
                        }}
                    />
                </ItemGroup> : null}

                {effortOptions.length > 0 ? (
                    <>
                        <ItemGroup>
                            <OptionPickerOverlay
                                title={t('teams.credentials.requestPolicy.effortLabel')}
                                effectiveLabel={draft.reasoningEffort === null
                                    ? t('teams.credentials.requestPolicy.effortAny')
                                    : draft.reasoningEffort.allowedValues.map(effortLabel).join(' · ')}
                                options={[
                                    { value: '__any__', label: t('teams.credentials.requestPolicy.effortAny') },
                                    ...effortOptions,
                                ]}
                                selectedValue={draft.reasoningEffort?.allowedValues[0] ?? '__any__'}
                                selectedValues={draft.reasoningEffort?.allowedValues ?? ['__any__']}
                                emptyText={t('teams.credentials.requestPolicy.effortAny')}
                                optionTestIDPrefix={`${testIDPrefix}-effort`}
                                canEnterCustomValue={false}
                                onSelect={(effort) => {
                                    if (busy) return;
                                    setDraft((current) => {
                                        if (effort === '__any__') return { ...current, reasoningEffort: null };
                                        const selected = current.reasoningEffort?.allowedValues ?? [];
                                        const allowedValues = selected.includes(effort)
                                            ? selected.filter((value) => value !== effort)
                                            : [...selected, effort];
                                        if (allowedValues.length === 0) return { ...current, reasoningEffort: null };
                                        return {
                                            ...current,
                                            reasoningEffort: {
                                                allowedValues,
                                                defaultValue: allowedValues.includes(current.reasoningEffort?.defaultValue ?? '')
                                                    ? current.reasoningEffort!.defaultValue
                                                    : allowedValues[0]!,
                                            },
                                        };
                                    });
                                }}
                            />
                        </ItemGroup>
                        {draft.reasoningEffort !== null ? (
                            <ItemGroup>
                                <OptionPickerOverlay
                                    title={t('teams.credentials.requestPolicy.effortLabel')}
                                    effectiveLabel={effortLabel(draft.reasoningEffort.defaultValue)}
                                    options={effortOptions.filter((option) => draft.reasoningEffort?.allowedValues.includes(option.value))}
                                    selectedValue={draft.reasoningEffort.defaultValue}
                                    emptyText={t('teams.credentials.requestPolicy.effortAny')}
                                    optionTestIDPrefix={`${testIDPrefix}-effort-default`}
                                    canEnterCustomValue={false}
                                    onSelect={(defaultValue) => {
                                        if (busy) return;
                                        setDraft((current) => current.reasoningEffort
                                            ? { ...current, reasoningEffort: { ...current.reasoningEffort, defaultValue } }
                                            : current);
                                    }}
                                />
                            </ItemGroup>
                        ) : null}
                    </>
                ) : null}
            </>
        );
    },
);
