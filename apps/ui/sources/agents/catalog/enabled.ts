import type { AgentId } from '@/agents/registry/registryCore';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): boolean {
    const targetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: params.agentId });
    return params.backendEnabledByTargetKey?.[targetKey] !== false;
}

export function getEnabledAgentIds(params: {
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): AgentId[] {
    return CANONICAL_AGENT_IDS.filter((agentId) =>
        isAgentEnabled({ agentId, backendEnabledByTargetKey: params.backendEnabledByTargetKey }),
    );
}
