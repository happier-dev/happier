import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';

export function resolveSubAgentSidechainProviderLabel(flavor: string | null | undefined): string | null {
    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;
    const raw = resolveAgentCatalogTitle(agentId);
    const label = typeof raw === 'string' ? raw.trim() : '';
    return label || null;
}
