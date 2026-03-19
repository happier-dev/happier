import { AGENT_IDS, type AgentId } from '@/agents/catalog/catalog';
import type { ProviderLocalAuthPlugin } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { createCatalogProviderLocalAuthPlugin } from '@/agents/providers/shared/createCatalogProviderLocalAuthPlugin';

export const PROVIDER_LOCAL_AUTH_PLUGINS: readonly ProviderLocalAuthPlugin[] = AGENT_IDS.map((agentId) =>
    createCatalogProviderLocalAuthPlugin(agentId),
);

export function getProviderLocalAuthPlugin(providerId: AgentId): ProviderLocalAuthPlugin | null {
    const normalized = String(providerId ?? '').trim().toLowerCase();
    if (!normalized) return null;
    return PROVIDER_LOCAL_AUTH_PLUGINS.find((plugin) => String(plugin.providerId ?? '').trim().toLowerCase() === normalized) ?? null;
}
