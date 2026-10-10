import type { NotificationChannelCatalogSnapshotV1, NotificationChannelRecordV1,
    NotificationChannelCatalogDiagnosticV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type NotificationChannelCatalogProjection = Readonly<{
    catalog: NotificationChannelCatalogSnapshotV1;
    rawSettings: Readonly<Record<string, unknown>>;
    sourceSettingsVersion: number;
}>;
export type NotificationChannelCatalogValueSnapshot = Readonly<{
    status: 'loading' | 'ready' | 'partial' | 'unavailable';
    channels: readonly NotificationChannelRecordV1[];
    diagnostics: readonly NotificationChannelCatalogDiagnosticV1[];
    revision: number | 'absent'; stale: boolean; reason?: string;
}>;
type StoredSnapshot = Readonly<{ scope: ServerAccountScope; projection: NotificationChannelCatalogProjection;
    value: NotificationChannelCatalogValueSnapshot }>;
const snapshots = new Map<string, StoredSnapshot>();
const listeners = new Set<() => void>();
const loading: NotificationChannelCatalogValueSnapshot = Object.freeze({ status: 'loading', channels: Object.freeze([]),
    diagnostics: Object.freeze([]), revision: 'absent', stale: true });
export function subscribeNotificationChannelCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getNotificationChannelCatalogSnapshot(scope: ServerAccountScope): NotificationChannelCatalogProjection | null {
    return snapshots.get(serverAccountScopeKeySuffix(scope))?.projection ?? null;
}
export function getNotificationChannelCatalogValue(scope: ServerAccountScope | null | undefined): NotificationChannelCatalogValueSnapshot {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope))?.value ?? loading : loading;
}
export function applyNotificationChannelCatalogSnapshot(scope: ServerAccountScope, projection: NotificationChannelCatalogProjection, current: boolean): void {
    const catalog = projection.catalog;
    if (!current || catalog.status === 'unavailable' && catalog.reason === 'scope-retired') return;
    const key = serverAccountScopeKeySuffix(scope);
    const old = snapshots.get(key)?.value;
    let next: NotificationChannelCatalogValueSnapshot;
    if (catalog.status === 'ready' || catalog.status === 'partial') {
        const channels = old && JSON.stringify(old.channels) === JSON.stringify(catalog.channels) ? old.channels : catalog.channels;
        const diagnostics = old && JSON.stringify(old.diagnostics) === JSON.stringify(catalog.diagnostics) ? old.diagnostics : catalog.diagnostics;
        next = { status: catalog.status, channels, diagnostics, revision: catalog.revision, stale: catalog.status !== 'ready' };
    } else {
        const reason = catalog.status === 'loading' ? 'loading' : catalog.reason;
        const withdraw = ['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'encryption-material-unavailable',
            'invalid-stored-content', 'unauthorized', 'forbidden'].includes(reason);
        next = { status: catalog.status, channels: withdraw ? loading.channels : old?.channels ?? loading.channels,
            diagnostics: withdraw ? loading.diagnostics : old?.diagnostics ?? loading.diagnostics,
            revision: old?.revision ?? 'absent', stale: true, reason };
    }
    if (old && JSON.stringify(old) === JSON.stringify(next)) next = old;
    snapshots.set(key, { scope, projection, value: next });
    if (next !== old) for (const listener of [...listeners]) listener();
}
export function beginNotificationChannelCatalogLoad(scope: ServerAccountScope): void {
    const old = getNotificationChannelCatalogSnapshot(scope);
    applyNotificationChannelCatalogSnapshot(scope, { catalog: { status: 'loading' }, rawSettings: old?.rawSettings ?? {},
        sourceSettingsVersion: old?.sourceSettingsVersion ?? 0 }, true);
}
export function invalidateNotificationChannelCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginNotificationChannelCatalogLoad(snapshot.scope);
}
export function resetNotificationChannelCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }
