import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readConnectedMetadataCatalogProjection } from '@/sync/api/account/apiConnectedMetadataCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { subscribeAccountCatalogInvalidation } from './accountCatalogInvalidation';
import { homeAccountChangeAffectsPrivateAccountRows } from '@/sync/runtime/orchestration/changesPlanner';
import { homeAccountChangeRowsAlreadyHeld } from '@/sync/runtime/orchestration/homeAccountChange';
import { applyConnectedMetadataCatalogSnapshot, beginConnectedMetadataCatalogLoad, getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `connected-metadata:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
/** Targets whose last completed read left source or history cleanup pending. */
const sourceCleanupPending = new Set<string>();
const loader = createScopedSnapshotLoader<Target>({
    subscribeRetainedInvalidation: subscribeAccountCatalogInvalidation,
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginConnectedMetadataCatalogLoad(scope);
        return context.readWithMaintenance<Awaited<ReturnType<typeof readConnectedMetadataCatalogProjection>>>({
            read: publication => readConnectedMetadataCatalogProjection(scope, undefined, guard,
                { ...publication, sourceCleanupPending: sourceCleanupPending.has(key) }),
            publish: (projection, current) => {
                if (projection.cleanup) {
                    if (projection.cleanup.status === 'cleanup-pending') sourceCleanupPending.add(key);
                    else sourceCleanupPending.delete(key);
                }
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
    // Advisory wakes schedule a read without withdrawing the admitted snapshot.
    invalidateServer: () => undefined,
    invalidateTarget: ({ scope }, reason) => beginConnectedMetadataCatalogLoad(scope, reason !== 'reload'),
    matchesWake: event => event.entityIds === undefined ? homeAccountChangeAffectsPrivateAccountRows(event)
        : event.entityIds.some(id => id === 'self' || id === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1
            || id === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1),
    // This client's own write echoes back; its acknowledged receipt already holds that revision.
    prepareWake: (event, { scope }) => !homeAccountChangeRowsAlreadyHeld(event,
        id => id === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 || id === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
        id => id === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1 ? getConnectedMetadataCatalog(scope).presentationRevision
            : getConnectedMetadataCatalog(scope).acknowledgementsRevision),
    onCredentialMutation: (_event, { scope }) => {
        applyConnectedMetadataCatalogSnapshot(scope, { presentation: { status: 'unavailable', reason: 'unauthorized' },
            acknowledgements: { status: 'unavailable', reason: 'unauthorized' } }, true);
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
export function resetConnectedMetadataCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); sourceCleanupPending.clear(); }
