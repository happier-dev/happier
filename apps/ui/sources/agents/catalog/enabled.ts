import type { AgentId } from '@/agents/registry/registryCore';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetEnabled,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { getAgentModelConfig } from '@happier-dev/agents';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): boolean {
    const targetKey = buildAgentUniverseBackendTargetKey(params.agentId);
    return readBackendTargetEnabled({
        backendEnabledByTargetKey: params.backendEnabledByTargetKey,
        canonicalTargetKey: targetKey,
        compatibilityTargetKeys: getAgentBackendCompatibilityTargetKeys({
            agentId: params.agentId,
            canonicalTargetKey: targetKey,
        }),
    });
}

export function getEnabledAgentIds(params: {
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): AgentId[] {
    return CANONICAL_AGENT_IDS.filter((agentId) =>
        getAgentModelConfig(agentId).supportsSelection
        && isAgentEnabled({ agentId, backendEnabledByTargetKey: params.backendEnabledByTargetKey }),
    );
}
