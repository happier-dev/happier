import type { BundledAgentId } from '@/agents/catalog/catalog';
import { getAgentLocalCliConfig, getProviderCliInstallGuideUrl } from '@happier-dev/agents';

import { createAgentLocalAuthPluginFromLaunches } from './createAgentLocalAuthPluginFromLaunches';
import type { AgentLocalAuthPlugin } from './agentLocalAuthPlugin';

export function createCatalogAgentLocalAuthPlugin(agentId: BundledAgentId): AgentLocalAuthPlugin | null {
    const config = getAgentLocalCliConfig(agentId);
    if (!config) return null;
    const loginLaunches = (config.authLaunches
        ?? (config.loginLaunch ? [{ ...config.loginLaunch, kind: 'primary' as const }] : []));
    return createAgentLocalAuthPluginFromLaunches({
        agentId,
        support: config.supportKind,
        docsUrl: getProviderCliInstallGuideUrl(agentId) ?? undefined,
        loginLaunches,
    });
}
