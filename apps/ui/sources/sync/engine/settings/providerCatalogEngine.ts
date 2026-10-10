import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readProviderCatalog } from '@/sync/api/account/apiProviderCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyProviderCatalogSnapshot, beginProviderCatalogLoad, getProviderCatalogSnapshot,
    invalidateProviderCatalogsForServer, type ProviderCatalogCryptoAdmission } from '@/sync/store/settings/providerCatalogSnapshot';
type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `providers:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginProviderCatalogLoad(scope);
        let cryptoAdmission: ProviderCatalogCryptoAdmission | null = null;
        return context.readWithMaintenance({
            read: publication => readProviderCatalog(scope, undefined, guard, { ...publication,
                onCryptoAdmission: admission => { cryptoAdmission = admission; },
            }),
            publish: (catalog, current) => {
                try { guard?.(); } catch { return; }
                applyProviderCatalogSnapshot(scope, catalog, current, cryptoAdmission);
            },
            getPublication: () => getProviderCatalogSnapshot(scope)?.catalog ?? null,
        });
    },
    shouldLoadOnObserve: ({ scope }) => getProviderCatalogSnapshot(scope)?.status !== 'ready',
    invalidateServer: invalidateProviderCatalogsForServer,
    invalidateTarget: ({ scope }) => beginProviderCatalogLoad(scope),
    matchesWake: event => event.entityIds === undefined || event.entityIds.some(id =>
        id === 'self' || id === PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1),
    onCredentialMutation: (_event, { scope }) => {
        applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true); return true;
    },
});
export function observeProviderCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshProviderCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateProviderCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCurrent: () => void): Promise<void> {
    try { assertCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCurrent) publicationGuards.delete(target.key);
    });
}
export function resetProviderCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
