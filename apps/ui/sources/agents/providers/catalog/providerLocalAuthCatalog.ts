import type { ProviderLocalAuthPlugin } from '@/agents/providers/shared/providerLocalAuthPlugin';
import { createCatalogProviderLocalAuthPlugin } from '@/agents/providers/shared/createCatalogProviderLocalAuthPlugin';
import { CANONICAL_AGENT_IDS, type AgentId } from '@/agents/registry/registryCore';

export const PROVIDER_LOCAL_AUTH_PLUGINS: readonly ProviderLocalAuthPlugin[] = (CANONICAL_AGENT_IDS as readonly AgentId[])
    .map((providerId) => createCatalogProviderLocalAuthPlugin(providerId));

export function getProviderLocalAuthPlugin(providerId: string | null | undefined): ProviderLocalAuthPlugin | null {
    const normalized = String(providerId ?? '').trim().toLowerCase();
    if (!normalized) return null;
    return PROVIDER_LOCAL_AUTH_PLUGINS.find((plugin) => String(plugin.providerId ?? '').trim().toLowerCase() === normalized) ?? null;
}
