import type { ConnectedAccountCatalogDiagnosticV1, ConnectedAccountCatalogKeyV1, ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type ConnectedAccountCatalogValue<K extends ConnectedAccountCatalogKeyV1> = Extract<ConnectedAccountCatalogRecordV1, { key: K }>['value'];
export type ConnectedAccountCatalogValueSnapshot<K extends ConnectedAccountCatalogKeyV1> = Readonly<{
    status: 'loading' | 'ready' | 'partial' | 'unavailable'; value: ConnectedAccountCatalogValue<K> | null;
    revision: number | 'absent'; stale: boolean; reason?: string;
    diagnostics?: readonly ConnectedAccountCatalogDiagnosticV1[];
}>;
type StoredSnapshot = Readonly<{ scope: ServerAccountScope; key: ConnectedAccountCatalogKeyV1;
    catalog: ConnectedAccountCatalogSnapshotV1; value: ConnectedAccountCatalogValueSnapshot<ConnectedAccountCatalogKeyV1> }>;
const snapshots = new Map<string, StoredSnapshot>();
const listeners = new Set<() => void>();
const loading = Object.freeze({ status: 'loading', value: null, revision: 'absent', stale: true } as const);
const snapshotKey = (scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1) => `${serverAccountScopeKeySuffix(scope)}:${key}`;
export function subscribeConnectedAccountCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getConnectedAccountCatalogValue<K extends ConnectedAccountCatalogKeyV1>(scope: ServerAccountScope | null | undefined,
    key: K): ConnectedAccountCatalogValueSnapshot<K> {
    // Publication validates the addressed key; the generic retains that caller narrowing.
    return (scope ? snapshots.get(snapshotKey(scope, key))?.value ?? loading : loading) as ConnectedAccountCatalogValueSnapshot<K>;
}
export function getConnectedAccountCatalogSnapshot(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1): ConnectedAccountCatalogSnapshotV1 | null {
    return snapshots.get(snapshotKey(scope, key))?.catalog ?? null;
}
export function applyConnectedAccountCatalogSnapshot(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    catalog: ConnectedAccountCatalogSnapshotV1, current: boolean): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    const addressedKey = snapshotKey(scope, key);
    const old = snapshots.get(addressedKey)?.value;
    let next: ConnectedAccountCatalogValueSnapshot<ConnectedAccountCatalogKeyV1>;
    if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.record.key === key) {
        const value = old?.value && JSON.stringify(old.value) === JSON.stringify(catalog.record.value) ? old.value : catalog.record.value;
        next = { status: catalog.status, value, revision: catalog.revision, stale: false,
            ...(catalog.status === 'partial' ? { diagnostics: catalog.diagnostics } : {}) };
    } else {
        const reason = catalog.status === 'ready' || catalog.status === 'partial' ? 'invalid-stored-content'
            : catalog.status === 'loading' ? 'loading' : catalog.reason;
        const withdraw = ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized', 'forbidden',
            'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(reason);
        next = { status: reason === 'loading' ? 'loading' : 'unavailable', value: withdraw ? null : old?.value ?? null,
            revision: old?.revision ?? 'absent', stale: true, reason };
    }
    if (old && JSON.stringify(old) === JSON.stringify(next)) next = old;
    snapshots.set(addressedKey, { scope, key, catalog, value: next });
    if (next === old) return;
    for (const listener of [...listeners]) listener();
}
export function beginConnectedAccountCatalogLoad(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1): void {
    applyConnectedAccountCatalogSnapshot(scope, key, { status: 'loading' }, true);
}
export function invalidateConnectedAccountCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginConnectedAccountCatalogLoad(snapshot.scope, snapshot.key);
}
export function resetConnectedAccountCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
