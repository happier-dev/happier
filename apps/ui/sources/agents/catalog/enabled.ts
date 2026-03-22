import { buildBackendTargetKey } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/registry/registryCore';
import { AGENT_IDS } from '@/agents/registry/registryCore';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): boolean {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: params.agentId });
    return params.backendEnabledByTargetKey?.[targetKey] !== false;
}

export function getEnabledAgentIds(params: {
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): AgentId[] {
    return AGENT_IDS.filter((agentId) =>
        isAgentEnabled({ agentId, backendEnabledByTargetKey: params.backendEnabledByTargetKey }),
    );
}
