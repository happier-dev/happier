import { getAgentCore, type AgentId } from '@happier-dev/agents';

import type { AgentCoreConfig } from './registryCore';

export function buildAgentConnectedServicesUiConfig(params: Readonly<{
    agentId: AgentId;
}>): AgentCoreConfig['connectedServices'] {
    return getAgentCore(params.agentId).connectedServices ?? null;
}
