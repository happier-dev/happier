import type * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';

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
import type { TranslationParams } from '@/text';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { isConnectedServiceProfileOptionSelectable } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

export type ConnectedServicesSelectionListBadge = Readonly<{
    meterId: string;
    text: string;
}>;

export type ConnectedServicesSelectionOptionAvailability = Readonly<{
    disabled?: boolean;
    subtitle?: string;
}>;

export type ConnectedServicesSelectionIconVariant = 'default' | 'warning';

export type ConnectedServicesSelectionListTranslationKey =
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
    | 'teams.unavailable.retry'
    | 'teams.credentials.recovery.openSettings'
    | 'teams.credentials.recovery.selectBroker'
    | 'teams.credentials.recovery.ownerHandoff'
    | 'teams.credentials.recovery.updateApp'
    | 'teams.credentials.recovery.chooseAnother'
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
}>;

export type BuildNewSessionConnectedServicesSelectionListModelParams = Readonly<{
    supportedServiceIds: ReadonlyArray<string>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    /** Exact currentness projection from the Home catalog; stale rows stay visible but cannot be selected. */
    teamCredentialResourceCurrentKeys?: ReadonlySet<string>;
    teamNameById?: Readonly<Record<string, string>>;
    onRecoverTeamCredentialResource?: (resource: TeamCredentialResourceCatalogEntryV1) => void;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    /** Connected-account-only consumers can suppress the implicit local CLI auth fallback. */
    includeNativeAuthOption?: boolean;
    /** Exact-binding consumers can prevent stale selections from visually adopting a different default profile. */
    allowDefaultProfileFallback?: boolean;
    quotaBadgesByKey: Readonly<Record<string, ReadonlyArray<ConnectedServicesSelectionListBadge> | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    onOpenSettings: (serviceId: string) => void;
    translate: ConnectedServicesSelectionListTranslate;
    resolveServiceTitle: (serviceId: string) => string;
    renderSelectionIcon: (params: Readonly<{ selected: boolean; variant?: ConnectedServicesSelectionIconVariant }>) => React.ReactNode;
    renderSettingsIcon: () => React.ReactNode;
    renderQuotaBadges: (badges: ReadonlyArray<ConnectedServicesSelectionListBadge>) => React.ReactNode;
    renderNeedsReauthPill: () => React.ReactNode;
    onReconnectProfile?: (serviceId: string, profileId: string) => void;
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
    const disclosedMember = selection.disclosedMember;
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
    const sections: SelectionListSectionDescriptor[] = params.supportedServiceIds.map((serviceId) => {
        const serviceTitle = params.resolveServiceTitle(serviceId);
        const serviceOptions = params.profileOptionsByServiceId[serviceId] ?? [];
        const groupOptions = params.groupOptionsByServiceId[serviceId] ?? [];
        const connectedProfiles = serviceOptions.filter(isConnectedServiceProfileOptionSelectable);
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
            const selected = binding?.source === 'connected'
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
                subtitle: availability.subtitle ?? resolveGroupSubtitle({
                    serviceTitle,
                    activeProfileId,
                    profiles: connectedProfiles,
                    translate: params.translate,
                }),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({
                    selected,
                    variant: availability.disabled || activeProfile?.status !== 'connected' ? 'warning' : 'default',
                }),
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
            const resourceCurrent = params.teamCredentialResourceCurrentKeys === undefined
                || params.teamCredentialResourceCurrentKeys.has(`${resource.teamId}:${resource.id}`);
            const selectable = resourceCurrent && resource.readiness.kind === 'available';
            const recovery = selectable
                ? null
                : teamCredentialRecoveryPresentation(resource.recoveryAction, { isSourceCustodian: false });
            const seenSelectionIds = new Set<string>();
            for (const selection of resource.connectedServiceSelections) {
                if (selection.deliveryMode === 'brokered' && selection.disclosedMember) continue;
                if (selection.deliveryMode === 'direct' && (!selection.disclosedMember
                    || buildQualifiedPluginContributionKey(selection.disclosedMember.service) !== serviceId)) continue;
                const selected = binding?.source === 'team_resource'
                    && areTeamResourceConnectedServiceSelectionsEqual(binding, selection);
                const optionId = createTeamResourceServiceOptionId(selection);
                if (seenSelectionIds.has(optionId)) continue;
                seenSelectionIds.add(optionId);
                if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
                if (selected) usesTeamResource = true;
                if (selected) renderedSelectedTeamResource = true;
                const availability = resolveAvailability({
                    rootParams: params,
                    serviceId,
                    optionId,
                    binding: selection,
                });
                const teamName = params.teamNameById?.[resource.teamId]?.trim();
                options.push({
                    id: optionId,
                    label: resource.displayName,
                    subtitle: availability.subtitle ?? [
                        teamName,
                        resourceCurrent ? null : params.translate('teams.unavailable.retry'),
                        selectable ? params.translate(selection.deliveryMode === 'brokered'
                            ? 'teams.credentials.delivery.brokered'
                            : 'teams.credentials.delivery.direct') : null,
                        recovery === null ? null : params.translate(recovery.labelKey),
                    ].filter((part): part is string => Boolean(part))
                        .join(' · '),
                    icon: params.renderSelectionIcon({ selected, variant: selectable && !availability.disabled ? 'default' : 'warning' }),
                    disabled: availability.disabled === true || (!selectable && !params.onRecoverTeamCredentialResource),
                    onSelect: selectable
                        ? () => params.setBindingForService(serviceId, selection)
                        : () => params.onRecoverTeamCredentialResource?.(resource),
                });
            }
        }

        if (binding?.source === 'team_resource' && !renderedSelectedTeamResource) {
            const optionId = createTeamResourceServiceOptionId(binding);
            if (firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const retainedResource = (params.teamCredentialResources ?? []).find((resource) => (
                resource.id === binding.resourceId
                && resource.sourcePresentation?.kind === 'connected_service'
                && buildQualifiedPluginContributionKey(resource.sourcePresentation.service) === serviceId
            ));
            const retainedRecovery = retainedResource?.readiness.kind === 'available'
                ? (params.teamCredentialResourceCurrentKeys === undefined
                    || params.teamCredentialResourceCurrentKeys.has(`${retainedResource.teamId}:${retainedResource.id}`)
                    ? null
                    : { labelKey: 'teams.unavailable.retry' as const })
                : teamCredentialRecoveryPresentation(retainedResource?.recoveryAction, { isSourceCustodian: false });
            const retainedTeamName = retainedResource
                ? params.teamNameById?.[retainedResource.teamId]?.trim()
                : undefined;
            options.push({
                id: optionId,
                label: retainedResource?.displayName ?? binding.resourceId,
                subtitle: retainedResource
                    ? [
                        retainedTeamName,
                        params.translate(binding.deliveryMode === 'brokered'
                            ? 'teams.credentials.delivery.brokered'
                            : 'teams.credentials.delivery.direct'),
                        retainedRecovery === null ? null : params.translate(retainedRecovery.labelKey),
                    ].filter((part): part is string => Boolean(part)).join(' · ')
                    : params.translate('common.unavailable'),
                icon: params.renderSelectionIcon({ selected: true, variant: 'warning' }),
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
            const selected = usesConnectedProfile && effectiveProfileId === profileId;
            const optionBinding = { source: 'connected', selection: 'profile', profileId } satisfies ConnectedServicesServiceBinding;
            const availability = resolveAvailability({
                rootParams: params,
                serviceId,
                optionId,
                binding: optionBinding,
            });
            if (selected && firstSelectedOptionId === null) firstSelectedOptionId = optionId;
            const profileKey = connectedServiceProfileKey({ serviceId, profileId });
            const quotaBadges = params.quotaBadgesByKey[profileKey] ?? [];
            const label = resolveProfileTitle(option, serviceTitle);

            options.push({
                id: optionId,
                label,
                subtitle: availability.subtitle ?? resolveProfileSubtitle(option),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({ selected, variant: availability.disabled ? 'warning' : 'default' }),
                disabled: availability.disabled === true,
                rightAccessory: quotaBadges.length > 0
                    ? params.renderQuotaBadges(quotaBadges)
                    : undefined,
                onSelect: () => params.setBindingForService(serviceId, optionBinding),
            });
        }

        for (const option of needsReauthProfiles) {
            const profileId = option.profileId.trim();
            if (!profileId) continue;
            const unsupportedKind = option.status === 'unsupported_kind';
            const label = resolveProfileTitle(option, serviceTitle);
            options.push({
                id: createReauthServiceOptionId(serviceId, profileId),
                label,
                subtitle: unsupportedKind
                    ? params.translate(option.unsupportedSubtitleKey ?? 'connectedServices.defaultAuth.warning.connected_service_unsupported')
                    : resolveProfileSubtitle(option),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({ selected: false, variant: 'warning' }),
                rightAccessory: params.renderNeedsReauthPill(),
                onSelect: unsupportedKind
                    ? () => params.onOpenSettings(serviceId)
                    : params.onReconnectProfile
                    ? () => params.onReconnectProfile?.(serviceId, profileId)
                    : () => params.onOpenSettings(serviceId),
            });
        }

        if (params.includeNativeAuthOption !== false) {
            const nativeOptionId = createNativeServiceOptionId(serviceId);
            const nativeSelected = !usesConnectedProfile && !usesConnectedGroup && !usesTeamResource;
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
                icon: params.renderSelectionIcon({ selected: nativeSelected, variant: nativeAvailability.disabled ? 'warning' : 'default' }),
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
                onSelect: () => params.onOpenSettings(serviceId),
            });
        }

        return {
            kind: 'static',
            id: `connected-service:${serviceId}`,
            title: serviceTitle,
            options,
        };
    });

    return {
        rootStep: {
            id: 'new-session-connected-services-root',
            title: params.translate('connectedServices.title'),
            sections,
        },
        selectedOptionId: firstSelectedOptionId,
    };
}
