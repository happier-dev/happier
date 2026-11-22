import type { AccountProfile } from '@happier-dev/protocol';
import {
    buildBackendTargetKey,
    isConnectedServiceCredentialHealthStatusUsable,
    type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';

import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import type { ConnectedServiceQuotaProfileRefProvenance } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import type { Metadata } from '@/sync/domains/state/storageTypes';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

function readObjectRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readTrimmedString(value: unknown): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function resolveActiveGroupProfileId(params: Readonly<{
    services: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: string;
    groupId: string;
}>): string | null {
    const service = params.services.find((candidate) => candidate.serviceId === params.serviceId) ?? null;
    if (!service) return null;

    const group = service.groups.find((candidate) => candidate.groupId === params.groupId) ?? null;
    if (!group) return null;

    const connectedProfileIds = new Set(
        service.profiles
            .filter((profile) =>
                isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(profile.status))
            )
            .map((profile) => profile.profileId.trim())
            .filter(Boolean),
    );
    if (connectedProfileIds.size === 0) return null;

    const activeProfileId = readTrimmedString(group.activeProfileId);
    if (activeProfileId && connectedProfileIds.has(activeProfileId)) {
        return activeProfileId;
    }

    for (const memberProfileId of group.memberProfileIds) {
        const candidate = memberProfileId.trim();
        if (candidate && connectedProfileIds.has(candidate)) return candidate;
    }

    return null;
}

function resolveProfileCredentialHealthStatus(params: Readonly<{
    services: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: string;
    profileId: string;
}>): ConnectedServiceCredentialHealthStatusV1 | null {
    const service = params.services.find((candidate) => candidate.serviceId === params.serviceId) ?? null;
    if (!service) return null;
    const profile = service.profiles.find((candidate) => candidate.profileId.trim() === params.profileId) ?? null;
    return profile ? resolveConnectedServiceCredentialHealthStatus(profile.status) : null;
}

function resolveBindingProfileId(params: Readonly<{
    optionBinding: unknown;
    payloadBinding: Record<string, unknown> | null;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: string;
}>): Readonly<{ profileId: string; selection: 'group' | 'profile'; groupId?: string }> | null {
    const optionBindingRecord = readObjectRecord(params.optionBinding);
    const selection =
        readTrimmedString(optionBindingRecord?.selection)
        ?? readTrimmedString(params.payloadBinding?.selection);
    const explicitProfileId =
        readTrimmedString(optionBindingRecord?.profileId)
        ?? readTrimmedString(params.payloadBinding?.profileId);
    const groupId =
        readTrimmedString(optionBindingRecord?.groupId)
        ?? readTrimmedString(params.payloadBinding?.groupId);
    if (explicitProfileId) {
        return {
            profileId: explicitProfileId,
            selection: selection === 'group' ? 'group' : 'profile',
            ...(selection === 'group' && groupId ? { groupId } : {}),
        };
    }

    if (selection !== 'group') return null;
    if (!groupId) return null;

    const activeProfileId = resolveActiveGroupProfileId({
        services: params.accountProfileConnectedServicesV2,
        serviceId: params.serviceId,
        groupId,
    });
    return activeProfileId ? { profileId: activeProfileId, selection: 'group', groupId } : null;
}

export type ConnectedServiceQuotaProfileRefForSession = Readonly<{
    serviceId: string;
    profileId: string;
    groupId?: string;
    credentialHealthStatus?: ConnectedServiceCredentialHealthStatusV1;
    provenance: ConnectedServiceQuotaProfileRefProvenance;
}>;

export function resolveConnectedServiceQuotaProfileRefForSession(params: Readonly<{
    metadata: Metadata | null | undefined;
    agentId: string;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
}>): ConnectedServiceQuotaProfileRefForSession | null {
    if (!isAgentId(params.agentId)) return null;
    const supportedServiceIds = getAgentCore(params.agentId).connectedServices?.supportedServiceIds ?? [];
    if (supportedServiceIds.length === 0) return null;

    const metadata = readObjectRecord(params.metadata);
    if (!metadata) return null;

    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.agentId });
    const agentOptionStateByAgentId = readObjectRecord(metadata.agentNewSessionOptionStateByAgentId);
    const agentOptionState =
        readObjectRecord(agentOptionStateByAgentId?.[targetKey])
        ?? readObjectRecord(agentOptionStateByAgentId?.[params.agentId])
        ?? null;
    const optionStateBindings = parseConnectedServicesBindingsByServiceIdFromAgentOptionState({
        agentOptionState,
    });
    const connectedServicesPayload =
        readObjectRecord(agentOptionState?.connectedServices)
        ?? readObjectRecord(metadata.connectedServices)
        ?? null;
    const payloadBindings = readObjectRecord(connectedServicesPayload?.bindingsByServiceId);

    for (const serviceId of supportedServiceIds) {
        const optionBinding = optionStateBindings[serviceId];
        const payloadBinding = readObjectRecord(payloadBindings?.[serviceId]);
        const source = optionBinding?.source ?? (payloadBinding?.source === 'connected' ? 'connected' : payloadBinding?.source === 'native' ? 'native' : null);
        if (source !== 'connected') continue;
        const binding = resolveBindingProfileId({
            optionBinding,
            payloadBinding,
            accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2,
            serviceId,
        });
        if (!binding) continue;
        const credentialHealthStatus = resolveProfileCredentialHealthStatus({
            services: params.accountProfileConnectedServicesV2,
            serviceId,
            profileId: binding.profileId,
            ...(binding.groupId ? { groupId: binding.groupId } : {}),
        });
        return {
            serviceId,
            profileId: binding.profileId,
            ...(binding.groupId ? { groupId: binding.groupId } : {}),
            ...(credentialHealthStatus ? { credentialHealthStatus } : {}),
            provenance: binding.selection === 'group' ? 'connected_binding_group' : 'connected_binding_profile',
        };
    }

    return null;
}
