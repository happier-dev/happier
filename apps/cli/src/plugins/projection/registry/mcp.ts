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
                ...(registry.mcpDiscoverySources ?? []).map((source) => [
                    `discoverySource:${source.definition.id}`,
                    {
                        id: `discoverySource:${source.definition.id}`,
                        pluginId: source.pluginId,
                        contributionKind: 'discoverySource',
                        title: source.definition.title,
                        description: source.definition.description,
                        resultSchema: source.definition.resultSchema,
                        availability: source.definition.availability,
                    },
                ]),
            ]),
        };
    },
});
