import { readAccountAgentBrokeredUse, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import type * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedServiceBindingSelectionV2, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialResourceCatalogEntryV1, TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';

import {
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    areTeamResourceConnectedServiceSelectionsEqual,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { teamCredentialRecoveryPresentation } from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { recoveryShortLabel, resourceShortUnavailableLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { presentConnectedAccountSignedOut } from '@/components/settings/connectedServices/account/connectedAccountCredentialStatusLabel';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { foldUnavailableRows } from '@/components/sessions/pickers/foldUnavailableRows';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility, type DirectDeliveryDisclosure, type DirectDeliveryDisclosureTranslationKey } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import type { TranslationParams } from '@/text';
import { derivePoolUsage, projectPoolUsage, type PoolMemberUsageInput, type PoolQuotaSnapshot, type PoolUsage, type PoolUsageFreshness } from '@/components/settings/connectedServices/pools/derivePoolUsage';
import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '@/components/settings/connectedServices/account/accountBlockFormatters';
import { formatResetCountdown } from '@/sync/domains/connectedServices/formatResetCountdown';
import { presentConnectedAccountName } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

export type ConnectedServicesSelectionOptionAvailability = Readonly<{
    disabled?: boolean;
    /** A session switch restriction does not make the underlying account unavailable. */
    availability?: 'available' | 'unavailable';
    subtitle?: string;
}>;

export type ConnectedServicesSelectionIconVariant = 'default' | 'warning';

/** What a row is, which its leading mark names whether or not it is the current choice. */
export type ConnectedServicesSelectionRowKind = 'native' | 'group' | 'account' | 'team';

export type ConnectedServicesSelectionListTranslationKey =
    | DirectDeliveryDisclosureTranslationKey
    | 'connectedServices.authModal.nativeAuthTitle'
    | 'connectedServices.authModal.nativeAuthSubtitle'
    | 'connectedServices.authModal.groupSubtitle'
    | 'connectedServices.detail.groups.activeMember'
    | 'connectedServices.authModal.notConnectedTitle'
    | 'connectedServices.authModal.notConnectedSubtitle'
    | 'connectedServices.title'
    | 'teams.credentials.delivery.brokered'
    | 'teams.credentials.delivery.direct'
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle'
    | 'common.unavailable';

/**
 * The exact slice of the canonical `t` contract this builder consumes: the keys
 * above, each with the params the canonical catalog declares for it. Deriving
 * the params from {@link TranslationParams} keeps one authority for "does this
 * key take arguments", so the app translator is assignable as-is and a
 * parameterised key such as `connectedServices.detail.groups.activeMember`
 * cannot be reached through a cast that hides its arguments.
 */
export type ConnectedServicesSelectionListTranslate = <K extends ConnectedServicesSelectionListTranslationKey>(
    key: K,
    ...params: TranslationParams<K> extends never ? [] : [params: TranslationParams<K>]
) => string;

export type NewSessionConnectedServicesSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
    /** Each row's availability and, when it can't be used as it is (signed out, an unusable Team resource), why. */
    optionAvailabilityById: ReadonlyMap<string, ConnectedServicesSelectionOptionAvailabilityFact>;
}>;

export type ConnectedServicesSelectionOptionAvailabilityFact = Readonly<{
    availability: 'available' | 'unavailable';
    unavailableReason: string | null;
}>;

export type BuildNewSessionConnectedServicesSelectionListModelParams = Readonly<{
    supportedServiceIds: ReadonlyArray<string>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    /** Unread inherited defaults are indeterminate, not an implicit Native selection. */
    bindingsKnown?: boolean;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    declarationContext?: ProviderDeclarationContext;
    /** Exact currentness projection from the Home catalog; stale rows stay visible but cannot be selected. */
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    teamNameById?: Readonly<Record<string, string>>;
    /** Where agents run on the selected target now; unknown keeps both warnings. */
    directDelivery?: DirectDeliveryDisclosure;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    /** Connected-account-only consumers can suppress the implicit local CLI auth fallback. */
    includeNativeAuthOption?: boolean;
    /** Runs through browses one native model source for the exact selected Agent. */
    nativeRoute?: Readonly<{ agentTargetKey: string; active: boolean; onBrowse?: () => void }>;
    /** The Team source the Session's applied route runs through; it follows the model selection, so the Session may carry no binding for it. */
    appliedTeamRoute?: Readonly<{ teamId: string; resourceId: string; deliveryMode: TeamCredentialRouteV1 }>;
    /** Exact-binding consumers can prevent stale selections from visually adopting a different default profile. */
    allowDefaultProfileFallback?: boolean;
    quotaSnapshotsByKey?: Readonly<Record<string, PoolQuotaSnapshot | null | undefined>>;
    quotaErrorsByKey?: Readonly<Record<string, string | null | undefined>>;
    renderPoolFreshness?: (freshness: PoolUsageFreshness, subtitle: string, serviceTitle: string) => React.ReactNode;
    setBindingForService: (serviceId: string, binding: ConnectedServiceBindingSelectionV2) => void;
    onOpenSettings: (serviceId: string, anchor?: PopoverAnchor) => void;
    translate: ConnectedServicesSelectionListTranslate;
    resolveServiceTitle: (serviceId: string) => string;
    renderRowIcon: (params: Readonly<{ kind: ConnectedServicesSelectionRowKind; variant?: ConnectedServicesSelectionIconVariant }>) => React.ReactNode;
    /** Trailing mark of a row that opens a source to browse instead of committing a choice. */
    renderBrowseMark: () => React.ReactNode;
    renderSettingsIcon: () => React.ReactNode;
    onReconnectProfile?: (serviceId: string, profileId: string, anchor?: PopoverAnchor) => void;
    resolveOptionAvailability?: (params: Readonly<{
        serviceId: string;
        optionId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => ConnectedServicesSelectionOptionAvailability;
}>;

export function createConnectedServiceOptionId(serviceId: string, profileId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:profile:${encodeURIComponent(profileId)}`;
}

export function createConnectedServiceGroupOptionId(serviceId: string, groupId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:group:${encodeURIComponent(groupId)}`;
}

export function createNativeServiceOptionId(serviceId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:native`;
}

export function createConnectServiceOptionId(serviceId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:connect`;
}

export function createReauthServiceOptionId(serviceId: string, profileId: string): string {
    return `connected-service:${encodeURIComponent(serviceId)}:reauth:${encodeURIComponent(profileId)}`;
}

export function createTeamResourceServiceOptionId(
    selection: TeamResourceConnectedServiceSelectionV2,
): string {
    const disclosedMember = selection.deliveryMode === 'direct' ? selection.disclosedMember : null;
    return `connected-service:team-resource:${encodeURIComponent(selection.resourceId)}:${selection.deliveryMode}:${disclosedMember
        ? `${encodeURIComponent(buildQualifiedPluginContributionKey(disclosedMember.service))}:${encodeURIComponent(disclosedMember.accountId)}`
        : 'brokered'}`;
}

function presentProfile(option: ConnectedServicesProfileOption, serviceTitle: string) {
    return presentConnectedAccountName({ serviceTitle, userLabel: option.label, email: option.providerEmail });
}

function resolveGroupSubtitle(params: Readonly<{
    serviceTitle: string;
    activeProfileId: string;
    profiles: ReadonlyArray<ConnectedServicesProfileOption>;
    translate: ConnectedServicesSelectionListTranslate;
}>): string {
    const activeProfile = params.profiles.find((option) => option.profileId.trim() === params.activeProfileId) ?? null;
    if (!activeProfile) return params.translate('connectedServices.authModal.groupSubtitle');

    return params.translate('connectedServices.detail.groups.activeMember', {
        profileId: presentProfile(activeProfile, params.serviceTitle).primaryLabel,
    });
}

function resolveServiceOptionAccessibilityLabel(params: Readonly<{
    serviceTitle: string;
    optionLabel: string;
}>): string | undefined {
    const serviceTitle = params.serviceTitle.trim();
    const optionLabel = params.optionLabel.trim();
    if (!serviceTitle || !optionLabel) return undefined;
    return `${serviceTitle} · ${optionLabel}`;
}

export function buildNewSessionConnectedServicesSelectionListModel(
    params: BuildNewSessionConnectedServicesSelectionListModelParams,
): NewSessionConnectedServicesSelectionListModel {
    // Native-only Agents have no broker application. Use the same declaration
    // authority as the Provider picker; personal and Direct material stay native.
    const brokeredSupported = !params.nativeRoute || readAccountAgentBrokeredUse(
        params.nativeRoute.agentTargetKey, params.declarationContext ?? { kind: 'account' },
    ).kind === 'supported';
    let firstSelectedOptionId: string | null = null;
    const optionAvailabilityById = new Map<string, ConnectedServicesSelectionOptionAvailabilityFact>();
    const markUnavailable = (optionId: string, unavailableReason: string) => {
        optionAvailabilityById.set(optionId, { availability: 'unavailable', unavailableReason });
    };
    const resolveAvailability = (input: Parameters<NonNullable<BuildNewSessionConnectedServicesSelectionListModelParams['resolveOptionAvailability']>>[0]) => {
        const result = params.resolveOptionAvailability?.(input) ?? {};
        if (result.availability) {
            optionAvailabilityById.set(input.optionId, {
                availability: result.availability,
                unavailableReason: result.availability === 'unavailable'
                    ? result.subtitle ?? params.translate('common.unavailable') : null,
            });
        }
        return result;
    };
    // The route the Session actually runs through decides what reads selected. An applied Team route outranks
    // any retained binding (and the native row), whether or not the Agent supplied a native descriptor.
    const teamRouteApplied = params.appliedTeamRoute !== undefined;
    const bindingsActive = params.nativeRoute?.active !== false && !teamRouteApplied;
    const sections: SelectionListSectionDescriptor[] = params.supportedServiceIds.map((serviceId) => {
        const serviceTitle = params.resolveServiceTitle(serviceId);
        const serviceOptions = params.profileOptionsByServiceId[serviceId] ?? [];
        const groupOptions = params.groupOptionsByServiceId[serviceId] ?? [];
        const connectedProfiles = serviceOptions.filter(isConnectedServiceProfileOptionSelectable);
        const profileById = new Map(serviceOptions.map(option => [option.profileId.trim(), option]));
        const usageMember = (profileId: string): PoolMemberUsageInput => ({
            accountId: profileId,
            enabled: true,
            credentialStatus: profileById.get(profileId)?.status,
            meters: params.quotaSnapshotsByKey?.[connectedServiceProfileKey({ serviceId, profileId })]?.meters ?? null,
        });
        const now = Date.now();
        const formatUsageSubtitle = (usage: PoolUsage): string | undefined => {
            return usage.windows.map(window => {
                const reset = formatResetCountdown(now, window.resetsAt, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
                const percent = `${window.remainingPct}%`;
                return `${window.label} · ${reset
                    ? ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remainingWithReset({ percent, reset })
                    : ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remaining({ percent })}`;
            }).join(' · ') || undefined;
        };
        const usageSubtitle = (profileIds: readonly string[]) => formatUsageSubtitle(derivePoolUsage({ members: profileIds.map(usageMember), now }));
        const needsReauthProfiles = serviceOptions.filter((option) => !isConnectedServiceProfileOptionSelectable(option));
        const connectedProfileIds = connectedProfiles.map((option) => option.profileId.trim()).filter(Boolean);
        const binding = params.bindingsByServiceId[serviceId];
        const explicitProfileId = binding?.source === 'connected' ? (binding.profileId ?? '').trim() : '';
        const effectiveProfileId = binding?.source === 'connected' && binding.selection !== 'group'
            ? explicitProfileId && connectedProfileIds.includes(explicitProfileId)
                ? explicitProfileId
                : params.allowDefaultProfileFallback === false
                    ? null
                    : resolveConnectedServiceDefaultProfileId({
                        serviceId,
                        connectedProfileIds,
                        defaultProfileByServiceId: params.defaultProfileIdByServiceId ?? {},
                    })
            : null;
        const usesConnectedProfile = Boolean(effectiveProfileId);
        const options: SelectionListOption[] = [];
        let usesConnectedGroup = false;
        let usesTeamResource = binding?.source === 'team_resource';
        let renderedSelectedTeamResource = false;

        for (const group of groupOptions) {
            if (group.status !== 'ready') continue;
            const groupId = group.groupId.trim();
            const activeProfileId = group.activeProfileId?.trim() ?? '';
            if (!groupId || !activeProfileId || !connectedProfileIds.includes(activeProfileId)) continue;
            const selected = bindingsActive && binding?.source === 'connected'
                && binding.selection === 'group'
                && binding.groupId === groupId;
            const optionId = createConnectedServiceGroupOptionId(serviceId, groupId);
            const optionBinding = {
                source: 'connected',
                selection: 'group',
                groupId,
            } satisfies ConnectedServiceBindingSelectionV2;
            const availability = resolveAvailability({
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            if (selected) usesConnectedGroup = true;
            const label = group.label.trim() || groupId;
            const activeProfile = connectedProfiles.find((profile) => profile.profileId.trim() === activeProfileId) ?? null;
            const summary = projectPoolUsage({ now, quotaLimitSelection: group.quotaLimitSelection,
                members: (group.memberProfileIds ?? []).map(profileId => {
                    const key = connectedServiceProfileKey({ serviceId, profileId });
                    return { accountId: profileId, enabled: true, credentialStatus: profileById.get(profileId)?.status,
                        snapshot: params.quotaSnapshotsByKey?.[key] ?? null, failed: Boolean(params.quotaErrorsByKey?.[key]) };
                }) });
            const subtitle = [resolveGroupSubtitle({ serviceTitle, activeProfileId, profiles: connectedProfiles,
                translate: params.translate }), availability.subtitle, formatUsageSubtitle(summary.usage)].filter(Boolean).join(' · ');
            options.push({
                id: optionId,
                label,
                subtitle,
                subtitleContent: params.renderPoolFreshness && summary.freshness.asOf !== null
                    ? () => params.renderPoolFreshness!(summary.freshness, subtitle, serviceTitle) : undefined,
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: joinHappierFacts(label, availability.subtitle) }),
                icon: params.renderRowIcon({
                    kind: 'group',
                    variant: availability.disabled || activeProfile?.status !== 'connected' ? 'warning' : 'default',
                }),
                selected,
                disabled: availability.disabled === true,
                onSelect: () => params.setBindingForService(serviceId, optionBinding),
            });
        }

        for (const resource of params.teamCredentialResources ?? []) {
            if (
                resource.sourcePresentation?.kind !== 'connected_service'
                || buildQualifiedPluginContributionKey(resource.sourcePresentation.service) !== serviceId
            ) continue;
            // An unavailable resource keeps its row: hiding it would also hide
            // a current selection and leave the person without the Home's
            // recovery instruction. Only the Home's recovery is presented here;
            // repair authority is decided again by the destination it names.
            const resourceCurrent = params.teamCredentialResourceStatusByKey === undefined
                || (params.teamCredentialResourceStatusByKey.get(`${resource.teamId}:${resource.id}`)?.kind === 'current');
            const selectable = resourceCurrent && resource.readiness.kind === 'available';
            // A catalog that isn't current yet is retried; otherwise the Home names the recovery.
            const recovery = selectable
                ? null
                : resourceCurrent
                    ? teamCredentialRecoveryPresentation(resource.recoveryAction, { isSourceCustodian: false })
                    : { destination: 'retry' as const, labelKey: 'teams.unavailable.retry' as const };
            const resourceStatus = params.teamCredentialResourceStatusByKey?.get(`${resource.teamId}:${resource.id}`);
            const seenSelectionIds = new Set<string>();
            for (const selection of resource.connectedServiceSelections) {
                if (selection.deliveryMode === 'brokered' && !brokeredSupported) continue;
                if (selection.deliveryMode === 'direct'
                    && buildQualifiedPluginContributionKey(selection.disclosedMember.service) !== serviceId) continue;
                const matchesBinding = binding?.source === 'team_resource'
                    && areTeamResourceConnectedServiceSelectionsEqual(binding, selection);
                const matchesAppliedRoute = params.appliedTeamRoute !== undefined
                    && params.appliedTeamRoute.teamId === resource.teamId
                    && params.appliedTeamRoute.resourceId === resource.id
                    && params.appliedTeamRoute.deliveryMode === selection.deliveryMode;
                const selected = matchesAppliedRoute || (bindingsActive && matchesBinding);
                const optionId = createTeamResourceServiceOptionId(selection);
                if (seenSelectionIds.has(optionId)) continue;
                seenSelectionIds.add(optionId);
                if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
                if (selected) usesTeamResource = true;
                if (matchesBinding) renderedSelectedTeamResource = true;
                // Recovery navigates to the Home's repair; it does not switch this Session.
                const availability: ConnectedServicesSelectionOptionAvailability = selectable ? resolveAvailability({
                    serviceId,
                    optionId,
                    binding: selection,
                }) : {};
                const teamName = params.teamNameById?.[resource.teamId]?.trim();
                if (!selectable) markUnavailable(optionId, resourceShortUnavailableLabel(resource.readiness, resourceStatus));
                // Unusable: a few words and the step this viewer can take; the row press opens that recovery.
                const subtitle = [(selectable
                    ? joinHappierFacts(teamName, params.translate(selection.deliveryMode === 'brokered'
                        ? 'teams.credentials.delivery.brokered'
                        : 'teams.credentials.delivery.direct'))
                    : joinHappierFacts(teamName, resourceShortUnavailableLabel(resource.readiness, resourceStatus),
                        recovery === null ? null : recoveryShortLabel(recovery))), availability.subtitle,
                selection.deliveryMode === 'direct'
                    ? describeDirectDeliveryVisibility(params.directDelivery?.visibility ?? readDirectDeliveryVisibility(), params.translate, params.directDelivery?.placement) : null,
                ].filter(Boolean).join('\n\n');
                options.push({
                    id: optionId,
                    label: params.teamCredentialDisplayNames?.[resource.id] ?? params.translate('common.unavailable'),
                    subtitle,
                    subtitleLines: selection.deliveryMode === 'direct' ? 0 : undefined,
                    accessibilityLabel: [params.teamCredentialDisplayNames?.[resource.id] ?? params.translate('common.unavailable'), subtitle].join(', '),
                    icon: params.renderRowIcon({ kind: 'team', variant: selectable && !availability.disabled ? 'default' : 'warning' }),
                    selected,
                    disabled: availability.disabled === true || (!selectable && !params.onRecoverTeamCredentialResource),
                    onSelect: selectable
                        ? () => params.setBindingForService(serviceId, selection)
                        : () => params.onRecoverTeamCredentialResource?.(resource),
                });
            }
        }

        if (binding?.source === 'team_resource' && !renderedSelectedTeamResource) {
            const optionId = createTeamResourceServiceOptionId(binding);
            if (bindingsActive && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const retainedResource = (params.teamCredentialResources ?? []).find((resource) => (
                resource.id === binding.resourceId
                && resource.sourcePresentation?.kind === 'connected_service'
                && buildQualifiedPluginContributionKey(resource.sourcePresentation.service) === serviceId
            ));
            const retainedRecovery = retainedResource?.readiness.kind === 'available'
                ? (params.teamCredentialResourceStatusByKey === undefined
                    || (params.teamCredentialResourceStatusByKey.get(`${retainedResource.teamId}:${retainedResource.id}`)?.kind === 'current')
                    ? null
                    : { destination: 'retry' as const, labelKey: 'teams.unavailable.retry' as const })
                : teamCredentialRecoveryPresentation(retainedResource?.recoveryAction, { isSourceCustodian: false });
            const retainedStatus = retainedResource
                ? params.teamCredentialResourceStatusByKey?.get(`${retainedResource.teamId}:${retainedResource.id}`)
                : undefined;
            markUnavailable(optionId, retainedResource
                ? resourceShortUnavailableLabel(retainedResource.readiness, retainedStatus)
                : params.translate('common.unavailable'));
            const retainedTeamName = retainedResource
                ? params.teamNameById?.[retainedResource.teamId]?.trim()
                : undefined;
            options.push({
                id: optionId,
                label: params.teamCredentialDisplayNames?.[binding.resourceId] ?? params.translate('common.unavailable'),
                subtitle: [retainedResource
                    ? joinHappierFacts(
                        retainedTeamName,
                        resourceShortUnavailableLabel(retainedResource.readiness, retainedStatus),
                        retainedRecovery === null ? null : recoveryShortLabel(retainedRecovery),
                    )
                    : params.translate('common.unavailable'),
                    binding.deliveryMode === 'direct'
                        ? describeDirectDeliveryVisibility(params.directDelivery?.visibility ?? readDirectDeliveryVisibility(), params.translate, params.directDelivery?.placement) : null,
                ].filter(Boolean).join('\n\n'),
                subtitleLines: binding.deliveryMode === 'direct' ? 0 : undefined,
                icon: params.renderRowIcon({ kind: 'team', variant: 'warning' }),
                selected: bindingsActive,
                disabled: retainedResource === undefined
                    || retainedRecovery === null
                    || !params.onRecoverTeamCredentialResource,
                onSelect: retainedResource && retainedRecovery
                    ? () => params.onRecoverTeamCredentialResource?.(retainedResource)
                    : () => undefined,
            });
        }

        for (const option of connectedProfiles) {
            const profileId = option.profileId.trim();
            if (!profileId) continue;
            const optionId = createConnectedServiceOptionId(serviceId, profileId);
            const selected = bindingsActive && usesConnectedProfile && effectiveProfileId === profileId;
            const optionBinding = { source: 'connected', selection: 'profile', profileId } satisfies ConnectedServiceBindingSelectionV2;
            const availability = resolveAvailability({
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const name = presentProfile(option, serviceTitle);
            const label = name.primaryLabel;

            options.push({
                id: optionId,
                label,
                subtitle: [name.identityLabel, availability.subtitle, usageSubtitle([profileId])].filter(Boolean).join(' · ') || undefined,
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: joinHappierFacts(label, name.identityLabel, availability.subtitle) }),
                icon: params.renderRowIcon({ kind: 'account', variant: availability.disabled ? 'warning' : 'default' }),
                selected,
                disabled: availability.disabled === true,
                onSelect: () => params.setBindingForService(serviceId, optionBinding),
            });
        }

        for (const option of needsReauthProfiles) {
            const profileId = option.profileId.trim();
            if (!profileId) continue;
            const unsupportedKind = option.status === 'unsupported_kind';
            const name = presentProfile(option, serviceTitle);
            const label = name.primaryLabel;
            const optionId = createReauthServiceOptionId(serviceId, profileId);
            markUnavailable(optionId, unsupportedKind
                ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                : presentConnectedAccountSignedOut().state);
            options.push({
                id: optionId,
                label,
                subtitle: unsupportedKind
                    ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                    : joinHappierFacts(name.identityLabel, presentConnectedAccountSignedOut().phrase),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: joinHappierFacts(label, name.identityLabel) }),
                icon: params.renderRowIcon({ kind: 'account', variant: 'warning' }),
                onSelect: unsupportedKind
                    ? (event) => params.onOpenSettings(serviceId, resolvePressTriggerAnchor(event))
                    : params.onReconnectProfile
                    ? (event) => params.onReconnectProfile?.(serviceId, profileId, resolvePressTriggerAnchor(event))
                    : (event) => params.onOpenSettings(serviceId, resolvePressTriggerAnchor(event)),
            });
        }

        if (params.includeNativeAuthOption !== false && !params.nativeRoute) {
            const nativeOptionId = createNativeServiceOptionId(serviceId);
            const nativeSelected = params.bindingsKnown !== false && !teamRouteApplied && !usesConnectedProfile && !usesConnectedGroup && !usesTeamResource;
            const nativeBinding = { source: 'native' } satisfies ConnectedServiceBindingSelectionV2;
            const nativeAvailability = resolveAvailability({
                serviceId,
                optionId: nativeOptionId,
                binding: nativeBinding,
            });
            if (nativeSelected && firstSelectedOptionId === null) firstSelectedOptionId = nativeOptionId;
            const nativeLabel = params.translate('connectedServices.authModal.nativeAuthTitle');
            options.push({
                id: nativeOptionId,
                label: nativeLabel,
                subtitle: nativeAvailability.subtitle ?? params.translate('connectedServices.authModal.nativeAuthSubtitle'),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: joinHappierFacts(nativeLabel, nativeAvailability.subtitle) }),
                icon: params.renderRowIcon({ kind: 'native', variant: nativeAvailability.disabled ? 'warning' : 'default' }),
                selected: nativeSelected,
                disabled: nativeAvailability.disabled === true,
                onSelect: () => params.setBindingForService(serviceId, nativeBinding),
            });
        }

        if (connectedProfiles.length === 0) {
            const connectLabel = params.translate('connectedServices.authModal.notConnectedTitle');
            options.push({
                id: createConnectServiceOptionId(serviceId),
                label: connectLabel,
                subtitle: params.translate('connectedServices.authModal.notConnectedSubtitle'),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: connectLabel }),
                icon: params.renderSettingsIcon(),
                onSelect: (event) => params.onOpenSettings(serviceId, resolvePressTriggerAnchor(event)),
            });
        }

        // Usable rows first, each group in its built order (Array#sort is stable).
        const unusable = (option: SelectionListOption) => isOptionUnavailable(option, optionAvailabilityById);
        return {
            kind: 'static',
            id: `connected-service:${serviceId}`,
            title: serviceTitle,
            options: [...options].sort((left, right) => Number(unusable(left)) - Number(unusable(right))),
        };
    });

    if (params.nativeRoute && params.includeNativeAuthOption !== false) {
        const route = params.nativeRoute;
        // A member leaving a shared credential needs their own connection before browsing its models.
        // Keep ordinary Machine-native browsing unchanged; it does not require a Connected Account.
        const connectServiceId = params.supportedServiceIds.find(serviceId => (
            (params.appliedTeamRoute !== undefined || params.bindingsByServiceId[serviceId]?.source === 'team_resource')
            && !(params.profileOptionsByServiceId[serviceId] ?? []).some(isConnectedServiceProfileOptionSelectable)
        ));
        const unavailable = params.supportedServiceIds.map(serviceId => params.resolveOptionAvailability?.({
            serviceId, optionId: createNativeServiceOptionId(serviceId), binding: { source: 'native' },
        })).find(availability => availability?.disabled);
        const selected = route.active && params.bindingsKnown !== false && params.supportedServiceIds.every(serviceId => (
            !params.bindingsByServiceId[serviceId] || params.bindingsByServiceId[serviceId]?.source === 'native'
        ));
        const id = `route-source:native:${encodeURIComponent(route.agentTargetKey)}`;
        if (unavailable?.availability) optionAvailabilityById.set(id, {
            availability: unavailable.availability,
            unavailableReason: unavailable.availability === 'unavailable'
                ? unavailable.subtitle ?? params.translate('common.unavailable') : null,
        });
        if (selected) firstSelectedOptionId = id;
        sections.unshift({
            kind: 'static',
            id: `route-sources:native:${encodeURIComponent(route.agentTargetKey)}`,
            options: [{
                id,
                label: params.translate('connectedServices.authModal.nativeAuthTitle'),
                accessibilityLabel: joinHappierFacts(params.translate('connectedServices.authModal.nativeAuthTitle'), unavailable?.subtitle),
                subtitle: unavailable?.subtitle ?? params.translate('connectedServices.authModal.nativeAuthSubtitle'),
                icon: params.renderRowIcon({ kind: 'native' }),
                selected,
                ...(route.onBrowse ? { rightAccessory: params.renderBrowseMark() } : {}),
                disabled: (!connectServiceId && !route.onBrowse) || unavailable?.disabled === true,
                onSelect: connectServiceId
                    ? event => params.onOpenSettings(connectServiceId, resolvePressTriggerAnchor(event))
                    : route.onBrowse,
            }],
        });
    }

    return {
        rootStep: {
            id: 'new-session-connected-services-root',
            title: params.translate('connectedServices.title'),
            sections,
        },
        selectedOptionId: firstSelectedOptionId,
        optionAvailabilityById: new Map(sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .map(option => [option.id, optionAvailabilityById.get(option.id)
                ?? (option.disabled
                    ? { availability: 'unavailable', unavailableReason: option.subtitle ?? params.translate('common.unavailable') }
                    : { availability: 'available', unavailableReason: null })] as const)),
    };
}

function isOptionUnavailable(
    option: SelectionListOption,
    availabilityById: ReadonlyMap<string, ConnectedServicesSelectionOptionAvailabilityFact>,
): boolean {
    const fact = availabilityById.get(option.id);
    return fact ? fact.availability === 'unavailable' : option.disabled === true;
}

/** Runs through's unavailable sources in one group last; session switch restrictions stay with healthy sources. */
export function foldUnavailableSelectionRows(
    sections: readonly SelectionListSectionDescriptor[],
    optionAvailabilityById: ReadonlyMap<string, ConnectedServicesSelectionOptionAvailabilityFact>,
    title: string,
): SelectionListSectionDescriptor[] {
    type StaticSection = Extract<SelectionListSectionDescriptor, { kind: 'static' }>;
    const dynamic = sections.filter((section) => section.kind !== 'static');
    return [...dynamic, ...foldUnavailableRows<SelectionListOption, StaticSection>({
        sections: sections.filter((section): section is StaticSection => section.kind === 'static'),
        isUnavailable: (option) => isOptionUnavailable(option, optionAvailabilityById),
        group: (options, groupTitle) => ({ kind: 'static', id: 'unavailable', title: groupTitle, options }),
        title,
    })];
}
