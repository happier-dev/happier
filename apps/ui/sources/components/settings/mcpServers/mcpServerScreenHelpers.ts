import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { supportsDetectedMcpConfigScan } from '@/agents/registry/registryUiBehavior';

import type { McpDetectedProviderV1 } from '@happier-dev/protocol';

export function listDetectedMcpProviderIds(): readonly McpDetectedProviderV1[] {
    return AGENT_IDS.filter((agentId) => supportsDetectedMcpConfigScan(agentId)) as readonly McpDetectedProviderV1[];
}

export function listMcpPreviewAgentIds(): readonly AgentId[] {
    return AGENT_IDS.filter((agentId) => getAgentCore(agentId).tools.delivery !== 'unsupported') as readonly AgentId[];
}

export function getPreferredMcpPreviewAgentId(
    agentIds: readonly AgentId[],
    currentSelection: string | null | undefined,
): AgentId {
    if (typeof currentSelection === 'string') {
        const normalizedSelection = currentSelection.trim();
        if (agentIds.includes(normalizedSelection as AgentId)) {
            return normalizedSelection as AgentId;
        }
    }

    return agentIds[0] ?? DEFAULT_AGENT_ID;
}
