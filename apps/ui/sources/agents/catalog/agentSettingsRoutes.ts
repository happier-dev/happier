import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';

export function createPluginAgentSettingsRoute(agent: PluginContributionIdentityV1): string {
    return `/(app)/settings/agents/${encodeURIComponent(agent.localId)}?pluginId=${encodeURIComponent(agent.pluginId)}`;
}
