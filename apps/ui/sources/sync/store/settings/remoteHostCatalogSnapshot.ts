import type { RemoteHostCatalogSnapshotV1, RemoteHostRecordV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import * as React from 'react';
import { observeRemoteHostCatalog } from '@/sync/engine/settings/remoteHostCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';

export type RemoteHostCatalogSnapshot = Readonly<{
    scope: ServerAccountScope;
    catalog: RemoteHostCatalogSnapshotV1;
    data: readonly RemoteHostRecordV1[] | null;
    stale: boolean;
}>;
const snapshots = new Map<string, RemoteHostCatalogSnapshot>();
const listeners = new Set<() => void>();
const loading: RemoteHostCatalogSnapshotV1 = Object.freeze({ status: 'loading' });
function publish(next: RemoteHostCatalogSnapshot): void {
    const key = serverAccountScopeKeySuffix(next.scope);
    const previous = snapshots.get(key);
    if (previous?.catalog === next.catalog && previous.data === next.data && previous.stale === next.stale) return;
    snapshots.set(key, Object.freeze(next));
    for (const listener of [...listeners]) listener();
}
export function subscribeRemoteHostCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function getRemoteHostCatalogSnapshot(scope: ServerAccountScope | null | undefined): RemoteHostCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
export function beginRemoteHostCatalogLoad(scope: ServerAccountScope): void {
    publish({ scope, catalog: loading, data: getRemoteHostCatalogSnapshot(scope)?.data ?? null, stale: true });
}
export function applyRemoteHostCatalogSnapshot(scope: ServerAccountScope, catalog: RemoteHostCatalogSnapshotV1, current: boolean): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    const previous = getRemoteHostCatalogSnapshot(scope);
    const refused = catalog.status === 'unavailable' && (isAuthoritativeScopedSnapshotRefusalKind(catalog.reason)
        || ['account-mode-mismatch', 'account-not-found', 'account-inconsistent', 'encryption-material-unavailable'].includes(catalog.reason));
    let data = refused ? null : previous?.data ?? null;
    if (catalog.status === 'ready' || catalog.status === 'partial') {
        const byId = new Map(previous?.data?.map(host => [host.id, host]) ?? []);
        const hosts = catalog.hosts.map(host => {
            const old = byId.get(host.id);
            return old && JSON.stringify(old) === JSON.stringify(host) ? old : host;
        });
        data = previous?.data && hosts.length === previous.data.length
            && hosts.every((host, index) => host === previous.data![index]) ? previous.data : Object.freeze(hosts);
        catalog = { ...catalog, hosts: data };
    }
    if (previous && JSON.stringify(previous.catalog) === JSON.stringify(catalog)) catalog = previous.catalog;
    publish({ scope, catalog, data, stale: catalog.status !== 'ready' || catalog.cleanup === 'pending' });
}
export function invalidateRemoteHostCatalog(scope: ServerAccountScope): void { beginRemoteHostCatalogLoad(scope); }
export function invalidateRemoteHostCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginRemoteHostCatalogLoad(snapshot.scope);
}
export function resetRemoteHostCatalogSnapshotsForTests(): void { snapshots.clear(); listeners.clear(); }

/** Exact Account selector; sibling catalog publications preserve this snapshot identity. */
export function useRemoteHostCatalogSnapshot(scope: ServerAccountScope | null | undefined): RemoteHostCatalogSnapshot | null {
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => captured ? observeRemoteHostCatalog(captured) : undefined, [captured]);
    const read = React.useCallback(() => getRemoteHostCatalogSnapshot(captured), [captured]);
    return React.useSyncExternalStore(subscribeRemoteHostCatalogSnapshots, read, read);
}
