import { isDeepStrictEqual } from 'node:util';
import type { UpdateBody } from '@happier-dev/protocol/updates';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

/** Forward committed row addresses only. Each retained-fact source selects its
 * own row and reads the fact through that row's existing authorized Action. */
export function projectAccountEntitiesInvalidationForHost(body: Extract<UpdateBody, { t: 'account-change' }>,
    mcpCatalogs?: Readonly<{ previous?: McpServerCatalogSnapshotV1; next?: McpServerCatalogSnapshotV1 }>):
    HostEventEnvelopeV1<'@happier/account/entities-invalidated'> | null {
    const entityIds = new Set(body.entityIds ?? []);
    if (mcpCatalogs && entityIds.delete(MCP_SERVER_CATALOG_ACCOUNT_KEY_V1)) {
        // The catalog publication already owns both decrypted snapshots. Route
        // its changed upstream facts once, rather than rereading every watcher.
        const origins = (snapshot: McpServerCatalogSnapshotV1 | undefined) => new Map(
            snapshot?.status === 'ready' && snapshot.authority === 'active'
                ? snapshot.catalog.servers.map(server => [server.id, server.origin] as const) : []);
        const previous = origins(mcpCatalogs.previous);
        const next = origins(mcpCatalogs.next);
        for (const id of new Set([...previous.keys(), ...next.keys()])) {
            if (!previous.has(id) || !next.has(id) || !isDeepStrictEqual(previous.get(id), next.get(id))) entityIds.add(id);
        }
    }
    return entityIds.size ? { eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: { entityIds: [...entityIds] } } : null;
}
