import type { BundledAgentId } from '@/agents/catalog/catalog';
import { getAgentCliRuntimeSpec, getAgentLocalCliConfig, getProviderCliInstallGuideUrl } from '@happier-dev/agents';

import { createAgentLocalAuthPluginFromLaunches } from './createAgentLocalAuthPluginFromLaunches';
import type { AgentLocalAuthPlugin } from './agentLocalAuthPlugin';

export function createCatalogAgentLocalAuthPlugin(agentId: BundledAgentId): AgentLocalAuthPlugin {
    const config = getAgentLocalCliConfig(agentId);
    const loginLaunches = (config.authLaunches
        ?? (config.loginLaunch ? [{ ...config.loginLaunch, kind: 'primary' as const }] : []))
        .map((launch) => ({ ...launch, fallbackCommand: launch.command }));
    return createAgentLocalAuthPluginFromLaunches({
        agentId,
        support: config.supportKind,
        docsUrl: getProviderCliInstallGuideUrl(agentId) ?? undefined,
        fallbackCommand: loginLaunches[0]?.command
            ?? getAgentCliRuntimeSpec(agentId).binaryName
            ?? config.detectKey,
        loginLaunches,
    });
}
