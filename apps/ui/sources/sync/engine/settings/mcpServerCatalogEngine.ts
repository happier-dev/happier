import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readMcpServerCatalog } from '@/sync/api/account/apiMcpServerCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from './accountCatalogInvalidation';
import { applyMcpServerCatalogSnapshot, beginMcpServerCatalogLoad, getMcpServerCatalogSnapshot,
    invalidateMcpServerCatalogsForServer } from '@/sync/store/settings/mcpServerCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `mcp:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: subscribeAccountCatalogInvalidation,
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginMcpServerCatalogLoad(scope);
        return context.readWithMaintenance<Awaited<ReturnType<typeof readMcpServerCatalog>>>({
            read: publication => readMcpServerCatalog(scope, undefined, guard, publication),
            publish: (snapshot, current, isAccountCurrent) => {
                try { guard?.(); } catch { return; }
                // A wake withdraws freshness, while the captured Account can still admit display data.
                applyMcpServerCatalogSnapshot(scope, snapshot, isAccountCurrent ? isAccountCurrent() : current, !current);
            },
            getPublication: () => getMcpServerCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => getMcpServerCatalogSnapshot(scope).status !== 'ready',
    matchesWake: event => !event.entityIds || event.entityIds.includes(MCP_SERVER_CATALOG_ACCOUNT_KEY_V1)
        || event.entityIds.includes('self'),
    invalidateServer: invalidateMcpServerCatalogsForServer,
    invalidateTarget: ({ scope }) => beginMcpServerCatalogLoad(scope),
    onCredentialMutation: (_event, { scope }) => {
        applyMcpServerCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        return true;
    },
});
export function observeMcpServerCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshMcpServerCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateMcpServerCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
/** Uncancelled receipt refresh remains bound to the invoker's original Account lifetime. */
export function invalidateMcpServerCatalogAfterAcknowledgedMutation(scope: ServerAccountScope,
    assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetMcpServerCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
