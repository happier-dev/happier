import { readMcpServersFromCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServersSettingsV1 } from '@happier-dev/protocol';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export class McpServerCatalogUnavailableError extends Error {
  readonly code = 'mcp_catalog_unavailable';
  constructor(readonly reason: string) {
    super('MCP server catalog is unavailable');
    this.name = 'McpServerCatalogUnavailableError';
  }
}

/** Runtime admission never falls back to a retained Settings root. */
export function readMcpServersSettingsFromAccountSettings(snapshot: ActiveAccountSettingsSnapshot | null): McpServersSettingsV1 {
  if (!snapshot?.mcpServerCatalog) throw new McpServerCatalogUnavailableError('catalog-unobserved');
  const read = readMcpServersFromCatalogSnapshotV1({ snapshot: snapshot.mcpServerCatalog,
    strictMode: snapshot.settings.mcpServersStrictMode === true });
  if (read.status !== 'ready') throw new McpServerCatalogUnavailableError(read.reason);
  return read.settings;
}
