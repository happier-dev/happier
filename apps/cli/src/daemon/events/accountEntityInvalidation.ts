import { isDeepStrictEqual } from 'node:util';
import type { UpdateBody } from '@happier-dev/protocol/updates';
import { PluginDomainDataKvChangeHintSchema } from '@happier-dev/protocol/changes/pluginDomainDataKv';
import { AccountKvChangeHintV1Schema } from '@happier-dev/protocol/changes/accountKv';
import type { HostEventEnvelopeV1 } from '@happier-dev/protocol';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { artifactKindsMayIncludeKindV1, readArtifactKindsChangeHintV1 } from '@happier-dev/protocol/changes';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

/** Forward committed row addresses only. Each retained-fact source selects its
 * own row and reads the fact through that row's existing authorized Action. */
export function projectAccountEntitiesInvalidationForHost(body: Extract<UpdateBody, { t: 'account-change' }>,
    mcpCatalogs?: Readonly<{ previous?: McpServerCatalogSnapshotV1; next?: McpServerCatalogSnapshotV1 }>):
    HostEventEnvelopeV1<'@happier/account/entities-invalidated'> | null {
    const entityIds = new Set(body.entityIds ?? []);
    const dataKvChanges: NonNullable<HostEventEnvelopeV1<'@happier/account/entities-invalidated'>['payload']['dataKvChanges']> = [];
    const accountKvChanges: NonNullable<HostEventEnvelopeV1<'@happier/account/entities-invalidated'>['payload']['accountKvChanges']> = [];
    const reviewIds = new Set<string>();
    for (const row of body.rows?.page.changes ?? []) {
        if (row.kind === 'pluginDomain') {
            const hint = PluginDomainDataKvChangeHintSchema.safeParse(row.hint);
            if (hint.success) dataKvChanges.push(hint.data);
        } else if (row.kind === 'kv') {
            const hint = AccountKvChangeHintV1Schema.safeParse(row.hint);
            if (hint.success) accountKvChanges.push(hint.data);
        } else if (row.kind === 'artifact' && artifactKindsMayIncludeKindV1(
            readArtifactKindsChangeHintV1(row.hint), [REVIEW_ARTIFACT_KIND_V1])) {
            reviewIds.add(row.entityId);
        }
    }
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
    return entityIds.size || dataKvChanges.length || accountKvChanges.length || reviewIds.size
        ? { eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' }, payload: {
            entityIds: [...entityIds], ...(dataKvChanges.length ? { dataKvChanges } : {}),
            ...(accountKvChanges.length ? { accountKvChanges } : {}),
            ...(reviewIds.size ? { reviewIds: [...reviewIds] } : {}),
        } } : null;
}
