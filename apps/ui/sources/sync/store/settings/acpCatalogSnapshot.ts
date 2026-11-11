import type { AcpCatalogRecordV1, AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AcpCatalogCleanupV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';
import { ACP_REGISTRY_ICONS_MONOCHROME_V1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import { admitCatalogBrandMark } from '@/components/ui/media/catalogBrandMark';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

export type AcpCatalogSnapshot = Readonly<{ scope: ServerAccountScope; catalog: AcpCatalogSnapshotV1; data: AcpCatalogRecordV1 | null;
    revision: number | 'absent'; stale: boolean; cleanup?: AcpCatalogCleanupV1;
    brandMarks?: Readonly<Record<string, HostCatalogMark>> }>;
const snapshots = new Map<string, AcpCatalogSnapshot>();
const listeners = new Set<() => void>();
const loading: AcpCatalogSnapshotV1 = Object.freeze({ status: 'loading' });
function projectBrandMarks(record: AcpCatalogRecordV1 | null, previous: AcpCatalogSnapshot | null) {
    if (!record) return undefined;
    if (record === previous?.data && previous.brandMarks) return previous.brandMarks;
    return Object.fromEntries(record.definitions.map(definition => [definition.id, admitCatalogBrandMark({
        displayName: definition.title || definition.name,
        iconUrl: definition.origin?.kind === 'registry' ? definition.origin.iconUrl : undefined,
        // A registry origin is written only by the ACP Registry mapper, whose icons are declared single-colour.
        iconMonochrome: definition.origin?.kind === 'registry' && ACP_REGISTRY_ICONS_MONOCHROME_V1,
    }, previous?.brandMarks?.[definition.id])]));
}
export function subscribeAcpCatalogSnapshots(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getAcpCatalogSnapshot(scope: ServerAccountScope | null | undefined): AcpCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
export function applyAcknowledgedAcpCatalog(scope: ServerAccountScope, record: AcpCatalogRecordV1, revision: number, current: boolean): void {
    const previous = getAcpCatalogSnapshot(scope);
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: previous?.revision })) return;
    const next: AcpCatalogSnapshot = { scope, catalog: loading, data: record, revision, stale: true,
        brandMarks: projectBrandMarks(record, previous),
        ...(previous?.cleanup ? { cleanup: previous.cleanup } : {}) };
    if (previous && sameStrictJsonValue(previous, next)) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), next);
    for (const listener of [...listeners]) listener();
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
export function applyAcpCatalogSnapshot(scope: ServerAccountScope, catalog: AcpCatalogSnapshotV1, current: boolean,
    cleanup?: AcpCatalogCleanupV1, staleRead = false): void {
    if (!current || catalog.status === 'unavailable' && catalog.reason === 'scope-retired') return;
    const previous = getAcpCatalogSnapshot(scope);
    if ('revision' in catalog && typeof catalog.revision === 'number'
        && !canPublishCatalogReceipt({ current, revision: catalog.revision, retainedRevision: previous?.revision })) return;
    const withdraw = catalog.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized',
        'forbidden', 'account-not-found', 'account-inconsistent', 'invalid-stored-content', 'catalog-deleted', 'source-transfer-required'].includes(catalog.reason);
    let data = withdraw ? null : previous?.data ?? null;
    if (catalog.status === 'ready' || catalog.status === 'partial') {
        if (!canPublishCatalogReceipt({ current, revision: catalog.revision, retainedRevision: previous?.revision })) return;
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
    const revision = retainCatalogRevision(catalog, previous?.revision);
    if (staleRead && (catalog.status === 'ready' || catalog.status === 'partial')) catalog = loading;
    if (previous && JSON.stringify(previous.catalog) === JSON.stringify(catalog)) catalog = previous.catalog;
    const stale = catalog.status !== 'ready';
    const retainedCleanup = cleanup ?? previous?.cleanup;
    if (previous?.catalog === catalog && previous.data === data && previous.stale === stale && previous.revision === revision
        && JSON.stringify(previous.cleanup) === JSON.stringify(retainedCleanup)) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), Object.freeze({ scope, catalog, data, stale,
        brandMarks: projectBrandMarks(data, previous),
        revision,
        ...(retainedCleanup ? { cleanup: retainedCleanup } : {}) }));
    for (const listener of [...listeners]) listener();
}
export function beginAcpCatalogLoad(scope: ServerAccountScope): void { applyAcpCatalogSnapshot(scope, loading, true); }
export function invalidateAcpCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginAcpCatalogLoad(snapshot.scope);
}
export function resetAcpCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
