import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSavedSecretCatalogInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { SavedSecretLegacyImportResult } from '@/sync/domains/settings/savedSecretTypes';
import {
    applySavedSecretCatalogFailure,
    applySavedSecretCatalogPage,
    beginSavedSecretCatalogLoad,
    getSavedSecretCatalogSnapshot,
    invalidateSavedSecretCatalog,
    invalidateSavedSecretCatalogsForServer,
    removeDeletedSavedSecretCatalogResource,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
type CatalogProjection =
    | Readonly<{ ok: true; materialized: Awaited<ReturnType<typeof materializeSavedSecretResources>>;
        legacyImport?: SavedSecretLegacyImportResult; observedAt: number }>
    | Readonly<{ ok: false; error: ScopedSnapshotError }>;

const targetFor = (scope: ServerAccountScope): Target => ({
    key: `saved-secrets:${scope.serverId.length}:${scope.serverId}${scope.accountId.length}:${scope.accountId}`,
    serverId: scope.serverId,
    scope,
});

const loader = createScopedSnapshotLoader<Target>({
    load: async ({ scope }, context) => {
        beginSavedSecretCatalogLoad(scope);
        return context.readWithMaintenance<CatalogProjection>({
            read: async publication => {
                const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
                try {
                    account = await captureLazyActionAccountContext(scope.serverId);
                    if (account.accountId !== scope.accountId) throw new Error('action_account_scope_changed');
                    const captured = account;
                    const mode = await captured.resolveAccountMode();
                    const project = async (legacyImport?: SavedSecretLegacyImportResult): Promise<CatalogProjection> => {
                        const outcome = await readSavedSecretCatalogInContext(captured);
                        if (!outcome.ok) return { ok: false, error: {
                            kind: outcome.failure.kind === 'conflict' || outcome.failure.kind === 'outcome_unknown'
                                ? 'unknown' : outcome.failure.kind,
                            retryable: outcome.failure.retryable,
                            code: outcome.failure.code,
                        } };
                        try {
                            // Resource material is independent of legacy Settings admission.
                            const encryption = outcome.resources.some(resource => 'resourceId' in resource && resource.encryptionMode === 'e2ee')
                                ? (await captured.resolveAccountEncryption().catch(() => null))?.encryption ?? null
                                : null;
                            const materialized = await materializeSavedSecretResources({
                                resources: outcome.resources,
                                decryptDataKeyEnvelope: async encryptedDataKey => encryption
                                    ? encryption.decryptEncryptionKey(encryptedDataKey, scope) : null,
                            });
                            const currentMode = (await fetchAccountEncryptionMode(captured.credentials, { request: captured.request })).mode;
                            captured.assertCurrent();
                            if (currentMode !== mode) throw new Error('account-mode-mismatch');
                            return { ok: true, materialized, ...(legacyImport ? { legacyImport } : {}), observedAt: Date.now() };
                        } catch {
                            return { ok: false, error: { kind: 'invalid', retryable: false } };
                        }
                    };
                    // Wakes may withdraw publication authority, but never prevent the
                    // foreground read from reaching materials. The loader owns its reread.
                    const foreground = await project();
                    if (!foreground.ok) return foreground;
                    publication.onReady(foreground, captured.accountLifetime.isCurrent);
                    if (publication.hasPendingCleanup()) return foreground;
                    const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                    let legacyImport: SavedSecretLegacyImportResult;
                    try {
                        legacyImport = await importLegacySavedSecretsInContext(captured, mode, scope);
                    } catch {
                        // Pending approval/import cannot withdraw valid foreground material.
                        legacyImport = { status: 'pending', reason: 'source-unavailable' };
                    }
                    captured.assertCurrent();
                    return await project(legacyImport);
                } catch {
                    return { ok: false, error: { kind: 'unreachable', retryable: true } };
                } finally {
                    // Maintenance retains the same captured Account, including its watches.
                    account?.dispose();
                }
            },
            publish: (projection, current) => {
                // An acknowledged mutation already corrected the retained projection.
                // A pre-mutation read must not resurrect deleted rows, even as stale data.
                if (!current) return;
                if (!projection.ok) {
                    applySavedSecretCatalogFailure({ scope, error: projection.error });
                    throw new Error(`Saved Secret material catalog read failed: ${projection.error.kind}`);
                }
                applySavedSecretCatalogPage({ scope, ...projection.materialized,
                    ...(projection.legacyImport ? { legacyImport: projection.legacyImport } : {}),
                    observedAt: projection.observedAt, current });
            },
            getPublication: () => getSavedSecretCatalogSnapshot(scope),
        });
    },
    shouldLoadOnObserve: ({ scope }) => {
        const snapshot = getSavedSecretCatalogSnapshot(scope);
        return !snapshot || snapshot.stale || (snapshot.data === null && snapshot.status !== 'loading');
    },
    invalidateServer: invalidateSavedSecretCatalogsForServer,
    invalidateTarget: ({ scope }) => invalidateSavedSecretCatalog(scope),
});

export function observeSavedSecretCatalog(scope: ServerAccountScope): () => void {
    return loader.observe(targetFor(scope));
}

export function refreshSavedSecretCatalog(scope: ServerAccountScope): Promise<void> {
    // Mutation completions also use this entry point. A read begun before the
    // write must not satisfy their reload; the loader owns the trailing reread.
    return loader.invalidate(targetFor(scope));
}

export function invalidateSavedSecretCatalogProjection(scope: ServerAccountScope): Promise<void> {
    return loader.invalidate(targetFor(scope));
}

/** Reconcile the receipt first; revalidation retains that fact on transport failure. */
export async function applySavedSecretCatalogDeletion(scope: ServerAccountScope, resourceId: string): Promise<void> {
    const revalidation = loader.invalidate(targetFor(scope));
    removeDeletedSavedSecretCatalogResource(scope, resourceId);
    // The loader publishes its own read failure; it cannot undo a committed deletion.
    await revalidation.catch(() => undefined);
}

export function resetSavedSecretCatalogEngineForTests(): void {
    loader.resetForTests();
}
