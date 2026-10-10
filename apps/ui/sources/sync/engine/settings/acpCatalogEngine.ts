import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readAcpCatalog } from '@/sync/api/account/apiAcpCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyAcpCatalogSnapshot, beginAcpCatalogLoad, getAcpCatalogSnapshot, invalidateAcpCatalogsForServer } from '@/sync/store/settings/acpCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `acp:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginAcpCatalogLoad(scope);
        const projection = await readAcpCatalog(scope);
        try { guard?.(); } catch { return; }
        applyAcpCatalogSnapshot(scope, projection.catalog, context.isCurrent());
    },
    shouldLoadOnObserve: ({ scope }) => getAcpCatalogSnapshot(scope)?.stale !== false,
    invalidateServer: invalidateAcpCatalogsForServer,
    invalidateTarget: ({ scope }) => beginAcpCatalogLoad(scope),
    matchesWake: event => event.entityIds === undefined || event.entityIds.includes(ACP_CATALOG_ACCOUNT_ROW_KEY_V1) || event.entityIds.includes('self'),
    onCredentialMutation: (_event, { scope }) => {
        applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        return true;
    },
});
export function observeAcpCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshAcpCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateAcpCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
export function invalidateAcpCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetAcpCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
