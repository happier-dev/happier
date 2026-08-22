import type { AgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthPlugin';
import { createCatalogAgentLocalAuthPlugin } from '@/agents/catalog/localAuth/createCatalogAgentLocalAuthPlugin';
import { CANONICAL_AGENT_IDS } from '@/agents/registry/registryCore';

export const AGENT_LOCAL_AUTH_PLUGINS: readonly AgentLocalAuthPlugin[] = CANONICAL_AGENT_IDS
    .map((agentId) => createCatalogAgentLocalAuthPlugin(agentId));

export function getAgentLocalAuthPlugin(agentId: string | null | undefined): AgentLocalAuthPlugin | null {
    const normalized = String(agentId ?? '').trim().toLowerCase();
    if (!normalized) return null;
    return AGENT_LOCAL_AUTH_PLUGINS.find((plugin) => String(plugin.agentId ?? '').trim().toLowerCase() === normalized) ?? null;
}
