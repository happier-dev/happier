import { definePluginProjectionFamilyV2 } from '@/plugins/projection/families';
import {
    claimPluginMcpToolNamespace,
    claimPluginMcpToolNamespacePrefix,
    createPluginMcpToolNamespaceRegistry,
} from '@/mcp/pluginMcpToolNamespaces';

export const mcpProjectionFamily = definePluginProjectionFamilyV2({
    family: 'mcp',
    project({ registry }) {
        const toolNamespaceRegistry = createPluginMcpToolNamespaceRegistry();
        for (const client of registry.mcpBackendClients ?? []) {
            if (!client.pluginId) {
                throw new Error(`MCP backend-client namespace claim requires plugin ownership for '${client.definition.id}'`);
            }
            claimPluginMcpToolNamespacePrefix(toolNamespaceRegistry, {
                pluginId: client.pluginId,
                registrationId: client.definition.id,
                namespace: client.definition.toolNamespace,
            });
        }
        for (const tool of registry.mcpTools ?? []) {
            if (!tool.pluginId) {
                throw new Error(`MCP tool namespace claim requires plugin ownership for '${tool.definition.id}'`);
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
