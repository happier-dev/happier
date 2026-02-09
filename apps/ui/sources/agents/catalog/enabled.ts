import type { AgentId } from '@/agents/registry/registryCore';
import { AGENT_IDS } from '@/agents/registry/registryCore';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledById: Record<string, boolean> | null | undefined;
}): boolean {
    return params.backendEnabledById?.[params.agentId] !== false;
}

export function getEnabledAgentIds(params: {
    backendEnabledById: Record<string, boolean> | null | undefined;
}): AgentId[] {
    return AGENT_IDS.filter((agentId) =>
        isAgentEnabled({ agentId, backendEnabledById: params.backendEnabledById }),
    );
}
