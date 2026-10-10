import type { AcpCatalogRecordV1, AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type AcpCatalogSnapshot = Readonly<{ scope: ServerAccountScope; catalog: AcpCatalogSnapshotV1; data: AcpCatalogRecordV1 | null; stale: boolean }>;
const snapshots = new Map<string, AcpCatalogSnapshot>();
const listeners = new Set<() => void>();
const loading: AcpCatalogSnapshotV1 = Object.freeze({ status: 'loading' });
export function subscribeAcpCatalogSnapshots(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getAcpCatalogSnapshot(scope: ServerAccountScope | null | undefined): AcpCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
/** A captured nonfocused read stands alone; observed domain refreshes withdraw older facts. */
export function isAcpCatalogCaptureCurrent(scope: ServerAccountScope,
    captured: Extract<AcpCatalogSnapshotV1, { status: 'ready' }>): boolean {
    const projected = getAcpCatalogSnapshot(scope);
    if (!projected) return true;
    const current = projected.catalog;
    return !projected.stale && current.status === 'ready' && current.revision === captured.revision
        && (captured.revision !== 'absent' || current.revision === 'absent'
            && current.source === captured.source && current.sourceSettingsVersion === captured.sourceSettingsVersion);
}
export function applyAcpCatalogSnapshot(scope: ServerAccountScope, catalog: AcpCatalogSnapshotV1, current: boolean): void {
    if (!current || catalog.status === 'unavailable' && catalog.reason === 'scope-retired') return;
    const previous = getAcpCatalogSnapshot(scope);
    const withdraw = catalog.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized',
        'forbidden', 'account-not-found', 'account-inconsistent', 'invalid-stored-content', 'catalog-deleted', 'source-transfer-required'].includes(catalog.reason);
    let data = withdraw ? null : previous?.data ?? null;
    if (catalog.status === 'ready' || catalog.status === 'partial') {
        const oldDefinitions = new Map(previous?.data?.definitions.map(definition => [definition.id, definition]) ?? []);
        const definitions = catalog.record.definitions.map(definition => {
            const old = oldDefinitions.get(definition.id);
            return old && JSON.stringify(old) === JSON.stringify(definition) ? old : definition;
        });
        data = previous?.data && previous.data.definitions.length === definitions.length
            && definitions.every((definition, index) => definition === previous.data!.definitions[index])
            ? previous.data : { ...catalog.record, definitions };
        catalog = { ...catalog, record: data };
    }
    if (previous && JSON.stringify(previous.catalog) === JSON.stringify(catalog)) catalog = previous.catalog;
    const stale = catalog.status !== 'ready';
    if (previous?.catalog === catalog && previous.data === data && previous.stale === stale) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), Object.freeze({ scope, catalog, data, stale }));
    for (const listener of [...listeners]) listener();
}
export function beginAcpCatalogLoad(scope: ServerAccountScope): void { applyAcpCatalogSnapshot(scope, loading, true); }
export function invalidateAcpCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginAcpCatalogLoad(snapshot.scope);
}
export function resetAcpCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
