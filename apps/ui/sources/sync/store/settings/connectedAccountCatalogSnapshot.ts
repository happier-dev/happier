import type { ConnectedAccountCatalogDiagnosticV1, ConnectedAccountCatalogKeyV1, ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';
import { admitAgentConnectedAccountPurposeBindings } from '@happier-dev/protocol/account/settings/connected-services';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

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
function admitCatalogRecord(record: ConnectedAccountCatalogRecordV1): ConnectedAccountCatalogRecordV1 {
    return record.key === 'purposes'
        ? { key: 'purposes', value: admitAgentConnectedAccountPurposeBindings(record.value) }
        : record;
}
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
export function applyAcknowledgedConnectedAccountCatalog(scope: ServerAccountScope, record: ConnectedAccountCatalogRecordV1,
    revision: number, current: boolean): void {
    const old = getConnectedAccountCatalogValue(scope, record.key);
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: old.revision })) return;
    record = admitCatalogRecord(record);
    const value: ConnectedAccountCatalogValueSnapshot<ConnectedAccountCatalogKeyV1> = {
        status: 'loading', value: record.value, revision, stale: true, reason: 'loading',
    };
    if (sameStrictJsonValue(old, value)) return;
    snapshots.set(snapshotKey(scope, record.key), { scope, key: record.key, catalog: { status: 'loading' },
        value });
    for (const listener of [...listeners]) listener();
}
export function applyConnectedAccountCatalogSnapshot(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    catalog: ConnectedAccountCatalogSnapshotV1, current: boolean): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.record.key === key) {
        try { catalog = { ...catalog, record: admitCatalogRecord(catalog.record) }; }
        catch { catalog = { status: 'unavailable', reason: 'invalid-stored-content' }; }
    }
    const addressedKey = snapshotKey(scope, key);
    const old = snapshots.get(addressedKey)?.value;
    let next: ConnectedAccountCatalogValueSnapshot<ConnectedAccountCatalogKeyV1>;
    if ((catalog.status === 'ready' || catalog.status === 'partial') && catalog.record.key === key) {
        const value = old?.value && JSON.stringify(old.value) === JSON.stringify(catalog.record.value) ? old.value : catalog.record.value;
        next = { status: catalog.status, value, revision: retainCatalogRevision(catalog, old?.revision), stale: false,
            ...(catalog.status === 'partial' ? { diagnostics: catalog.diagnostics } : {}) };
    } else {
        const reason = catalog.status === 'ready' || catalog.status === 'partial' ? 'invalid-stored-content'
            : catalog.status === 'loading' ? 'loading' : catalog.reason;
        const withdraw = ['account-mode-mismatch', 'encryption-material-unavailable', 'unauthorized', 'forbidden',
            'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(reason);
        next = { status: reason === 'loading' ? 'loading' : 'unavailable', value: withdraw ? null : old?.value ?? null,
            revision: retainCatalogRevision({ status: 'unavailable' }, old?.revision), stale: true, reason };
    }
    if (old && JSON.stringify(old) === JSON.stringify(next)) next = old;
    snapshots.set(addressedKey, { scope, key, catalog, value: next });
    if (next === old) return;
    for (const listener of [...listeners]) listener();
}
/** Refresh is transport work; only explicit invalidation withdraws retained admission. */
export function beginConnectedAccountCatalogLoad(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1, invalidate = false): void {
    if (!invalidate && getConnectedAccountCatalogSnapshot(scope, key)) return;
    applyConnectedAccountCatalogSnapshot(scope, key, { status: 'loading' }, true);
}
export function resetConnectedAccountCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
