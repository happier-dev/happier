import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { createPluginMcpToolNamespaceRegistry, claimPluginMcpToolNamespace } from '@/mcp/pluginMcpToolNamespaces';

export const mcpProjectionFamily = definePluginProjectionFamilyV2({
    family: 'mcp',
    project({ registry }) {
        const toolNamespaceRegistry = createPluginMcpToolNamespaceRegistry();
        for (const tool of registry.mcpTools ?? []) {
            if (!tool.pluginId) {
                continue;
            }
            claimPluginMcpToolNamespace(toolNamespaceRegistry, {
                pluginId: tool.pluginId,
                registrationId: tool.definition.id,
                toolName: tool.definition.name,
            });
        }

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
                ...(registry.mcpBackendClients ?? []).map((client) => [
                    `backendClient:${client.definition.id}`,
                    {
                        id: `backendClient:${client.definition.id}`,
                        pluginId: client.pluginId,
                        contributionKind: 'backendClient',
                        serverName: client.definition.serverName,
                        toolNamespace: client.definition.toolNamespace,
                    },
                ]),
                ...(registry.mcpTools ?? []).map((tool) => [
                    `tool:${tool.definition.id}`,
                    {
                        id: `tool:${tool.definition.id}`,
                        pluginId: tool.pluginId,
                        contributionKind: 'tool',
                        name: tool.definition.name,
                    },
                ]),
                ...(registry.mcpDiscoveryProviders ?? []).map((provider) => [
                    `discoveryProvider:${provider.definition.id}`,
                    {
                        id: `discoveryProvider:${provider.definition.id}`,
                        pluginId: provider.pluginId,
                        contributionKind: 'discoveryProvider',
                        providerId: provider.definition.providerId,
                    },
                ]),
            ]),
        };
    },
});
