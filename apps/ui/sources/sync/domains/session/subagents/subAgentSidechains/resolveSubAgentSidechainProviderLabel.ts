import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';

export function resolveSubAgentSidechainProviderLabel(flavor: string | null | undefined): string | null {
    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;
    const raw = t(getAgentCore(agentId).displayNameKey);
    const label = typeof raw === 'string' ? raw.trim() : '';
    return label || null;
}
