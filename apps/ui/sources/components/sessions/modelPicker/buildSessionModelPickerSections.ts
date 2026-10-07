import { serializeModelVisibilityRefV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';
import type { TeamCredentialProviderModelSelectionV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import type { OptionPickerOption, OptionPickerSection } from '@/components/sessions/pickers/OptionPickerOverlay';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { presentProviderModelRow } from '@/providers/models/presentProviderModelRow';
import { t } from '@/text';
import {
    formatLimitResetUtc,
    limitMetricLabel,
    teamCredentialRecoveryLabel,
    teamCredentialRecoveryPresentation,
} from '@/components/settings/teams/credentials/teamCredentialPresentation';
import {
    isTeamCredentialProviderModelPickerValue,
    sessionModelSelectionKey,
    type SessionModelPickerOptionValue,
    type SessionModelPickerValue,
} from './sessionModelSelectionKey';

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

function teamCredentialDeliveryLabel(deliveryMode: TeamCredentialProviderModelSelectionV1['deliveryMode']): string {
    switch (deliveryMode) {
        case 'brokered': return t('teams.credentials.delivery.brokered');
        case 'direct': return t('teams.credentials.delivery.direct');
    }
}

function teamCredentialUnavailableReason(resource: TeamCredentialResourceCatalogEntryV1): string | null {
    switch (resource.readiness.kind) {
        case 'available': return null;
        case 'broker_unavailable': return t('teams.credentials.errors.brokerUnavailable');
        case 'source_unavailable': return t('teams.credentials.errors.sourceMissing');
        case 'update_required': return t('teams.unavailable.updateRequired');
        case 'policy_denied': return t('teams.credentials.forbidden');
        // The Home already resolved which allowance closed and when it reopens;
        // the picker is where the member decides what to do about it.
        case 'limit_reached': return [
            t('teams.credentials.limits.reached'),
            limitMetricLabel(resource.readiness.metric),
            formatLimitResetUtc(resource.readiness.resetsAtUtc),
        ].filter((part): part is string => Boolean(part)).join(' · ');
        case 'resource_corrupt':
        case 'resource_unavailable':
            return t('teams.credentials.detail.notFound');
    }
}

function teamCredentialModelUnavailableReason(
    resource: TeamCredentialResourceCatalogEntryV1,
    availability: TeamCredentialResourceCatalogEntryV1['providerModels'][number]['availability'],
): string | null {
    switch (availability) {
        case 'available': return teamCredentialUnavailableReason(resource);
        case 'source_owner_required': return t('teams.credentials.errors.sourceOwnerRequired');
        case 'resource_corrupt': return t('teams.credentials.detail.notFound');
        case 'policy_denied': return t('teams.credentials.forbidden');
    }
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
    /**
     * Default `true`. `false` removes the automatic/default native option, which maps to no model ref
     * and so cannot be hidden by the visibility keys (an embed that restricts models, plan 04 §4.6).
     */
    allowAutomatic?: boolean;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    currentTeamCredentialResourceKeys?: ReadonlySet<string>;
    selectedTeamCredentialModel?: SessionModelPickerOptionValue;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
}>): readonly OptionPickerSection<SessionModelPickerOptionValue>[] {
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
        if (value === null && input.allowAutomatic === false) return [];
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

    const teamSections = (input.teamCredentialResources ?? []).flatMap((resource): OptionPickerSection<SessionModelPickerOptionValue>[] => {
        const options = resource.providerModels.flatMap((row): OptionPickerOption<SessionModelPickerOptionValue>[] => {
            if (row.selection.agentTargetKey !== input.agentTargetKey) return [];
            const current = input.currentTeamCredentialResourceKeys?.has(`${resource.teamId}:${resource.id}`) ?? true;
            const available = current && resource.readiness.kind === 'available'
                && row.availability === 'available';
            const delivery = teamCredentialDeliveryLabel(row.selection.deliveryMode);
            const unavailableReason = current
                ? teamCredentialModelUnavailableReason(resource, row.availability)
                : t('teams.unavailable.offline');
            // The Home's typed recovery travels with the disabled row: the
            // picker itself has no settings surface to open, so the recovery is
            // the row's description and accessible name rather than a control.
            const recoveryPresentation = available
                ? null
                : teamCredentialRecoveryPresentation(
                    resource.recoveryAction,
                    // The catalog projection carries no custodian identity, and
                    // repair authority is re-decided by the resource Settings a
                    // recovery destination would open.
                    { isSourceCustodian: false },
                );
            const recovery = recoveryPresentation === null
                ? null
                : teamCredentialRecoveryLabel(recoveryPresentation);
            return [{
                value: row.selection,
                label: row.descriptor.name || row.selection.modelId,
                description: [resource.displayName, delivery, unavailableReason, recovery]
                    .filter((value): value is string => Boolean(value))
                    .join(' · '),
                disabled: !available && !input.onRecoverTeamCredentialResource,
                ...(!available && input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(resource) }
                    : {}),
                accessibilityLabel: [
                    input.teamNameById?.[resource.teamId] ?? t('teams.title'),
                    input.homeNameByTeamId?.[resource.teamId],
                    resource.displayName,
                    row.descriptor.name || row.selection.modelId,
                    delivery,
                    available ? undefined : unavailableReason,
                    available ? undefined : recovery,
                ].filter((value): value is string => Boolean(value)).join(', '),
            }];
        });
        if (options.length === 0) return [];
        const teamName = input.teamNameById?.[resource.teamId] ?? t('teams.title');
        const homeName = input.homeNameByTeamId?.[resource.teamId];
        return [{
            id: `team-resource:${resource.teamId}:${resource.id}`,
            title: `${t('teams.credentials.title')} · ${teamName}${homeName ? ` · ${homeName}` : ''}`,
            options,
        }];
    });

    const sections: OptionPickerSection<SessionModelPickerOptionValue>[] = [
        ...(nativeOptions.length > 0
            ? [{ id: 'native', title: t('settingsProviders.models.builtIn'), options: nativeOptions }]
            : []),
        ...providerSections,
        ...teamSections,
    ];
    const selectedValue = input.selectedTeamCredentialModel ?? input.selected;
    const selectedProviderProjectionAuthoritative = selectedValue == null
        || isTeamCredentialProviderModelPickerValue(selectedValue)
        || selectedValue.providerConnectionId == null
        || input.providerProjectionAuthoritative;
    if (selectedValue && selectedProviderProjectionAuthoritative && !sections.some((section) => section.options.some((option) => (
        sessionModelSelectionKey(option.value) === sessionModelSelectionKey(selectedValue)
    )))) {
        const recovery = !isTeamCredentialProviderModelPickerValue(selectedValue) && input.currentSelectionRecovery
            && sessionModelSelectionKey(input.currentSelectionRecovery.ref) === sessionModelSelectionKey(selectedValue)
            ? input.currentSelectionRecovery
            : null;
        const teamResource = isTeamCredentialProviderModelPickerValue(selectedValue)
            ? input.teamCredentialResources?.find((resource) => (
                resource.id === selectedValue.resourceId
                && resource.teamId === selectedValue.teamId
            )) ?? null
            : null;
        const teamModel = teamResource?.providerModels.find((row) => (
            row.selection.agentTargetKey === selectedValue.agentTargetKey
            && row.selection.modelId === selectedValue.modelId
        )) ?? null;
        const label = recovery?.displaySnapshot?.modelName
            ?? teamModel?.descriptor.name
            ?? selectedValue.modelId;
        const teamName = teamResource
            ? input.teamNameById?.[teamResource.teamId] ?? t('teams.title')
            : null;
        const homeName = teamResource ? input.homeNameByTeamId?.[teamResource.teamId] : null;
        const teamDelivery = isTeamCredentialProviderModelPickerValue(selectedValue)
            ? teamCredentialDeliveryLabel(selectedValue.deliveryMode)
            : null;
        const teamRecoveryPresentation = teamResource
            ? teamCredentialRecoveryPresentation(teamResource.recoveryAction, { isSourceCustodian: false })
            : null;
        const teamRecovery = teamRecoveryPresentation
            ? teamCredentialRecoveryLabel(teamRecoveryPresentation)
            : null;
        const teamUnavailableReason = teamResource
            ? teamCredentialUnavailableReason(teamResource) ?? t('teams.credentials.detail.notFound')
            : null;
        const accessibilityLabel = recovery?.displaySnapshot
            ? [
                recovery.displaySnapshot.providerName,
                recovery.displaySnapshot.connectionName,
                label,
            ].filter((value): value is string => Boolean(value)).join(', ')
            : teamResource
                ? [teamName, homeName, teamResource.displayName, label, teamDelivery, teamUnavailableReason, teamRecovery]
                    .filter((value): value is string => Boolean(value)).join(', ')
                : undefined;
        const teamDescription = teamResource
            ? [teamResource.displayName, teamName, homeName, teamDelivery, teamUnavailableReason, teamRecovery]
                .filter((value): value is string => Boolean(value)).join(' · ')
            : null;
        sections.unshift({
            id: 'current-selection-recovery',
            title: '',
            options: [{
                value: selectedValue,
                label,
                description: recovery
                    ? t(presentProviderError(recovery.error).descriptionKey)
                    : isTeamCredentialProviderModelPickerValue(selectedValue)
                        ? teamDescription ?? t('teams.credentials.detail.notFound')
                        : t('settingsProviders.detail.deletedDescription'),
                ...(accessibilityLabel ? { accessibilityLabel } : {}),
                disabled: !(teamResource && input.onRecoverTeamCredentialResource),
                ...(teamResource && input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(teamResource) }
                    : {}),
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
