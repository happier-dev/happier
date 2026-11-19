import { PluginMcpServerContributionV1Schema } from '../../plugins/contributions/mcp.js';
import type { PluginProjectionV2 } from '../../daemon/contributionRegistryProjection.js';
import { parseMcpPluginItemIdV1, projectMcpPluginItemMetadataV1, type McpPluginItemMetadataV1 } from './settingsV1.js';

export function mcpPluginServerProjectionKeyV1(ref: Readonly<{ pluginId: string; localId: string }>): string {
  return `server:${ref.pluginId}/${ref.localId}`;
}

/** Declaration admission stays out of the Account settings schema's module graph. */
export function readMcpPluginItemMetadataFromProjectionV1(projection: PluginProjectionV2, serverId?: string): readonly McpPluginItemMetadataV1[] {
  const family = projection.familiesById.mcp;
  if (!family) return [];
  const target = serverId === undefined ? null : parseMcpPluginItemIdV1(serverId);
  if (serverId !== undefined && !target) return [];
  const entry = target ? family.entriesById[mcpPluginServerProjectionKeyV1(target)] : undefined;
  const entries = target ? (entry ? [entry] : []) : Object.values(family.entriesById);
  return entries.flatMap(entry => {
    if (entry.contributionKind !== 'server' || !entry.pluginId || projection.installedPackagesById[entry.pluginId]?.enabled === false) return [];
    const server = PluginMcpServerContributionV1Schema.parse({ id: entry.localId, title: entry.title,
      ...(entry.description ? { description: entry.description } : {}), kind: entry.kind,
      ...(entry.transport ? { transport: entry.transport } : {}), ...(entry.sessionScope ? { sessionScope: entry.sessionScope } : {}) });
    return [projectMcpPluginItemMetadataV1({ pluginId: entry.pluginId,
      pluginName: projection.installedPackagesById[entry.pluginId]?.displayName ?? entry.pluginId, server })];
  });
}
