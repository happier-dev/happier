import type { ConnectedAccountCatalogKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readConnectedAccountCatalog, type ConnectedAccountCatalogSourceAdmission } from '@/sync/api/account/apiConnectedAccountCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyConnectedAccountCatalogSnapshot, beginConnectedAccountCatalogLoad, getConnectedAccountCatalogSnapshot,
    invalidateConnectedAccountCatalogsForServer } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
type Target = ScopedLoadTarget & ConnectedAccountCatalogSourceAdmission & Readonly<{ scope: ServerAccountScope; catalogKey: ConnectedAccountCatalogKeyV1 }>;
const targetFor = (scope: ServerAccountScope, catalogKey: ConnectedAccountCatalogKeyV1,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Target => ({
    key: `connected-account:${serverAccountScopeKeySuffix(scope)}:${catalogKey}`, serverId: scope.serverId, scope, catalogKey,
    ...(catalogKey === 'purposes' && sourceAdmission?.sourceMachineId?.trim()
        ? { sourceMachineId: sourceAdmission.sourceMachineId.trim() } : {}),
});
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope, catalogKey, sourceMachineId }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginConnectedAccountCatalogLoad(scope, catalogKey);
        return context.readWithMaintenance({
            read: publication => readConnectedAccountCatalog(scope, catalogKey, undefined, guard, publication, { sourceMachineId }),
            publish: (catalog, current) => {
                try { guard?.(); } catch { return; }
                applyConnectedAccountCatalogSnapshot(scope, catalogKey, catalog, current);
            },
            getPublication: () => getConnectedAccountCatalogSnapshot(scope, catalogKey),
        });
    },
    shouldLoadOnObserve: ({ scope, catalogKey }) => getConnectedAccountCatalogSnapshot(scope, catalogKey)?.status !== 'ready',
    invalidateServer: invalidateConnectedAccountCatalogsForServer,
    invalidateTarget: ({ scope, catalogKey }) => beginConnectedAccountCatalogLoad(scope, catalogKey),
    onCredentialMutation: (_event, { scope, catalogKey }) => {
        applyConnectedAccountCatalogSnapshot(scope, catalogKey, { status: 'unavailable', reason: 'unauthorized' }, true);
        return true;
    },
});
export function observeConnectedAccountCatalog(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): () => void {
    const target = targetFor(scope, key, sourceAdmission);
    const incumbent = getConnectedAccountCatalogSnapshot(scope, key);
    // A selected Machine supplies source-only Agent authority. Reuse the same
    // flight, but do not let a generic pre-admission read consume that update.
    if (target.sourceMachineId && incumbent?.status !== 'ready') {
        void loader.invalidate(target).catch(() => {});
    }
    return loader.observe(target);
}
export function refreshConnectedAccountCatalog(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1): Promise<void> { return loader.refresh(targetFor(scope, key)); }
export function invalidateConnectedAccountCatalogProjection(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1): Promise<void> { return loader.invalidate(targetFor(scope, key)); }
export function invalidateConnectedAccountCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope, key);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetConnectedAccountCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
