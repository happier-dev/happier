import { REMOTE_HOST_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { readRemoteHostCatalogProjection } from '@/sync/api/account/apiRemoteHostCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyRemoteHostCatalogSnapshot, beginRemoteHostCatalogLoad, getRemoteHostCatalogSnapshot,
    invalidateRemoteHostCatalog, invalidateRemoteHostCatalogsForServer } from '@/sync/store/settings/remoteHostCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `remote-hosts:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ scope }, context) => {
        beginRemoteHostCatalogLoad(scope);
        return context.readWithMaintenance({
            read: publication => readRemoteHostCatalogProjection(scope, undefined, publication),
            publish: (catalog, current) => applyRemoteHostCatalogSnapshot(scope, catalog, current),
            getPublication: () => getRemoteHostCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => !getRemoteHostCatalogSnapshot(scope) || getRemoteHostCatalogSnapshot(scope)!.stale,
    invalidateServer: invalidateRemoteHostCatalogsForServer,
    invalidateTarget: ({ scope }) => invalidateRemoteHostCatalog(scope),
    matchesWake: event => event.entityIds === undefined || event.entityIds.some(id =>
        id === 'self' || id === REMOTE_HOST_ACCOUNT_KV_KEY_V1),
    onCredentialMutation: (_event, { scope }) => {
        applyRemoteHostCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        return true;
    },
});
export function observeRemoteHostCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshRemoteHostCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateRemoteHostCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
export function resetRemoteHostCatalogEngineForTests(): void { loader.resetForTests(); }
