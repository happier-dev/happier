import { readBackendTargetRefV2, type BackendTargetRefV2Input, type BackendTargetRefV2 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { isBundledAgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from './legacyCompatAgents';

function resolveCanonicalPersistedAgentId(params: Readonly<{
    persistedAgentId: unknown;
    selectedBuiltInAgentId: AgentId;
}>): AgentId {
    if (isBundledAgentId(params.persistedAgentId)) {
        return params.persistedAgentId;
    }
    return params.selectedBuiltInAgentId;
}

export function resolvePersistedAgentIdForBackendTarget(params: Readonly<{
    backendTarget?: BackendTargetRefV2Input | null;
    persistedAgentId: unknown;
    selectedBuiltInAgentId: AgentId;
}>): AgentId {
    let resolvedTarget: BackendTargetRefV2 | null = null;
    if (params.backendTarget) {
        try {
            resolvedTarget = readBackendTargetRefV2(params.backendTarget);
        } catch {
            resolvedTarget = null;
        }
    }

    if (resolvedTarget && isLegacyCompatAgentType(resolvedTarget.backendId)) {
        return resolveCanonicalPersistedAgentId(params);
    }

    if (resolvedTarget && isBundledAgentId(resolvedTarget.backendId)) {
        return resolvedTarget.backendId;
    }

    if (isBundledAgentId(params.persistedAgentId)) {
        return params.persistedAgentId;
    }

    return params.selectedBuiltInAgentId;
}
