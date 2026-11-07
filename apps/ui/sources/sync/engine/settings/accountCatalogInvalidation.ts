import { subscribeAccountEncryptionModeCacheInvalidation } from '@/sync/api/account/apiAccountEncryptionMode';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import type { ScopedSnapshotRetainedInvalidation } from '@/sync/engine/scope/scopedSnapshotLoader';

/** Retained display catalogs consume existing admission and scope-retirement signals, never connection demand. */
export function subscribeAccountCatalogInvalidation(
    { scope }: Readonly<{ scope: ServerAccountScope }>,
    handlers: ScopedSnapshotRetainedInvalidation,
): () => void {
    const unsubscribeAdmission = subscribeAccountEncryptionModeCacheInvalidation(event => {
        handlers.invalidate(event.reason === 'transport-withdrawal' ? event.reason : undefined);
    }, scope.serverId);
    const lifetime = captureActiveServerAccountScopeLifetime();
    const retirement = lifetime && areServerAccountScopesEqual(lifetime.scope, scope)
        ? lifetime.onRetire(handlers.retire) : null;
    const unsubscribeProfiles = subscribeServerProfiles(() => {
        if (!getServerProfileById(scope.serverId)) handlers.retire();
    });
    return () => {
        unsubscribeAdmission();
        retirement?.dispose();
        unsubscribeProfiles();
    };
}
