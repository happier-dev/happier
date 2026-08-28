import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import {
    DEFAULT_AGENT_ID,
    isBundledAgentId,
    resolveBundledAgentIdFromContributionIdentity,
    type AgentId,
} from '@/agents/catalog/catalog';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';

export function resolveNewSessionCompatAgentType(params: Readonly<{
    backendTarget?: PersistedBackendTargetRefV2 | null;
    persistedAgentId: unknown;
    selectedBuiltInAgentId: unknown;
}>): AgentId {
    const selectedBuiltInAgentId = isBundledAgentId(params.selectedBuiltInAgentId)
        ? params.selectedBuiltInAgentId
        : (isBundledAgentId(params.persistedAgentId) ? params.persistedAgentId : DEFAULT_AGENT_ID);

    if (params.backendTarget?.kind === 'agent') {
        return resolveBundledAgentIdFromContributionIdentity(params.backendTarget.identity)
            ?? selectedBuiltInAgentId;
    }
    return resolvePersistedAgentIdForBackendTarget({
        backendTarget: params.backendTarget ?? null,
        persistedAgentId: params.persistedAgentId,
        selectedBuiltInAgentId,
    });
}
