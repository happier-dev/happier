import type { CliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import type { RegistryUpdateTrackerV1 } from '@/registries/updates/registryUpdateTracker';
import { McpServerCatalogUnavailableError } from './readMcpServersSettingsFromAccountSettings';

/** Upstream observations share the catalog's existing admission and row CAS. */
export function createMcpRegistryUpdateTracker(input: Readonly<{
  store: Pick<CliMcpServerStore, 'readCatalogForOperation' | 'recordRegistryUpstream'>;
}>): RegistryUpdateTrackerV1 {
  const readCatalog = async () => {
    const snapshot = await input.store.readCatalogForOperation();
    if (snapshot.status !== 'ready') throw new McpServerCatalogUnavailableError(
      snapshot.status === 'unavailable' ? snapshot.reason : snapshot.status);
    if (snapshot.authority !== 'active') {
      throw new McpServerCatalogUnavailableError('authority-not-confirmed');
    }
    return snapshot;
  };
  return {
    kind: 'mcpServer',
    async list(keys) {
      if (keys?.length === 0) return [];
      const selected = keys ? new Set(keys) : undefined;
      const snapshot = await readCatalog();
      return snapshot.catalog.servers.flatMap(entry => (!selected || selected.has(entry.id)) && entry.origin?.kind === 'registry' ? [{
        key: entry.id, provenance: entry.origin.provenance,
        ...(entry.origin.upstream ? { upstream: entry.origin.upstream } : {}),
      }] : []);
    },
    record: input.store.recordRegistryUpstream,
  };
}
