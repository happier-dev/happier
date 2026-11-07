import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import type * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
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
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility, type DirectDeliveryDisclosureTranslationKey } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import type { TranslationParams } from '@/text';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { derivePoolUsage, type PoolMemberUsageInput } from '@/components/settings/connectedServices/pools/derivePoolUsage';
import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '@/components/settings/connectedServices/account/accountBlockFormatters';
import { formatResetCountdown } from '@/sync/domains/connectedServices/formatResetCountdown';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

export type ConnectedServicesSelectionOptionAvailability = Readonly<{
    disabled?: boolean;
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
    /** Exact currentness projection from the Home catalog; stale rows stay visible but cannot be selected. */
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    teamNameById?: Readonly<Record<string, string>>;
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
    quotaSnapshotsByKey?: Readonly<Record<string, Readonly<{ meters: readonly ConnectedServiceQuotaMeterV1[] }> | null | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
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

function resolveProfileTitle(option: ConnectedServicesProfileOption, serviceTitle: string): string {
    const label = (option.label ?? '').trim();
    if (label) return label;

    const providerEmail = (option.providerEmail ?? '').trim();
    if (providerEmail) return providerEmail;

    return serviceTitle;
}

function resolveProfileSubtitle(option: ConnectedServicesProfileOption): string | undefined {
    const label = (option.label ?? '').trim();
    const providerEmail = (option.providerEmail ?? '').trim();

    return label && providerEmail && label !== providerEmail ? providerEmail : undefined;
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
        profileId: resolveProfileTitle(activeProfile, params.serviceTitle),
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

function resolveAvailability(params: Readonly<{
    rootParams: BuildNewSessionConnectedServicesSelectionListModelParams;
    serviceId: string;
    optionId: string;
    binding: ConnectedServicesServiceBinding;
}>): ConnectedServicesSelectionOptionAvailability {
    return params.rootParams.resolveOptionAvailability?.({
        serviceId: params.serviceId,
        optionId: params.optionId,
        binding: params.binding,
    }) ?? {};
}

export function buildNewSessionConnectedServicesSelectionListModel(
    params: BuildNewSessionConnectedServicesSelectionListModelParams,
): NewSessionConnectedServicesSelectionListModel {
    let firstSelectedOptionId: string | null = null;
    const optionAvailabilityById = new Map<string, ConnectedServicesSelectionOptionAvailabilityFact>();
    const markUnavailable = (optionId: string, unavailableReason: string) => {
        optionAvailabilityById.set(optionId, { availability: 'unavailable', unavailableReason });
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
        const usageSubtitle = (profileIds: readonly string[]): string | undefined => {
            const usage = derivePoolUsage({ members: profileIds.map(usageMember), now });
            return usage.windows.map(window => {
                const reset = formatResetCountdown(now, window.resetsAt, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
                const percent = `${window.remainingPct}%`;
                return `${window.label} · ${reset
                    ? ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remainingWithReset({ percent, reset })
                    : ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remaining({ percent })}`;
            }).join(' · ') || undefined;
        };
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
            } satisfies ConnectedServicesServiceBinding;
            const availability = resolveAvailability({
                rootParams: params,
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            if (selected) usesConnectedGroup = true;
            const label = group.label.trim() || groupId;
            const activeProfile = connectedProfiles.find((profile) => profile.profileId.trim() === activeProfileId) ?? null;
            options.push({
                id: optionId,
                label,
                subtitle: [availability.subtitle ?? resolveGroupSubtitle({
                    serviceTitle,
                    activeProfileId,
                    profiles: connectedProfiles,
                    translate: params.translate,
                }), usageSubtitle(group.memberProfileIds ?? [])].filter(Boolean).join(' · '),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
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
                const availability = resolveAvailability({
                    rootParams: params,
                    serviceId,
                    optionId,
                    binding: selection,
                });
                const teamName = params.teamNameById?.[resource.teamId]?.trim();
                if (!selectable) markUnavailable(optionId, resourceShortUnavailableLabel(resource.readiness, resourceStatus));
                // Unusable: a few words and the step this viewer can take; the row press opens that recovery.
                const subtitle = [availability.subtitle ?? (selectable
                    ? joinHappierFacts(teamName, params.translate(selection.deliveryMode === 'brokered'
                        ? 'teams.credentials.delivery.brokered'
                        : 'teams.credentials.delivery.direct'))
                    : joinHappierFacts(teamName, resourceShortUnavailableLabel(resource.readiness, resourceStatus),
                        recovery === null ? null : recoveryShortLabel(recovery))),
                selection.deliveryMode === 'direct'
                    ? describeDirectDeliveryVisibility(readDirectDeliveryVisibility(), params.translate) : null,
                ].filter(Boolean).join('\n\n');
                options.push({
                    id: optionId,
                    label: resource.displayName,
                    subtitle,
                    subtitleLines: selection.deliveryMode === 'direct' ? 0 : undefined,
                    accessibilityLabel: [resource.displayName, subtitle].join(', '),
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
                label: retainedResource?.displayName ?? binding.resourceId,
                subtitle: [retainedResource
                    ? joinHappierFacts(
                        retainedTeamName,
                        resourceShortUnavailableLabel(retainedResource.readiness, retainedStatus),
                        retainedRecovery === null ? null : recoveryShortLabel(retainedRecovery),
                    )
                    : params.translate('common.unavailable'),
                    binding.deliveryMode === 'direct'
                        ? describeDirectDeliveryVisibility(readDirectDeliveryVisibility(), params.translate) : null,
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
            const optionBinding = { source: 'connected', selection: 'profile', profileId } satisfies ConnectedServicesServiceBinding;
            const availability = resolveAvailability({
                rootParams: params,
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const label = resolveProfileTitle(option, serviceTitle);

            options.push({
                id: optionId,
                label,
                subtitle: [availability.subtitle ?? resolveProfileSubtitle(option), usageSubtitle([profileId])].filter(Boolean).join(' · ') || undefined,
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
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
            const label = resolveProfileTitle(option, serviceTitle);
            const optionId = createReauthServiceOptionId(serviceId, profileId);
            markUnavailable(optionId, unsupportedKind
                ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                : presentConnectedAccountSignedOut().state);
            options.push({
                id: optionId,
                label,
                subtitle: unsupportedKind
                    ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                    : joinHappierFacts(resolveProfileSubtitle(option), presentConnectedAccountSignedOut().phrase),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
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
            const nativeBinding = { source: 'native' } satisfies ConnectedServicesServiceBinding;
            const nativeAvailability = resolveAvailability({
                rootParams: params,
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
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: nativeLabel }),
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
        const unusable = (option: SelectionListOption) => option.disabled === true
            || optionAvailabilityById.get(option.id)?.availability === 'unavailable';
        return {
            kind: 'static',
            id: `connected-service:${serviceId}`,
            title: serviceTitle,
            options: [...options].sort((left, right) => Number(unusable(left)) - Number(unusable(right))),
        };
    });

    if (params.nativeRoute && params.includeNativeAuthOption !== false) {
        const route = params.nativeRoute;
        const unavailable = params.supportedServiceIds.map(serviceId => params.resolveOptionAvailability?.({
            serviceId, optionId: createNativeServiceOptionId(serviceId), binding: { source: 'native' },
        })).find(availability => availability?.disabled);
        const selected = route.active && params.bindingsKnown !== false && params.supportedServiceIds.every(serviceId => (
            !params.bindingsByServiceId[serviceId] || params.bindingsByServiceId[serviceId]?.source === 'native'
        ));
        const id = `route-source:native:${encodeURIComponent(route.agentTargetKey)}`;
        if (selected) firstSelectedOptionId = id;
        sections.unshift({
            kind: 'static',
            id: `route-sources:native:${encodeURIComponent(route.agentTargetKey)}`,
            options: [{
                id,
                label: params.translate('connectedServices.authModal.nativeAuthTitle'),
                subtitle: unavailable?.subtitle ?? params.translate('connectedServices.authModal.nativeAuthSubtitle'),
                icon: params.renderRowIcon({ kind: 'native' }),
                selected,
                ...(route.onBrowse ? { rightAccessory: params.renderBrowseMark() } : {}),
                disabled: !route.onBrowse || unavailable?.disabled === true,
                onSelect: route.onBrowse,
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

/** Runs through's rows that can't be used as they are, and any row its owner disabled, in one group last. */
export function foldUnavailableSelectionRows(
    sections: readonly SelectionListSectionDescriptor[],
    optionAvailabilityById: ReadonlyMap<string, ConnectedServicesSelectionOptionAvailabilityFact>,
    title: string,
): SelectionListSectionDescriptor[] {
    type StaticSection = Extract<SelectionListSectionDescriptor, { kind: 'static' }>;
    const dynamic = sections.filter((section) => section.kind !== 'static');
    return [...dynamic, ...foldUnavailableRows<SelectionListOption, StaticSection>({
        sections: sections.filter((section): section is StaticSection => section.kind === 'static'),
        isUnavailable: (option) => option.disabled === true
            || optionAvailabilityById.get(option.id)?.availability === 'unavailable',
        group: (options, groupTitle) => ({ kind: 'static', id: 'unavailable', title: groupTitle, options }),
        title,
    })];
}
