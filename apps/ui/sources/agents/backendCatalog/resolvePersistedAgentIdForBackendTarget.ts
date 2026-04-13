import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { isAgentId } from '@/agents/catalog/catalog';

export function resolvePersistedAgentIdForBackendTarget(params: Readonly<{
    backendTarget?: BackendTargetRefV1 | null;
    persistedAgentId: unknown;
    selectedBuiltInAgentId: AgentId;
}>): AgentId {
    if (params.backendTarget?.kind === 'builtInAgent' && isAgentId(params.backendTarget.agentId)) {
        return params.backendTarget.agentId;
    }

    if (
        params.backendTarget?.kind === 'configuredAcpBackend'
        && isAgentId(params.persistedAgentId)
        && params.persistedAgentId !== 'customAcp'
    ) {
        // Keep a concrete built-in fallback while backendTarget remains the canonical configured-backend identity.
        return params.persistedAgentId;
    }

    return params.selectedBuiltInAgentId;
}
