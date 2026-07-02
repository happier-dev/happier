import type * as React from 'react';

import {
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

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
    | 'connectedServices.authModal.notConnectedTitle'
    | 'connectedServices.authModal.notConnectedSubtitle'
    | 'connectedServices.title'
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported'
    | 'connectedServices.detail.connectSetupTokenSubtitle';

export type NewSessionConnectedServicesSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
}>;

export type BuildNewSessionConnectedServicesSelectionListModelParams = Readonly<{
    supportedServiceIds: ReadonlyArray<string>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    groupOptionsByServiceId: ConnectedServicesAccountGroupOptionsByServiceId;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    quotaBadgesByKey: Readonly<Record<string, ReadonlyArray<ConnectedServicesSelectionListBadge> | undefined>>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    onOpenSettings: (serviceId: string) => void;
    translate: (key: ConnectedServicesSelectionListTranslationKey) => string;
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

function resolveProfileTitle(option: ConnectedServicesProfileOption): string {
    const label = (option.label ?? '').trim();
    if (label) return label;

    const providerEmail = (option.providerEmail ?? '').trim();
    if (providerEmail) return providerEmail;

    return option.profileId;
}

function resolveProfileSubtitle(option: ConnectedServicesProfileOption): string | undefined {
    const label = (option.label ?? '').trim();
    const providerEmail = (option.providerEmail ?? '').trim();

    if (label && providerEmail) return `${option.profileId} · ${providerEmail}`;
    if (label) return option.profileId;
    if (providerEmail && providerEmail !== option.profileId) return option.profileId;
    return undefined;
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
        const connectedProfiles = serviceOptions.filter((option) => option.status === 'connected');
        const needsReauthProfiles = serviceOptions.filter((option) => option.status !== 'connected');
        const connectedProfileIds = connectedProfiles.map((option) => option.profileId.trim()).filter(Boolean);
        const binding = params.bindingsByServiceId[serviceId];
        const explicitProfileId = (binding?.profileId ?? '').trim();
        const effectiveProfileId = binding?.source === 'connected' && binding.selection !== 'group'
            ? explicitProfileId && connectedProfileIds.includes(explicitProfileId)
                ? explicitProfileId
                : resolveConnectedServiceDefaultProfileId({
                    serviceId,
                    connectedProfileIds,
                    defaultProfileByServiceId: params.defaultProfileIdByServiceId ?? {},
                })
            : null;
        const usesConnectedProfile = Boolean(effectiveProfileId);
        const options: SelectionListOption[] = [];
        let usesConnectedGroup = false;

        for (const group of groupOptions) {
            if (group.status !== 'ready') continue;
            const groupId = group.groupId.trim();
            const activeProfileId = group.activeProfileId.trim();
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
            options.push({
                id: optionId,
                label,
                subtitle: availability.subtitle ?? params.translate('connectedServices.authModal.groupSubtitle'),
                accessibilityLabel: resolveServiceOptionAccessibilityLabel({ serviceTitle, optionLabel: label }),
                icon: params.renderSelectionIcon({ selected, variant: availability.disabled ? 'warning' : 'default' }),
                disabled: availability.disabled === true,
                onSelect: () => params.setBindingForService(serviceId, optionBinding),
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
            const label = resolveProfileTitle(option);

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
            const label = resolveProfileTitle(option);
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

        const nativeOptionId = createNativeServiceOptionId(serviceId);
        const nativeSelected = !usesConnectedProfile && !usesConnectedGroup;
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
