import { resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import type {
    ConnectedServicesAccountGroupOptionsByServiceId,
    ConnectedServicesProfileOption,
    ConnectedServicesProfileOptionsByServiceId,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';

export type ConnectedServicesAuthLabelModel = Readonly<{
    label: string;
    connectedCount: number;
    serviceStatesById: Readonly<Record<string, ConnectedServicesAuthServiceState>>;
    warningCodes: ReadonlyArray<ConnectedServicesAuthWarningCode>;
}>;

export type ConnectedServicesAuthWarningCode =
    | 'connected_profile_unavailable'
    | 'connected_group_unavailable'
    | 'connected_group_disabled'
    | 'connected_service_unsupported';

export type ConnectedServicesAuthWarningTranslationKey =
    | 'connectedServices.defaultAuth.warning.connected_profile_unavailable'
    | 'connectedServices.defaultAuth.warning.connected_group_unavailable'
    | 'connectedServices.defaultAuth.warning.connected_group_disabled'
    | 'connectedServices.defaultAuth.warning.connected_service_unsupported';

export type ConnectedServicesAuthServiceState = Readonly<{
    requestedSource: 'native' | 'connected';
    requestedSelection?: 'profile' | 'group';
    effectiveSource: 'native' | 'connected';
    effectiveSelection?: 'profile' | 'group';
    profileId?: string;
    groupId?: string;
    warningCode?: ConnectedServicesAuthWarningCode;
}>;

export type ResolveConnectedServicesAuthLabelParams = Readonly<{
    supportedServiceIds: ReadonlyArray<string>;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    profileOptionsByServiceId: ConnectedServicesProfileOptionsByServiceId;
    accountGroupOptionsByServiceId?: ConnectedServicesAccountGroupOptionsByServiceId;
    accountGroupsEnabled?: boolean;
    defaultProfileIdByServiceId?: Readonly<Record<string, string | undefined>>;
    resolveServiceTitle: (serviceId: string) => string;
    nativeLabel: string;
    formatConnectedCountLabel: (count: number) => string;
}>;

export function resolveConnectedServicesAuthWarningTranslationKey(
    warningCode: ConnectedServicesAuthWarningCode | undefined,
): ConnectedServicesAuthWarningTranslationKey | undefined {
    if (warningCode === 'connected_profile_unavailable') {
        return 'connectedServices.defaultAuth.warning.connected_profile_unavailable';
    }
    if (warningCode === 'connected_group_unavailable') {
        return 'connectedServices.defaultAuth.warning.connected_group_unavailable';
    }
    if (warningCode === 'connected_group_disabled') {
        return 'connectedServices.defaultAuth.warning.connected_group_disabled';
    }
    if (warningCode === 'connected_service_unsupported') {
        return 'connectedServices.defaultAuth.warning.connected_service_unsupported';
    }
    return undefined;
}

function resolveProfileLabel(option: ConnectedServicesProfileOption): string {
    const label = (option.label ?? '').trim();
    if (label) return label;

    const providerEmail = (option.providerEmail ?? '').trim();
    if (providerEmail) return providerEmail;

    return option.profileId;
}

function appendWarning(
    warnings: ConnectedServicesAuthWarningCode[],
    code: ConnectedServicesAuthWarningCode,
) {
    if (!warnings.includes(code)) warnings.push(code);
}

function readOptionalString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function resolveConnectedBindingState(
    params: ResolveConnectedServicesAuthLabelParams,
    serviceId: string,
    supported: boolean,
): ConnectedServicesAuthServiceState {
    const binding = params.bindingsByServiceId[serviceId];
    if (binding?.source !== 'connected') {
        return {
            requestedSource: 'native',
            effectiveSource: 'native',
        };
    }

    const requestedSelection = binding.selection === 'group' ? 'group' : 'profile';

    if (!supported) {
        return {
            requestedSource: 'connected',
            requestedSelection,
            effectiveSource: 'native',
            warningCode: 'connected_service_unsupported',
        };
    }

    const connectedProfiles = (params.profileOptionsByServiceId[serviceId] ?? [])
        .filter((option) => option.status === 'connected');
    if (connectedProfiles.length === 0) {
        return {
            requestedSource: 'connected',
            requestedSelection,
            effectiveSource: 'native',
            warningCode: requestedSelection === 'group'
                ? 'connected_group_unavailable'
                : 'connected_profile_unavailable',
        };
    }

    const connectedProfileIds = connectedProfiles.map((option) => option.profileId);
    const explicitProfileId = binding.selection !== 'group'
        ? readOptionalString(binding.profileId)
        : '';
    const explicitGroupId = binding.selection === 'group'
        ? readOptionalString(binding.groupId)
        : '';

    if (binding.selection === 'group' && explicitGroupId) {
        if (params.accountGroupsEnabled === false) {
            return {
                requestedSource: 'connected',
                requestedSelection: 'group',
                effectiveSource: 'native',
                groupId: explicitGroupId,
                warningCode: 'connected_group_disabled',
            };
        }
        const group = (params.accountGroupOptionsByServiceId?.[serviceId] ?? []).find((option) =>
            option.groupId === explicitGroupId
        );
        const activeProfileId = (group?.activeProfileId ?? '').trim();
        if (group && group.status === 'ready' && activeProfileId && connectedProfileIds.includes(activeProfileId)) {
            return {
                requestedSource: 'connected',
                requestedSelection: 'group',
                effectiveSource: 'connected',
                effectiveSelection: 'group',
                groupId: explicitGroupId,
                profileId: activeProfileId,
            };
        }
        return {
            requestedSource: 'connected',
            requestedSelection: 'group',
            effectiveSource: 'native',
            groupId: explicitGroupId,
            warningCode: 'connected_group_unavailable',
        };
    }

    const effectiveProfileId = explicitProfileId
        ? connectedProfileIds.includes(explicitProfileId)
            ? explicitProfileId
            : null
        : resolveConnectedServiceDefaultProfileId({
            serviceId,
            connectedProfileIds,
            defaultProfileByServiceId: params.defaultProfileIdByServiceId ?? {},
        });
    if (!effectiveProfileId) {
        return {
            requestedSource: 'connected',
            requestedSelection: 'profile',
            effectiveSource: 'native',
            ...(explicitProfileId ? { profileId: explicitProfileId } : {}),
            warningCode: 'connected_profile_unavailable',
        };
    }

    const profile = connectedProfiles.find((option) => option.profileId === effectiveProfileId);
    if (!profile) {
        return {
            requestedSource: 'connected',
            requestedSelection: 'profile',
            effectiveSource: 'native',
            profileId: effectiveProfileId,
            warningCode: 'connected_profile_unavailable',
        };
    }

    return {
        requestedSource: 'connected',
        requestedSelection: 'profile',
        effectiveSource: 'connected',
        effectiveSelection: 'profile',
        profileId: effectiveProfileId,
    };
}

function resolveConnectedBindingLabel(
    params: ResolveConnectedServicesAuthLabelParams,
    serviceId: string,
    state: ConnectedServicesAuthServiceState,
): string | null {
    if (state.effectiveSource !== 'connected') return null;

    if (state.effectiveSelection === 'group' && state.groupId) {
        const group = (params.accountGroupOptionsByServiceId?.[serviceId] ?? []).find((option) =>
            option.groupId === state.groupId
        );
        return group ? `${params.resolveServiceTitle(serviceId)}: ${group.label}` : null;
    }

    if (state.effectiveSelection === 'profile' && state.profileId) {
        const profile = (params.profileOptionsByServiceId[serviceId] ?? [])
            .find((option) => option.status === 'connected' && option.profileId === state.profileId);
        return profile ? `${params.resolveServiceTitle(serviceId)}: ${resolveProfileLabel(profile)}` : null;
    }

    return null;
}

export function resolveConnectedServicesAuthLabel(
    params: ResolveConnectedServicesAuthLabelParams,
): ConnectedServicesAuthLabelModel {
    const connectedLabels: string[] = [];
    const serviceStatesById: Record<string, ConnectedServicesAuthServiceState> = {};
    const warningCodes: ConnectedServicesAuthWarningCode[] = [];
    const supportedServiceIdSet = new Set(params.supportedServiceIds);

    for (const serviceId of params.supportedServiceIds) {
        const state = resolveConnectedBindingState(params, serviceId, true);
        serviceStatesById[serviceId] = state;
        if (state.warningCode) appendWarning(warningCodes, state.warningCode);
        const label = resolveConnectedBindingLabel(params, serviceId, state);
        if (label) connectedLabels.push(label);
    }

    for (const [serviceId, binding] of Object.entries(params.bindingsByServiceId)) {
        if (supportedServiceIdSet.has(serviceId) || binding?.source !== 'connected') continue;
        const state = resolveConnectedBindingState(params, serviceId, false);
        serviceStatesById[serviceId] = state;
        if (state.warningCode) appendWarning(warningCodes, state.warningCode);
    }

    if (connectedLabels.length === 0) {
        return {
            label: params.nativeLabel,
            connectedCount: 0,
            serviceStatesById,
            warningCodes,
        };
    }

    return {
        label: connectedLabels.length === 1
            ? connectedLabels[0]!
            : params.formatConnectedCountLabel(connectedLabels.length),
        connectedCount: connectedLabels.length,
        serviceStatesById,
        warningCodes,
    };
}
