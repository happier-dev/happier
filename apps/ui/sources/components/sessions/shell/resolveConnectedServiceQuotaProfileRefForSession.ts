import type { AccountProfile } from '@happier-dev/protocol';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { parseConnectedServicesBindingsByServiceIdFromAgentOptionState } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
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
            .filter((profile) => profile.status === 'connected')
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

function resolveBindingProfileId(params: Readonly<{
    optionBinding: unknown;
    payloadBinding: Record<string, unknown> | null;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
    serviceId: string;
}>): string | null {
    const optionBindingRecord = readObjectRecord(params.optionBinding);
    const explicitProfileId =
        readTrimmedString(optionBindingRecord?.profileId)
        ?? readTrimmedString(params.payloadBinding?.profileId);
    if (explicitProfileId) return explicitProfileId;

    const selection =
        readTrimmedString(optionBindingRecord?.selection)
        ?? readTrimmedString(params.payloadBinding?.selection);
    if (selection !== 'group') return null;

    const groupId =
        readTrimmedString(optionBindingRecord?.groupId)
        ?? readTrimmedString(params.payloadBinding?.groupId);
    if (!groupId) return null;

    return resolveActiveGroupProfileId({
        services: params.accountProfileConnectedServicesV2,
        serviceId: params.serviceId,
        groupId,
    });
}

export function resolveConnectedServiceQuotaProfileRefForSession(params: Readonly<{
    metadata: Metadata | null | undefined;
    agentId: string;
    accountProfileConnectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
}>): { serviceId: string; profileId: string } | null {
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
        const profileId = resolveBindingProfileId({
            optionBinding,
            payloadBinding,
            accountProfileConnectedServicesV2: params.accountProfileConnectedServicesV2,
            serviceId,
        });
        if (!profileId) continue;
        return { serviceId, profileId };
    }

    return null;
}
