import * as agents from '@happier-dev/agents';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

type AgentId = agents.AgentId;

export function listAgentUniverseIds(): readonly AgentId[] {
    // Some Vitest tests mock `@happier-dev/agents` with a minimal export set and omit
    // `getAllAgentCatalogDefinitions`. Accessing a missing export on a Vitest mock throws, so
    // we must check export presence before reading/calling it.
    if ('getAllAgentCatalogDefinitions' in agents) {
        const maybeGetAllProviderDefinitions = (agents as unknown as {
            getAllAgentCatalogDefinitions?: () => readonly { id: string }[];
        }).getAllAgentCatalogDefinitions;

        if (typeof maybeGetAllProviderDefinitions === 'function') {
            try {
                const definitions = maybeGetAllProviderDefinitions();
                if (Array.isArray(definitions) && definitions.length > 0) {
                    const ids = definitions
                        .map((definition) => typeof definition?.id === 'string' ? definition.id.trim() : '')
                        .filter((id) => id.length > 0);
                    if (ids.length > 0) return ids as unknown as readonly AgentId[];
                }
            } catch {
                // Fall back to AGENT_IDS below.
            }
        }
    }

    return agents.AGENT_IDS;
}

export function buildAgentUniverseBackendTargetKey(id: string): string {
    const normalizedId = id.trim();
    return resolveBackendTargetKeyV2({
        kind: 'backend',
        backendId: normalizedId,
    });
}
