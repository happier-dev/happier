import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readNotificationChannelCatalogProjection } from '@/sync/api/account/apiNotificationChannelCatalog';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { applyNotificationChannelCatalogSnapshot, beginNotificationChannelCatalogLoad, getNotificationChannelCatalogSnapshot,
    invalidateNotificationChannelCatalogsForServer } from '@/sync/store/settings/notificationChannelCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
const targetFor = (scope: ServerAccountScope): Target => ({ key: `notification-channels:${serverAccountScopeKeySuffix(scope)}`, serverId: scope.serverId, scope });
const publicationGuards = new Map<string, () => void>();
const loader = createScopedSnapshotLoader<Target>({
    load: async ({ key, scope }, context) => {
        const guard = publicationGuards.get(key);
        try { guard?.(); } catch { return; }
        beginNotificationChannelCatalogLoad(scope);
        return context.readWithMaintenance({
            read: publication => readNotificationChannelCatalogProjection(scope, undefined, guard, publication),
            publish: (projection, current) => {
                try { guard?.(); } catch { return; }
                applyNotificationChannelCatalogSnapshot(scope, projection, current);
            },
            getPublication: () => getNotificationChannelCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => getNotificationChannelCatalogSnapshot(scope)?.catalog.status !== 'ready',
    invalidateServer: invalidateNotificationChannelCatalogsForServer,
    invalidateTarget: ({ scope }) => beginNotificationChannelCatalogLoad(scope),
    matchesWake: event => event.entityIds === undefined || event.entityIds.some(id => id === 'self' || id === NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1),
    onCredentialMutation: (_event, { scope }) => {
        applyNotificationChannelCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'unauthorized' },
            rawSettings: {}, sourceSettingsVersion: 0 }, true);
        return true;
    },
});
export function observeNotificationChannelCatalog(scope: ServerAccountScope): () => void { return loader.observe(targetFor(scope)); }
export function refreshNotificationChannelCatalog(scope: ServerAccountScope): Promise<void> { return loader.refresh(targetFor(scope)); }
export function invalidateNotificationChannelCatalogProjection(scope: ServerAccountScope): Promise<void> { return loader.invalidate(targetFor(scope)); }
/** The initiating Account keeps its durable receipt even when foreground disclosure is retired. */
export function invalidateNotificationChannelCatalogAfterAcknowledgedMutation(scope: ServerAccountScope, assertCapturedAccountCurrent: () => void): Promise<void> {
    try { assertCapturedAccountCurrent(); } catch { return Promise.resolve(); }
    const target = targetFor(scope);
    publicationGuards.set(target.key, assertCapturedAccountCurrent);
    return loader.invalidate(target).finally(() => {
        if (publicationGuards.get(target.key) === assertCapturedAccountCurrent) publicationGuards.delete(target.key);
    });
}
export function resetNotificationChannelCatalogEngineForTests(): void { loader.resetForTests(); publicationGuards.clear(); }
