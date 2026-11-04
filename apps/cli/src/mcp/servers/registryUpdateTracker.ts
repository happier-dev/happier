import { isDeepStrictEqual } from 'node:util';
import { registryUpstreamEqualV1 } from '@happier-dev/protocol/registries';
import type { CliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import type { RegistryUpdateTrackerV1 } from '@/registries/updates/registryUpdateTracker';
import { McpServerCatalogUnavailableError } from './readMcpServersSettingsFromAccountSettings';

/** Upstream observations share the catalog's existing admission and row CAS. */
export function createMcpRegistryUpdateTracker(input: Readonly<{
  store: Pick<CliMcpServerStore, 'readCatalogForOperation' | 'mutate'>;
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
    async list() {
      const snapshot = await readCatalog();
      return snapshot.catalog.servers.flatMap(entry => entry.origin?.kind === 'registry' ? [{
        key: entry.id, provenance: entry.origin.provenance,
        ...(entry.origin.upstream ? { upstream: entry.origin.upstream } : {}),
      }] : []);
    },
    async record(changes) {
      for (const change of changes) {
        const snapshot = await readCatalog();
        const entry = snapshot.catalog.servers.find(server => server.id === change.key);
        if (entry?.origin?.kind !== 'registry'
          || change.provenance && !isDeepStrictEqual(entry.origin.provenance, change.provenance)
          || registryUpstreamEqualV1(entry.origin.upstream, change.upstream)) continue;
        const receipt = await input.store.mutate({ kind: 'server-update', entry: {
          ...entry, origin: { ...entry.origin, upstream: change.upstream,
            // Distinct committed transitions need distinct replay identities,
            // including two observations in one clock tick or a clock rollback.
            upstreamObservedAt: Math.max(Date.now(), (entry.origin.upstreamObservedAt ?? -1) + 1) },
        } }, snapshot.revision, snapshot);
        if (receipt.status === 'updated') continue;
        if (receipt.status === 'conflict') {
          // Another daemon may have recorded this exact observation. Re-read
          // through the same owner; never replay a whole entry over its edits.
          const current = (await readCatalog()).catalog.servers.find(server => server.id === change.key);
          if (current?.origin?.kind !== 'registry'
            || change.provenance && !isDeepStrictEqual(current.origin.provenance, change.provenance)
            || registryUpstreamEqualV1(current.origin.upstream, change.upstream)) continue;
        }
        throw Object.assign(new Error('MCP registry update observation was not recorded'), {
          code: `mcp_registry_update_${receipt.status}`, receipt,
        });
      }
    },
  };
}
