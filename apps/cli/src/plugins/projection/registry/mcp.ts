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
                        title: server.definition.title,
                        description: server.definition.description,
                        kind: server.definition.kind,
                        ...('transport' in server.definition ? { transport: server.definition.transport } : {}),
                        sessionScope: server.definition.sessionScope,
                        availability: server.definition.availability,
                    },
                ]),
                ...(registry.mcpDiscoveryProviders ?? []).map((provider) => [
                    `discoveryProvider:${provider.definition.id}`,
                    {
                        id: `discoveryProvider:${provider.definition.id}`,
                        pluginId: provider.pluginId,
                        contributionKind: 'discoveryProvider',
                        title: provider.definition.title,
                        description: provider.definition.description,
                        resultSchema: provider.definition.resultSchema,
                        availability: provider.definition.availability,
                    },
                ]),
            ]),
        };
    },
});
