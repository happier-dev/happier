import {
    serializeModelVisibilityRefV1,
    type ProviderBoundModelRef,
    type ProviderSettingsV1,
} from '@happier-dev/protocol';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';

import type { OptionPickerOption, OptionPickerSection } from '@/components/sessions/pickers/OptionPickerOverlay';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { presentProviderModelRow } from '@/providers/models/presentProviderModelRow';
import { t } from '@/text';
import { sessionModelSelectionKey, type SessionModelPickerValue } from './sessionModelSelectionKey';

export type SessionModelProjectionGroup = Extract<
    DaemonProviderModelProjectionResponseV1,
    { status: 'success' }
>['groups'][number];

export type SessionNativeModelOption = Readonly<{
    value: string;
    label: string;
    description?: string;
}>;

export type SessionModelSelectedTriggerPresentation = Readonly<{
    subtitle: string;
    detail?: string;
    accessibilityLabel?: string;
}>;

export function hiddenModelVisibilityKeys(
    settings: Pick<ProviderSettingsV1, 'modelVisibilityByRef'>,
    options: Readonly<{ providersFeatureEnabled: boolean }>,
): ReadonlySet<string> {
    if (options?.providersFeatureEnabled !== true) return new Set();
    return new Set(Object.keys(settings.modelVisibilityByRef));
}

export function sessionModelConnectionTitle(group: SessionModelProjectionGroup): string {
    return group.connectionRole === 'default' && group.connectionDisplayNameMode === 'automatic'
        ? group.providerName
        : `${group.providerName} · ${group.connectionName}`;
}

function nativeModelRef(agentTargetKey: string, modelId: string): ProviderBoundModelRef | null {
    return modelId === 'default'
        ? null
        : { agentTargetKey, providerConnectionId: null, modelId };
}

export function buildSessionModelPickerSections(input: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    hiddenNativeModelKeys: ReadonlySet<string>;
    canConfirmExperimental?: boolean;
    providerProjectionAuthoritative: boolean;
    selected?: SessionModelPickerValue;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
}>): readonly OptionPickerSection<SessionModelPickerValue>[] {
    const shouldShowDescriptions = input.nativeModels.some((model) => (
        model.value !== 'default'
        && typeof model.description === 'string'
        && model.description.trim().length > 0
    ));
    const nativeModels = shouldShowDescriptions
        ? input.nativeModels.map((model) => (
            model.value === 'default' && !(model.description?.trim())
                ? { ...model, description: t('agentInput.model.configureInCli') }
                : model
        ))
        : input.nativeModels;
    const nativeOptions = nativeModels.flatMap((model): OptionPickerOption<SessionModelPickerValue>[] => {
        const value = nativeModelRef(input.agentTargetKey, model.value);
        const hidden = value !== null && input.hiddenNativeModelKeys.has(serializeModelVisibilityRefV1({
            scope: 'agent',
            agentTargetKey: input.agentTargetKey,
            providerConnectionId: null,
            modelId: value.modelId,
        }));
        if (hidden) {
            const isCurrentSelection = value !== null
                && input.selected !== undefined
                && sessionModelSelectionKey(value) === sessionModelSelectionKey(input.selected);
            if (!isCurrentSelection) return [];
            const presentation = presentProviderModelRow({
                modelId: value.modelId,
                name: model.label,
                description: model.description,
                visibility: 'hidden_current_selection',
            });
            return [{
                value,
                label: presentation.label,
                description: presentation.description,
                disabled: true,
            }];
        }
        return [{ value, label: model.label, description: model.description }];
    });

    const providerSections = input.providerGroups.flatMap((group): OptionPickerSection<SessionModelPickerValue>[] => {
        const options = group.rows.flatMap((row): OptionPickerOption<SessionModelPickerValue>[] => {
            const hiddenCurrentSelection = row.visibility === 'hidden_current_selection';
            if (row.visibility !== 'visible' && !hiddenCurrentSelection) return [];
            const presentation = presentProviderModelRow({
                modelId: row.ref.modelId,
                name: row.descriptor.name,
                description: row.descriptor.description,
                authorization: group.authorization,
                compatibility: row.compatibility,
                canConfirmExperimental: input.canConfirmExperimental,
                endpointHealth: row.endpointHealth,
                stale: row.catalog.stale,
                loadState: row.loadState,
                visibility: hiddenCurrentSelection ? 'hidden_current_selection' : 'visible',
            });
            return [{
                value: row.ref,
                label: presentation.label,
                description: presentation.description,
                disabled: presentation.selectionDisabled
                    || (
                        group.modelLoadPreflightPolicy === 'required'
                        && row.loadState === 'unloaded'
                    ),
                accessibilityLabel: `${group.providerName}, ${group.connectionName}, ${presentation.label}`,
            }];
        });
        return options.length > 0
            ? [{ id: `connection:${group.connectionId}`, title: sessionModelConnectionTitle(group), options }]
            : [];
    });

    const sections: OptionPickerSection<SessionModelPickerValue>[] = [
        ...(nativeOptions.length > 0
            ? [{ id: 'native', title: t('settingsProviders.models.builtIn'), options: nativeOptions }]
            : []),
        ...providerSections,
    ];
    const selectedProviderProjectionAuthoritative = input.selected?.providerConnectionId == null
        || input.providerProjectionAuthoritative;
    if (input.selected && selectedProviderProjectionAuthoritative && !sections.some((section) => section.options.some((option) => (
        sessionModelSelectionKey(option.value) === sessionModelSelectionKey(input.selected ?? null)
    )))) {
        const recovery = input.currentSelectionRecovery
            && sessionModelSelectionKey(input.currentSelectionRecovery.ref) === sessionModelSelectionKey(input.selected)
            ? input.currentSelectionRecovery
            : null;
        const label = recovery?.displaySnapshot?.modelName ?? input.selected.modelId;
        const accessibilityLabel = recovery?.displaySnapshot
            ? [
                recovery.displaySnapshot.providerName,
                recovery.displaySnapshot.connectionName,
                label,
            ].filter((value): value is string => Boolean(value)).join(', ')
            : undefined;
        sections.unshift({
            id: 'current-selection-recovery',
            title: '',
            options: [{
                value: input.selected,
                label,
                description: recovery
                    ? t(presentProviderError(recovery.error).descriptionKey)
                    : t('settingsProviders.detail.deletedDescription'),
                ...(accessibilityLabel ? { accessibilityLabel } : {}),
                disabled: true,
            }],
        });
    }
    return sections;
}

/**
 * Reuses the canonical picker row presentation for a closed selection trigger
 * without eagerly presenting every row in a potentially large model catalog.
 */
export function buildSessionModelSelectedTriggerPresentation(input: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    hiddenNativeModelKeys: ReadonlySet<string>;
    providerProjectionAuthoritative: boolean;
    selected: SessionModelPickerValue;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    fallbackLabel: string;
    fieldLabel: string;
}>): SessionModelSelectedTriggerPresentation {
    const selected = input.selected;
    if (selected === null) {
        return { subtitle: input.fallbackLabel };
    }

    const selectedKey = sessionModelSelectionKey(selected);
    const nativeModels = selected.providerConnectionId === null
        ? input.nativeModels.filter((model) => (
            sessionModelSelectionKey(nativeModelRef(input.agentTargetKey, model.value)) === selectedKey
        ))
        : [];
    const providerGroups = selected.providerConnectionId === null
        ? []
        : input.providerGroups.flatMap((group): SessionModelProjectionGroup[] => {
            if (group.connectionId !== selected.providerConnectionId) return [];
            const rows = group.rows.filter((row) => sessionModelSelectionKey(row.ref) === selectedKey);
            return rows.length > 0 ? [{ ...group, rows }] : [];
        });
    const sections = buildSessionModelPickerSections({
        agentTargetKey: input.agentTargetKey,
        nativeModels,
        providerGroups,
        hiddenNativeModelKeys: input.hiddenNativeModelKeys,
        providerProjectionAuthoritative: input.providerProjectionAuthoritative,
        selected,
        currentSelectionRecovery: input.currentSelectionRecovery,
    });
    const selectedSection = sections.find((section) => section.options.some((option) => (
        sessionModelSelectionKey(option.value) === selectedKey
    )));
    const selectedOption = selectedSection?.options.find((option) => (
        sessionModelSelectionKey(option.value) === selectedKey
    ));
    if (!selectedSection || !selectedOption) {
        return { subtitle: input.fallbackLabel };
    }
    if (selectedSection.id === 'native') {
        return { subtitle: selectedOption.label };
    }

    const detail = selectedSection.id === 'current-selection-recovery'
        ? selectedOption.description
        : selectedSection.title;
    const accessibilityLabel = selectedOption.accessibilityLabel
        ? buildActionRowAccessibilityLabel([
            input.fieldLabel,
            selectedOption.accessibilityLabel,
            ...(selectedSection.id === 'current-selection-recovery' && selectedOption.description
                ? [selectedOption.description]
                : []),
        ])
        : undefined;
    return {
        subtitle: selectedOption.label,
        ...(detail ? { detail } : {}),
        ...(accessibilityLabel ? { accessibilityLabel } : {}),
    };
}
