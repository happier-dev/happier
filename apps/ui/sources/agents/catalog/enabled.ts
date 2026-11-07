import type { AgentId } from '@/agents/registry/registryCore';
import {
    getAgentBackendCompatibilityTargetKeys,
    readBackendTargetEnabled,
} from '@/agents/backendCatalog/backendTargetEnablement';
import { readAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { isBundledAgentId } from '@happier-dev/agents';
import { listSelectableBundledAgentExecutionTargets } from '@happier-dev/agents/definitions';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';

export function isAgentEnabled(params: {
    agentId: AgentId;
    backendEnabledByTargetKey: Record<string, boolean> | null | undefined;
}): boolean {
    if (isBundledAgentId(params.agentId)
        && listAgentExecutionTargetsV1(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[params.agentId]).length === 0) return false;
    const targetKey = readAgentUniverseBackendTargetKey(params.agentId);
    if (targetKey === null) return false;
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
    return listSelectableBundledAgentExecutionTargets().map(entry => entry.agentId)
        .filter(agentId => isAgentEnabled({ agentId, backendEnabledByTargetKey: params.backendEnabledByTargetKey }));
}
