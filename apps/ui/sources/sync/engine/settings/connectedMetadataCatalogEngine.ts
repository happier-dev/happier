import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readConnectedMetadataCatalogProjection } from '@/sync/api/account/apiConnectedMetadataCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyConnectedMetadataCatalogSnapshot, beginConnectedMetadataCatalogLoad, getConnectedMetadataCatalog,
    invalidateConnectedMetadataCatalogsForServer } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `connected-metadata:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginConnectedMetadataCatalogLoad(scope);
        return context.readWithMaintenance({
            read: publication => readConnectedMetadataCatalogProjection(scope, undefined, guard, publication),
            publish: (projection, current) => {
                try { guard?.(); } catch { return; }
                applyConnectedMetadataCatalogSnapshot(scope, projection, current);
            },
            getPublication: () => getConnectedMetadataCatalog(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => {
        const snapshot = getConnectedMetadataCatalog(scope);
        return snapshot.presentation.status !== 'ready' || snapshot.acknowledgements.status !== 'ready';
    },
    invalidateServer: invalidateConnectedMetadataCatalogsForServer,
    invalidateTarget: ({ scope }) => beginConnectedMetadataCatalogLoad(scope),
    matchesWake: event => event.entityIds === undefined || event.entityIds.some(id =>
        id === 'self' || id === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 || id === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1),
    onCredentialMutation: (_event, { scope }) => {
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'unavailable', reason: 'unauthorized' },
            acknowledgements: { status: 'unavailable', reason: 'unauthorized' }, disclosure: [] }, true);
        return true;
    },
});
export function observeConnectedMetadataCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshConnectedMetadataCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export const loadConnectedMetadataCatalog = refreshConnectedMetadataCatalog;
export function invalidateConnectedMetadataCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
/** A durable receipt refreshes its captured Account without borrowing a replacement lifetime. */
export function invalidateConnectedMetadataCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetConnectedMetadataCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
