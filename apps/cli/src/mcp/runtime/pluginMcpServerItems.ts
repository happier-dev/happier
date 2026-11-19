import { McpServerCatalogEntryV1Schema, parseMcpPluginItemIdV1, projectMcpPluginItemMetadataV1, type McpPluginItemV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type { ResolvedMcpServerContribution } from '@/plugins/projection/registry/types';

/** Dynamic URLs are replaced by the owning hosted attachment before materialization. */
export const UNATTACHED_PLUGIN_MCP_URL = 'http://127.0.0.1';

export async function readPluginMcpServerMetadata(serverId?: string) {
  const target = serverId ? parseMcpPluginItemIdV1(serverId) : null;
  if (serverId && !target) return [];
  const { resolveMergedContributionRegistry } = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
  const registry = await resolveMergedContributionRegistry();
  return (registry.mcpServers ?? []).flatMap(entry => {
    if (!entry.pluginId || (target && (entry.pluginId !== target.pluginId || entry.definition.id !== target.localId))) return [];
    const activation = registry.activationTargets.find(target => target.pluginId === entry.pluginId);
    const displayName = activation?.manifest.displayName;
    return [projectMcpPluginItemMetadataV1({ pluginId: entry.pluginId,
      pluginName: typeof displayName === 'string' ? displayName : displayName?.fallback ?? entry.pluginId,
      server: entry.definition })];
  });
}

export async function projectPluginMcpServerItems(input: Readonly<{
  activePlugins: readonly ResolvedMcpServerContribution[];
  catalog: Pick<McpServerCatalogV1, 'bindings' | 'pluginServers'>;
  resolveExecutable(ref: ManagedExecutableRef, pluginId: string): Promise<Readonly<{
    command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; release?: () => void;
  }>>;
}>): Promise<McpPluginItemV1[]> {
  return Promise.all(input.activePlugins.map(async contribution => {
    if (!contribution.pluginId) throw new Error('Plugin MCP declaration has no owning plugin');
    const { definition, pluginId } = contribution;
    const metadata = projectMcpPluginItemMetadataV1({ pluginId, pluginName: pluginId, server: definition });
    const { id: itemId, name, title, description, remote } = metadata;
    const transport = definition.kind === 'static' ? definition.transport : null;
    const executable = transport?.kind === 'stdio' ? await input.resolveExecutable(transport.executable, pluginId) : null;
    const config = McpServerCatalogEntryV1Schema.parse({ id: itemId, name, title, description,
      transport: executable ? 'stdio' : 'http',
      ...(executable ? { stdio: { command: executable.command, args: [...(executable.args ?? []), ...(transport?.kind === 'stdio' ? transport.args ?? [] : [])] } }
        : { remote: { url: transport?.kind === 'http' ? transport.url : UNATTACHED_PLUGIN_MCP_URL, ...remote, headers: {} } }),
      env: Object.fromEntries(Object.entries(executable?.env ?? {}).map(([key, v]) => [key, { t: 'literal', v }])),
      ...input.catalog.pluginServers?.[itemId], createdAt: 0, updatedAt: 0,
    });
    return { itemId, name, ...(title ? { title } : {}), config,
      rules: input.catalog.bindings.filter(rule => rule.serverId === itemId) };
  }));
}
