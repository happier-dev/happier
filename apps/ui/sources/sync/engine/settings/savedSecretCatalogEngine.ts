import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSavedSecretCatalogInContext, readSavedSecretCatalogMetadataInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createScopedSnapshotLoader, type ScopedLoadTarget } from '@/sync/engine/scope/scopedSnapshotLoader';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { SavedSecretLegacyImportResult } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { sync } from '@/sync/sync';
import { isArtifactOnlyHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import {
    applySavedSecretCatalogFailure,
    applySavedSecretCatalogPage,
    beginSavedSecretCatalogLoad,
    getSavedSecretCatalogSnapshot,
    invalidateSavedSecretCatalog,
    invalidateSavedSecretCatalogsForServer,
    removeDeletedSavedSecretCatalogResource,
    applyAcknowledgedSavedSecretCatalogEntry,
} from '@/sync/store/settings/savedSecretCatalogSnapshot';

type Target = ScopedLoadTarget & Readonly<{ scope: ServerAccountScope }>;
type CatalogProjection =
    | Readonly<{ ok: true; materialized: Awaited<ReturnType<typeof materializeSavedSecretResources>>;
        includesMaterial: boolean; legacyImport?: SavedSecretLegacyImportResult; observedAt: number }>
    | Readonly<{ ok: false; error: ScopedSnapshotError }>;

const targetFor = (scope: ServerAccountScope): Target => ({
    key: `saved-secrets:${scope.serverId.length}:${scope.serverId}${scope.accountId.length}:${scope.accountId}`,
    serverId: scope.serverId,
    scope,
});

/** Material consumers share the same loader and snapshot as metadata-only pickers. */
const materialDemand = new Map<string, number>();
function retainMaterialDemand(scope: ServerAccountScope): () => void {
    const key = targetFor(scope).key;
    materialDemand.set(key, (materialDemand.get(key) ?? 0) + 1);
    return () => {
        const remaining = (materialDemand.get(key) ?? 1) - 1;
        if (remaining > 0) materialDemand.set(key, remaining);
        else materialDemand.delete(key);
    };
}

const loader = createScopedSnapshotLoader<Target>({
    load: async ({ scope }, context) => {
        // Maintenance belongs to the foreground read that acquired this demand.
        // A one-shot refresh may release its caller before maintenance settles.
        const includeMaterial = materialDemand.has(targetFor(scope).key);
        beginSavedSecretCatalogLoad(scope);
        return context.readWithMaintenance<CatalogProjection>({
            read: async publication => {
                const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
                try {
                    account = await captureLazyActionAccountContext(scope.serverId);
                    if (account.accountId !== scope.accountId) throw new Error('action_account_scope_changed');
                    const captured = account;
                    await sync.awaitBootstrapForegroundAcquisition();
                    captured.assertCurrent();
                    const mode = await captured.resolveAccountMode();
                    const project = async (legacyImport?: SavedSecretLegacyImportResult): Promise<CatalogProjection> => {
                        if (!includeMaterial) {
                            const outcome = await readSavedSecretCatalogMetadataInContext(captured, context.signal);
                            captured.assertCurrent();
                            if (!outcome.ok) return { ok: false, error: {
                                kind: outcome.failure.kind === 'conflict' || outcome.failure.kind === 'outcome_unknown'
                                    ? 'unknown' : outcome.failure.kind,
                                retryable: outcome.failure.retryable, code: outcome.failure.code,
                            } };
                            return { ok: true, includesMaterial: false, materialized: {
                                entries: outcome.resources.filter(row => row.materialStatus !== 'resource_corrupt'),
                                corruptEntries: outcome.resources.filter(row => row.materialStatus === 'resource_corrupt'),
                                materializedSecrets: [],
                                contents: new Map(),
                            }, observedAt: Date.now() };
                        }
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
                            return { ok: true, materialized, includesMaterial: true, ...(legacyImport ? { legacyImport } : {}), observedAt: Date.now() };
                        } catch {
                            return { ok: false, error: { kind: 'invalid', retryable: false } };
                        }
                    };
                    // Wakes may withdraw publication authority, but never prevent the
                    // foreground read from reaching materials. The loader owns its reread.
                    const foreground = await project();
                    if (!foreground.ok) return foreground;
                    publication.onReady(foreground, captured.accountLifetime.isCurrent);
                    if (!foreground.includesMaterial) return foreground;
                    if (publication.hasPendingCleanup()) return foreground;
                    const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                    let legacyImport: SavedSecretLegacyImportResult;
                    try {
                        legacyImport = await importLegacySavedSecretsInContext(captured, mode, scope, undefined, undefined, 'current-read');
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
                    includesMaterial: projection.includesMaterial,
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
    // Resources and legacy Settings own this material. Artifact receipts also
    // wake Profile bodies, but do not change Saved Secrets or their source.
    // Coarse secondary wakes retain revalidation when no exact domains exist.
    matchesWake: event => event.savedSecretResourcesRefreshStarted !== true
        && !isArtifactOnlyHomeAccountChange(event) && event.profileCatalogAffects !== false,
});

export function observeSavedSecretCatalog(scope: ServerAccountScope, options?: Readonly<{ includeMaterial?: boolean }>): () => void {
    const includeMaterial = options?.includeMaterial !== false;
    const upgrade = includeMaterial && !materialDemand.has(targetFor(scope).key)
        && getSavedSecretCatalogSnapshot(scope)?.includesMaterial === false;
    const releaseMaterial = includeMaterial ? retainMaterialDemand(scope) : () => {};
    const releaseObservation = loader.observe(targetFor(scope));
    if (upgrade) fireAndForget(loader.invalidate(targetFor(scope)), { tag: 'savedSecretCatalog.materialDemand' });
    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseMaterial();
        releaseObservation();
    };
}

export async function refreshSavedSecretCatalog(scope: ServerAccountScope, options?: Readonly<{ includeMaterial?: boolean }>): Promise<void> {
    // Mutation completions also use this entry point. A read begun before the
    // write must not satisfy their reload; the loader owns the trailing reread.
    const releaseMaterial = options?.includeMaterial !== false ? retainMaterialDemand(scope) : () => {};
    try { await loader.invalidate(targetFor(scope)); }
    finally { releaseMaterial(); }
}

export function invalidateSavedSecretCatalogProjection(scope: ServerAccountScope): Promise<void> {
    return loader.invalidate(targetFor(scope));
}
/** Invalidate older reads before publishing the exact receipt; the loader owns revalidation. */
export function applySavedSecretCatalogEntryAcknowledgement(scope: ServerAccountScope, entry: SavedSecretCatalogEntryV1,
    current: boolean): void {
    if (!current) return;
    const revalidation = loader.invalidate(targetFor(scope));
    fireAndForget(revalidation, { tag: 'savedSecretCatalog.afterAcknowledgedMutation' });
    try { applyAcknowledgedSavedSecretCatalogEntry(scope, entry, current); }
    catch { /* A display subscriber cannot retract the durable resource receipt. */ }
}

/** Reconcile the receipt first; revalidation retains that fact on transport failure. */
export async function applySavedSecretCatalogDeletion(scope: ServerAccountScope, resourceId: string,
    expectedRevision?: number, current = true): Promise<void> {
    if (!current) return;
    const revalidation = loader.invalidate(targetFor(scope));
    removeDeletedSavedSecretCatalogResource(scope, resourceId, expectedRevision, current);
    // The loader publishes its own read failure; it cannot undo a committed deletion.
    fireAndForget(revalidation, { tag: 'savedSecretCatalog.afterAcknowledgedDeletion' });
}

export function resetSavedSecretCatalogEngineForTests(): void {
    loader.resetForTests();
    materialDemand.clear();
}
