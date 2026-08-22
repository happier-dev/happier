import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { DEFAULT_AGENT_ID, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';

export function resolveNewSessionCompatAgentType(params: Readonly<{
    backendTarget?: BackendTargetRefV2 | null;
    persistedAgentId: unknown;
    selectedBuiltInAgentId: unknown;
}>): AgentId {
    const selectedBuiltInAgentId = isBundledAgentId(params.selectedBuiltInAgentId)
        ? params.selectedBuiltInAgentId
        : (isBundledAgentId(params.persistedAgentId) ? params.persistedAgentId : DEFAULT_AGENT_ID);

    return resolvePersistedAgentIdForBackendTarget({
        backendTarget: params.backendTarget ?? null,
        persistedAgentId: params.persistedAgentId,
        selectedBuiltInAgentId,
    });
}
