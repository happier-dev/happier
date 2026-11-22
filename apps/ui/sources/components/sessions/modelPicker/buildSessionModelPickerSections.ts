import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import { isNativeAutomaticModelSelectionInputV1, serializeModelVisibilityRefV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { isSessionModelRefSourceBound, readSessionModelRefProviderConnectionId } from '@happier-dev/protocol/providers/selection/v2';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';
import type { DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';
import type { TeamCredentialProviderModelSelectionV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

import type { OptionPickerOption, OptionPickerSection } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import { buildActionRowAccessibilityLabel } from '@/components/ui/lists/actionRowAccessibility';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { presentProviderModelRow, type ProviderModelSelectionPurpose } from '@/providers/models/presentProviderModelRow';
import { providerConnectionSourceLabel } from '@/providers/session/resolveSessionRoutePresentation';
import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { t } from '@/text';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import {
    teamCredentialRecoveryLabel,
    teamCredentialRecoveryPresentation,
} from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { buildTeamCredentialModelPickerSections, createTeamCredentialModelEligibility, teamCredentialDeliveryLabel, presentTeamCredentialPickerName, teamCredentialUnavailableReason } from './buildTeamCredentialModelPickerSections';
import {
    isTeamCredentialProviderModelPickerValue,
    sessionModelSelectionKey,
    type SessionModelPickerOptionValue,
    type SessionModelPickerValue,
} from './sessionModelSelectionKey';
import { resolveSessionModelPickerSourceState, type SessionModelPickerSourceState } from './selectSessionModelPickerSourceGroups';

export type SessionModelProjectionGroup = Extract<
    DaemonProviderModelProjectionResponseV1,
    { status: 'success' }
>['groups'][number];

/** Exact source identity owns controls and labels; native same-id rows never substitute. */
export function resolveSessionModelSourceDescriptor(input: Readonly<{
    selected: SessionModelPickerOptionValue;
    providerGroups: readonly SessionModelProjectionGroup[];
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
}>): ProviderModelDescriptorV1 | null {
    const selected = input.selected;
    if (!selected) return null;
    const key = sessionModelSelectionKey(selected);
    if (isTeamCredentialProviderModelPickerValue(selected)) {
        return input.teamCredentialResources?.find(resource => resource.teamId === selected.teamId
            && resource.id === selected.resourceId
            && resource.resourceRevision === selected.expectedResourceRevision)
            ?.providerModels.find(row => sessionModelSelectionKey(row.selection) === key)?.descriptor ?? null;
    }
    return findSessionModelProjectionRow(input.providerGroups, key)?.descriptor ?? null;
}

export function findSessionModelProjectionRow(groups: readonly SessionModelProjectionGroup[], key: string) {
    for (const group of groups) {
        const row = group.rows.find(row => sessionModelSelectionKey(row.ref) === key);
        if (row) return row;
    }
    return null;
}

/** One configured vendor slot a Gateway model is served through; display facts, never credential authority. */
export type SessionModelGatewaySlot = NonNullable<SessionModelProjectionGroup['rows'][number]['gatewaySlots']>[number];

const gatewaySlotSectionIdPrefix = (connectionId: string) => `connection:${connectionId}:slot:`;

/** A section that names a vendor slot, so its heading says something the scope bar does not. */
export function isSessionModelGatewaySlotSection(section: Pick<SessionModelPickerSection, 'id'>): boolean {
    return section.id.startsWith('connection:') && section.id.includes(':slot:');
}

export type SessionNativeModelOption = Readonly<{
    value: string;
    label: string;
    description?: string;
    upstreamRef?: ProviderModelDescriptorV1['upstreamRef'];
    /** The options this model declares (its effort tiers), so its card can offer them before it is chosen. */
    modelOptions?: readonly AcpConfigOption[];
}>;

/**
 * Where a picker row's model comes from; the picker shows it only where a name alone is ambiguous.
 * `inDescription` marks a row whose own description already names the source (a Team model), so the
 * title never repeats it.
 */
export type SessionModelPickerOptionSource = Readonly<{ label: string; native: boolean; inDescription?: boolean }>;
export type SessionModelPickerOption = OptionPickerOption<SessionModelPickerOptionValue> & Readonly<{
    source?: SessionModelPickerOptionSource;
    upstreamRef?: ProviderModelDescriptorV1['upstreamRef'];
    sourceState?: SessionModelPickerSourceState;
    /** Recovery can be clickable while the model remains unavailable for selection. */
    availability?: 'available' | 'unavailable';
    unavailableReason?: string | null;
}>;
export type SessionModelPickerSection = Omit<OptionPickerSection<SessionModelPickerOptionValue>, 'options'> & Readonly<{
    options: ReadonlyArray<SessionModelPickerOption>;
}>;

/**
 * Design A labels: a model name that appears under more than one source carries "· via <source>" after its
 * name. A Favorites row (whose heading names no source) says "via <source>" on its description line instead,
 * as the lab draws it, so its title can name its saved Thinking. The chosen row says neither: its Runs-through
 * row names the source right under it (PICKER-ACCEPT-1120). Everything else is already named by its section
 * heading or its own description, so it stays plain. Equal names are never merged.
 */
export function withSessionModelSourceSuffixes(
    sections: ReadonlyArray<SessionModelPickerSection>,
    favoritesSectionId: string,
    selectedKey?: string,
): ReadonlyArray<SessionModelPickerSection> {
    const sourcesByName = new Map<string, Set<string>>();
    for (const section of sections) {
        for (const option of section.options) {
            if (!option.source) continue;
            const name = option.label.trim().toLowerCase();
            const sources = sourcesByName.get(name) ?? new Set<string>();
            sources.add(option.source.label);
            sourcesByName.set(name, sources);
        }
    }
    return sections.map((section) => {
        let changed = false;
        const options = section.options.map((option) => {
            if (!option.source || option.source.inDescription) return option;
            const ambiguous = (sourcesByName.get(option.label.trim().toLowerCase())?.size ?? 0) > 1;
            const favorite = section.id === favoritesSectionId;
            if (!ambiguous && !(favorite && !option.source.native)) return option;
            if (selectedKey !== undefined && option.value !== null && sessionModelSelectionKey(option.value) === selectedKey) return option;
            changed = true;
            if (favorite) {
                const via = t('agentInput.model.viaSourceFact', { source: option.source.label });
                return { ...option, description: joinHappierFacts(via, option.description) || via,
                    source: { ...option.source, inDescription: true } };
            }
            return { ...option, labelSuffix: t('agentInput.model.viaSource', { source: option.source.label }) };
        });
        return changed ? { ...section, options } : section;
    });
}

export { selectSessionModelPickerSourceGroups, type SessionModelPickerSourceGroup } from './selectSessionModelPickerSourceGroups';

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
    return providerConnectionSourceLabel(group);
}

function nativeModelRef(agentTargetKey: string, modelId: string): ProviderBoundModelRef | null {
    return isNativeAutomaticModelSelectionInputV1({ modelId })
        ? null
        : { agentTargetKey, providerConnectionId: null, modelId };
}

export function buildSessionModelPickerSections(input: Readonly<{
    purpose?: ProviderModelSelectionPurpose;
    agentTargetKey: string;
    declarationContext: ProviderDeclarationContext;
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
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    selectedTeamCredentialModel?: SessionModelPickerOptionValue;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    /** The Agent's own source (its signed-in account or pool); headings fall back to "Built-in". */
    nativeSourceLabel?: string | null;
    /**
     * Default `true`: a selection the list cannot show gets a recovery row. Browsing one source shows
     * only that source, so a selection elsewhere is simply not in view, not missing.
     */
    recoverMissingSelection?: boolean;
    /**
     * Browsing one Gateway: names the subscription behind a vendor slot ("ChatGPT · Codex pool") so its
     * models group under it, in the order the producer lists them. A model served through several slots
     * sits under the first one it can name; a model with no nameable slot stays under the source.
     */
    gatewaySlotTitle?: (slot: SessionModelGatewaySlot) => string | null;
}>): readonly SessionModelPickerSection[] {
    const nativeSource = { label: input.nativeSourceLabel || t('settingsProviders.models.builtIn'), native: true };
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
    const projectedModelKeys = new Set(input.providerGroups.flatMap(group =>
        group.rows.map(row => sessionModelSelectionKey(row.ref))));
    const nativeOptions = nativeModels.flatMap((model): SessionModelPickerOption[] => {
        const value = nativeModelRef(input.agentTargetKey, model.value);
        if (value !== null && projectedModelKeys.has(sessionModelSelectionKey(value))) return [];
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
                searchText: model.value,
                description: presentation.description,
                disabled: true,
                source: nativeSource,
                upstreamRef: model.upstreamRef,
                sourceState: 'ready',
                availability: 'unavailable',
                unavailableReason: presentation.primaryStatus?.label ?? t('agentInput.model.unavailable'),
            }];
        }
        // The Agent's own description can be a disclosure ("Your content … may be used for product
        // improvement"), so it is read in full rather than cut mid-sentence.
        return [{ value, label: model.label, searchText: model.value, description: model.description, source: nativeSource,
            ...(model.description ? { descriptionLines: 0 } : {}),
            upstreamRef: model.upstreamRef,
            availability: 'available', unavailableReason: null }];
    });

    const providerSections = input.providerGroups.flatMap((group): SessionModelPickerSection[] => {
        const source = { label: sessionModelConnectionTitle(group), native: false };
        const entries = group.rows.flatMap((row): { row: typeof row; option: SessionModelPickerOption }[] => {
            const hiddenCurrentSelection = row.visibility === 'hidden_current_selection';
            if (row.visibility !== 'visible' && !hiddenCurrentSelection) return [];
            const presentation = presentProviderModelRow({
                purpose: input.purpose,
                compactPicker: true,
                modelId: row.ref.modelId,
                name: row.descriptor.name,
                description: row.descriptor.description,
                authorization: group.authorization,
                compatibility: row.compatibility,
                canConfirmExperimental: input.canConfirmExperimental,
                endpointHealth: row.endpointHealth,
                stale: row.catalog.stale,
                loadState: row.loadState,
                modelLoadPreflightPolicy: group.modelLoadPreflightPolicy,
                visibility: hiddenCurrentSelection ? 'hidden_current_selection' : 'visible',
            });
            return [{ row, option: {
                value: row.ref,
                label: presentation.label,
                searchText: row.ref.modelId,
                description: presentation.description,
                descriptionLines: 2,
                source,
                upstreamRef: row.descriptor.upstreamRef,
                sourceState: resolveSessionModelPickerSourceState(group.authorization, row.endpointHealth),
                disabled: presentation.selectionDisabled,
                availability: presentation.selectionDisabled ? 'unavailable' : 'available',
                unavailableReason: presentation.selectionDisabled
                    ? presentation.primaryStatus?.label ?? t('agentInput.model.unavailable') : null,
                accessibilityLabel: `${source.label}, ${presentation.label}`,
            } }];
        });
        const bySlot = new Map<string, SessionModelPickerOption[]>();
        const unclassified: SessionModelPickerOption[] = [];
        for (const { row, option } of entries) {
            const slotTitle = input.gatewaySlotTitle
                ? row.gatewaySlots?.map(input.gatewaySlotTitle).find((title): title is string => Boolean(title))
                : undefined;
            if (!slotTitle) { unclassified.push(option); continue; }
            const grouped = bySlot.get(slotTitle);
            if (grouped) grouped.push(option); else bySlot.set(slotTitle, [option]);
        }
        const sections: SessionModelPickerSection[] = [...bySlot].map(([title, options]) => ({
            id: `${gatewaySlotSectionIdPrefix(group.connectionId)}${title}`, title, options,
        }));
        if (unclassified.length > 0) {
            sections.push({ id: `connection:${group.connectionId}`, title: source.label, options: unclassified });
        }
        return sections;
    });

    const teamModelEligible = createTeamCredentialModelEligibility(input);
    const teamSections = buildTeamCredentialModelPickerSections(input, teamModelEligible);

    const sections: SessionModelPickerSection[] = [
        ...(nativeOptions.length > 0
            ? [{ id: 'native', title: nativeSource.label, options: nativeOptions }]
            : []),
        ...providerSections,
        ...teamSections,
    ];
    const selectedValue = input.selectedTeamCredentialModel ?? input.selected;
    const selectedProviderProjectionAuthoritative = selectedValue == null
        || isTeamCredentialProviderModelPickerValue(selectedValue)
        || !isSessionModelRefSourceBound(selectedValue)
        || input.providerProjectionAuthoritative;
    if (selectedValue && selectedProviderProjectionAuthoritative && input.recoverMissingSelection !== false
        && !sections.some((section) => section.options.some((option) => (
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
        const retainedTeamModelEligible = teamModelEligible(teamModel);
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
            ? teamCredentialUnavailableReason(teamResource,
                isTeamCredentialProviderModelPickerValue(selectedValue) ? selectedValue.deliveryMode : undefined,
            ) ?? t('teams.credentials.detail.notFound')
            : null;
        const accessibilityLabel = recovery?.displaySnapshot
            ? [
                recovery.displaySnapshot.providerName,
                recovery.displaySnapshot.connectionName,
                label,
            ].filter((value): value is string => Boolean(value)).join(', ')
            : teamResource
                ? [teamName, homeName, presentTeamCredentialPickerName(teamResource, input.teamCredentialDisplayNames), label, teamDelivery, teamUnavailableReason, teamRecovery]
                    .filter((value): value is string => Boolean(value)).join(', ')
                : undefined;
        const teamDescription = teamResource
            ? [presentTeamCredentialPickerName(teamResource, input.teamCredentialDisplayNames), teamName, homeName, teamDelivery, teamUnavailableReason, teamRecovery]
                .filter((value): value is string => Boolean(value)).join(' · ')
            : null;
        sections.unshift({
            id: 'current-selection-recovery',
            title: '',
            options: [{
                value: selectedValue,
                label,
                searchText: selectedValue.modelId,
                description: recovery
                    ? t(presentProviderError(recovery.error).descriptionKey)
                    : isTeamCredentialProviderModelPickerValue(selectedValue)
                        ? teamDescription ?? t('teams.credentials.detail.notFound')
                        : !isSessionModelRefSourceBound(selectedValue)
                            ? t('common.unavailable')
                            : t('settingsProviders.detail.deletedDescription'),
                ...(accessibilityLabel ? { accessibilityLabel } : {}),
                disabled: !(teamResource && retainedTeamModelEligible && input.onRecoverTeamCredentialResource),
                availability: 'unavailable',
                unavailableReason: recovery ? t(presentProviderError(recovery.error).titleKey)
                    : teamResource ? teamCredentialUnavailableReason(teamResource,
                        isTeamCredentialProviderModelPickerValue(selectedValue) ? selectedValue.deliveryMode : undefined, true)
                        ?? t('agentInput.model.unavailable')
                        : !isTeamCredentialProviderModelPickerValue(selectedValue) && !isSessionModelRefSourceBound(selectedValue)
                            ? t('common.unavailable') : t('agentInput.model.unavailable'),
                ...(teamResource && retainedTeamModelEligible && input.onRecoverTeamCredentialResource
                    ? { onActivate: () => input.onRecoverTeamCredentialResource?.(teamResource) }
                    : {}),
            }],
        });
    }
    const unavailable = (option: SessionModelPickerOption) => option.availability === 'unavailable';
    return sections.map(section => ({ ...section,
        options: [...section.options].sort((left, right) => Number(unavailable(left)) - Number(unavailable(right))),
    })).sort((left, right) => Number(left.options.every(unavailable)) - Number(right.options.every(unavailable)));
}

/**
 * Reuses the canonical picker row presentation for a closed selection trigger
 * without eagerly presenting every row in a potentially large model catalog.
 */
export function buildSessionModelSelectedTriggerPresentation(input: Readonly<{
    agentTargetKey: string;
    declarationContext: ProviderDeclarationContext;
    nativeModels: readonly SessionNativeModelOption[];
    providerGroups: readonly SessionModelProjectionGroup[];
    hiddenNativeModelKeys: ReadonlySet<string>;
    providerProjectionAuthoritative: boolean;
    /** The projection's read failed, rather than not having answered yet. */
    providerProjectionFailed?: boolean;
    selected: SessionModelPickerValue;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamNameById?: Readonly<Record<string, string>>;
    homeNameByTeamId?: Readonly<Record<string, string>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    fallbackLabel: string;
    fieldLabel: string;
}>): SessionModelSelectedTriggerPresentation {
    const selected = input.selectedTeamCredentialModel ?? input.selected;
    if (selected === null) {
        return { subtitle: input.fallbackLabel };
    }

    const selectedKey = sessionModelSelectionKey(selected);
    const teamSelection = isTeamCredentialProviderModelPickerValue(selected) ? selected : null;
    const providerSelection = isTeamCredentialProviderModelPickerValue(selected) ? null : selected;
    const nativeModels = providerSelection && !isSessionModelRefSourceBound(providerSelection)
        ? input.nativeModels.filter((model) => (
            sessionModelSelectionKey(nativeModelRef(input.agentTargetKey, model.value)) === selectedKey
        ))
        : [];
    const providerGroups = providerSelection
        ? input.providerGroups.flatMap((group): SessionModelProjectionGroup[] => {
            const connectionId = readSessionModelRefProviderConnectionId(providerSelection);
            if (connectionId && group.connectionId !== connectionId) return [];
            const rows = group.rows.filter((row) => sessionModelSelectionKey(row.ref) === selectedKey);
            return rows.length > 0 ? [{ ...group, rows }] : [];
        }) : [];
    const sections = buildSessionModelPickerSections({
        agentTargetKey: input.agentTargetKey,
        declarationContext: input.declarationContext,
        nativeModels,
        providerGroups,
        hiddenNativeModelKeys: input.hiddenNativeModelKeys,
        providerProjectionAuthoritative: input.providerProjectionAuthoritative,
        selected: providerSelection,
        selectedTeamCredentialModel: teamSelection,
        teamCredentialResources: teamSelection ? input.teamCredentialResources?.filter(resource => resource.id === teamSelection.resourceId
            && resource.teamId === teamSelection.teamId).map(resource => ({ ...resource,
                providerModels: resource.providerModels.filter(model => sessionModelSelectionKey(model.selection) === selectedKey) })) : [],
        teamCredentialDisplayNames: input.teamCredentialDisplayNames,
        teamNameById: input.teamNameById,
        homeNameByTeamId: input.homeNameByTeamId,
        teamCredentialResourceStatusByKey: input.teamCredentialResourceStatusByKey,
        currentSelectionRecovery: input.currentSelectionRecovery,
    });
    const selectedSection = sections.find((section) => section.options.some((option) => (
        sessionModelSelectionKey(option.value) === selectedKey
    )));
    const selectedOption = selectedSection?.options.find((option) => (
        sessionModelSelectionKey(option.value) === selectedKey
    ));
    if (!selectedSection || !selectedOption) {
        // Provider discovery is demanded by the open picker. Until it has an
        // authoritative row, the saved exact id still names the selection;
        // absence of a demanded projection is not a failed machine catalog.
        return { subtitle: providerSelection && isSessionModelRefSourceBound(providerSelection) && !input.providerProjectionAuthoritative
            ? selected.modelId
            : input.fallbackLabel };
    }
    if (selectedSection.id === 'native') {
        return { subtitle: selectedOption.label };
    }

    const detail = selectedSection.id === 'current-selection-recovery'
        ? selectedOption.description
        : teamSelection ? selectedOption.description : selectedSection.title;
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
        subtitle: selectedSection.id === 'current-selection-recovery' && selectedOption.label === selected.modelId
            ? providerSelection && !isSessionModelRefSourceBound(providerSelection)
                ? t('common.unavailable') : input.fallbackLabel
            : selectedOption.label,
        ...(detail ? { detail } : {}),
        ...(accessibilityLabel ? { accessibilityLabel } : {}),
    };
}
