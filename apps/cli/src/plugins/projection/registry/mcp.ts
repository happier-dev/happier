import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';

export const mcpProjectionFamily = definePluginProjectionFamilyV2({
    family: 'mcp',
    project({ registry }) {
        return {
            family: 'mcp',
            entriesById: Object.fromEntries([
                ...(registry.mcpServers ?? []).map((server) => [
                    `server:${server.definition.id}`,
                    {
                        id: `server:${server.definition.id}`,
                        pluginId: server.pluginId,
                        contributionKind: 'server',
                        name: server.definition.name,
                        transport: server.definition.transport,
                    },
                ]),
                ...(registry.mcpDiscoveryProviders ?? []).map((provider) => [
                    `discoveryProvider:${provider.definition.id}`,
                    {
                        id: `discoveryProvider:${provider.definition.id}`,
                        pluginId: provider.pluginId,
                        contributionKind: 'discoveryProvider',
                        agentId: provider.definition.agentId,
                    },
                ]),
            ]),
        };
    },
});
