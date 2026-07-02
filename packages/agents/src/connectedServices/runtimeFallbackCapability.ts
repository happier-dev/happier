import type { AgentCore, AgentId, AgentSessionAuthSwitchTransition, ConnectedServiceId } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';

export type ConnectedServiceRuntimeFallbackCapability = Readonly<{
    groupConfigurationSupported: boolean;
    runtimeFallbackSupported: boolean;
    groupConfigurationSupportingAgentIds: ReadonlyArray<AgentId>;
    runtimeFallbackSupportingAgentIds: ReadonlyArray<AgentId>;
}>;

export function supportsAgentConnectedServiceSessionAuthSwitchTransition(input: Readonly<{
    agentCore: AgentCore;
    serviceId: ConnectedServiceId;
    transition: AgentSessionAuthSwitchTransition;
}>): boolean {
    const switchCapability = input.agentCore.connectedServices?.sessionAuthSwitch;
    if (!switchCapability?.continuityMode) {
        return false;
    }
    const supportedTransitions = switchCapability.supportedTransitions;
    if (!supportedTransitions || supportedTransitions.includes(input.transition)) {
        return true;
    }

    const stateSharingRequired = switchCapability.providerStateSharingRequired;
    if (!stateSharingRequired?.supportedTransitions.includes(input.transition)) {
        return false;
    }
    const serviceIds = stateSharingRequired.serviceIds;
    return !serviceIds || serviceIds.includes(input.serviceId);
}

export function resolveConnectedServiceRuntimeFallbackCapability(
    serviceId: ConnectedServiceId,
): ConnectedServiceRuntimeFallbackCapability {
    const groupConfigurationSupportingAgentIds = new Set<AgentId>();
    const runtimeFallbackSupportingAgentIds = new Set<AgentId>();

    for (const [agentId, agentCore] of Object.entries(AGENTS_CORE) as Array<[AgentId, AgentCore]>) {
        const supportedServiceIds = agentCore.connectedServices?.supportedServiceIds;
        if (!supportedServiceIds?.some((supportedServiceId) => supportedServiceId === serviceId)) {
            continue;
        }
        const sameConnectedGroupSupported = supportsAgentConnectedServiceSessionAuthSwitchTransition({
            agentCore,
            serviceId,
            transition: 'same_connected_group',
        });
        const connectedToConnectedSupported = supportsAgentConnectedServiceSessionAuthSwitchTransition({
            agentCore,
            serviceId,
            transition: 'connected_to_connected',
        });

        if (sameConnectedGroupSupported || connectedToConnectedSupported) {
            groupConfigurationSupportingAgentIds.add(agentId);
        }
        if (sameConnectedGroupSupported) {
            runtimeFallbackSupportingAgentIds.add(agentId);
        }
    }

    return {
        groupConfigurationSupported: groupConfigurationSupportingAgentIds.size > 0,
        runtimeFallbackSupported: runtimeFallbackSupportingAgentIds.size > 0,
        groupConfigurationSupportingAgentIds: Array.from(groupConfigurationSupportingAgentIds),
        runtimeFallbackSupportingAgentIds: Array.from(runtimeFallbackSupportingAgentIds),
    };
}

export function isConnectedServiceAccountGroupConfigurationSupported(serviceId: ConnectedServiceId): boolean {
    return resolveConnectedServiceRuntimeFallbackCapability(serviceId).groupConfigurationSupported;
}

export function isConnectedServiceRuntimeFallbackSupported(serviceId: ConnectedServiceId): boolean {
    return resolveConnectedServiceRuntimeFallbackCapability(serviceId).runtimeFallbackSupported;
}
