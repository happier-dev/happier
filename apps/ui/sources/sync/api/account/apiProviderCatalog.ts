import { loadProviderConnectionsCatalogV1, listProviderConnectionsCatalogSavedSecretRefsV1,
    readRetainedProviderConnectionsCatalogV1, type ProviderConnectionImportIntentV1,
    type ProviderConnectionsCatalogImportInputV1, type ProviderConnectionsCatalogImportResultV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema,
    ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema, sealProviderConnectionsContentV1,
    type ProviderConnectionsCatalogV1, type ProviderConnectionsCatalogSnapshotV1, type ProviderConnectionsRowMutationV1,
    type ProviderConnectionsCatalogRowReadResultV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ProviderCatalogCryptoAdmission } from '@/sync/store/settings/providerCatalogSnapshot';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { importLegacySavedSecretsInContext } from '@/sync/ops/settings/savedSecretResourceOperations';
import { captureSavedSecretReferenceRevisionsInContext } from './apiSavedSecretCatalog';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';

export type ProviderCatalogMutationResponse = ReturnType<typeof ProviderConnectionsRowMutationResponseV1Schema.parse>;
export class ProviderCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'ProviderCatalogOperationError'; }
}
async function admit<T>(context: LazyActionAccountContext, operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return operation(storage.mode, storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials));
}
async function withAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined, operation: (context: LazyActionAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new ProviderCatalogOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
function failure(error: unknown, signal?: AbortSignal): Extract<ProviderConnectionsCatalogSnapshotV1, { status: 'unavailable' }> {
    return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
}
async function projectCatalogForCurrentMode<TCatalog extends ProviderConnectionsCatalogSnapshotV1>(
    context: LazyActionAccountContext, catalog: TCatalog, mode: 'plain' | 'e2ee',
) {
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' } as const;
}
type ReadPublication = Readonly<{
    onReady?: (catalog: ProviderConnectionsCatalogSnapshotV1, isCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
    onCryptoAdmission?: (admission: ProviderCatalogCryptoAdmission | null) => void;
    importConnection?: never;
}>;
export type ProviderCatalogImportOptions = Omit<ReadPublication, 'importConnection'> & Readonly<{ importConnection: ProviderConnectionImportIntentV1 }>;
/** Raw row census only; composite SavedSecret operations must not recursively start import maintenance. */
export async function readProviderCatalogRowInContext(context: LazyActionAccountContext, signal?: AbortSignal): Promise<ProviderConnectionsCatalogRowReadResultV1> {
    const response = await context.request(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { method: 'GET', signal }, { retry: 'none' });
    context.assertCurrent();
    if (!response.ok) return { status: 'unavailable', reason: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable' };
    const row = ProviderConnectionsRowReadResponseV1Schema.safeParse(await response.json().catch(() => null));
    context.assertCurrent(); return row.success ? row.data : { status: 'unavailable', reason: 'invalid-stored-content' };
}
/** A semantic mutation reads admitted authority without activating or cleaning an inactive source. */
export async function readProviderCatalogForMutationInContext(context: LazyActionAccountContext,
    signal?: AbortSignal): Promise<ProviderConnectionsCatalogSnapshotV1> {
    try {
        return await admit(context, async (mode, material) => projectCatalogForCurrentMode(context,
            await loadProviderConnectionsCatalogV1({ mode, material, signal,
                readRow: () => readProviderCatalogRowInContext(context, signal) }), mode));
    } catch (error) { return failure(error, signal); }
}
export function readProviderCatalogInContext(context: LazyActionAccountContext, signal: AbortSignal | undefined,
    publication: ProviderCatalogImportOptions): Promise<ProviderConnectionsCatalogImportResultV1>;
export function readProviderCatalogInContext(context: LazyActionAccountContext, signal?: AbortSignal,
    publication?: ReadPublication): Promise<ProviderConnectionsCatalogSnapshotV1>;
export async function readProviderCatalogInContext(context: LazyActionAccountContext, signal?: AbortSignal,
    publication?: ReadPublication | ProviderCatalogImportOptions): Promise<ProviderConnectionsCatalogSnapshotV1 | ProviderConnectionsCatalogImportResultV1> {
    try {
        return await admit(context, async (mode, material) => {
            publication?.onCryptoAdmission?.(mode === 'e2ee' && material ? {
                contentPublicKeyFingerprint: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: mode, material }).contentPublicKeyFingerprint,
            } : null);
            const scope = { serverId: context.serverId, accountId: context.accountId };
            const project = <TCatalog extends ProviderConnectionsCatalogSnapshotV1>(catalog: TCatalog) =>
                projectCatalogForCurrentMode(context, catalog, mode);
            const loadInput: Omit<ProviderConnectionsCatalogImportInputV1, 'importConnection'> = { mode, material, signal,
                readRow: () => readProviderCatalogRowInContext(context, signal),
                hasPendingCleanup: publication?.hasPendingCleanup,
                ...(publication?.onReady ? { onReadyBeforeCleanup: async ready => {
                    publication.onReady!(await project(ready), context.accountLifetime.isCurrent);
                } } : {}),
                transfer: {
                    readSourceSnapshot: async () => {
                        const readSource = async () => {
                            const { encryption } = await context.resolveAccountEncryption();
                            const source = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                                request: (path, init) => context.request(path, init, { retry: 'none' }) });
                            context.assertCurrent(); return source;
                        };
                        const hasPersonalReferences = (catalog: ProviderConnectionsCatalogV1) =>
                            listProviderConnectionsCatalogSavedSecretRefsV1(catalog)
                                .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal');
                        let source = await readSource();
                        const retained = readRetainedProviderConnectionsCatalogV1(source.raw ?? {});
                        if (retained.status === 'ready' && hasPersonalReferences(retained.catalog)) {
                            // Only this inactive source's actual personal bindings require S2.
                            // Unrelated import/history maintenance cannot veto a usable row.
                            await importLegacySavedSecretsInContext(context, mode, scope);
                            source = await readSource();
                            const normalized = readRetainedProviderConnectionsCatalogV1(source.raw ?? {});
                            if (normalized.status === 'ready' && hasPersonalReferences(normalized.catalog)) {
                                throw new ProviderCatalogOperationError('saved-secret-import-pending');
                            }
                        }
                        context.assertCurrent(); return { raw: source.raw ?? {}, version: source.version };
                    },
                    initializeCatalog: input => writeProviderCatalogInContext(context, input, signal),
                    replaceSource: async input => {
                        context.assertCurrent();
                        const result = await context.mutateRawSettings(() => ({ ...input.raw }), {
                            expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                        });
                        context.assertCurrent(); return result;
                    },
                    normalizeHistory: async input => normalizeAccountSettingsHistoryAfterTransfer({
                        credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                        settingsScope: scope, destinationAuthority: input,
                        requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                    }),
                },
            };
            if (publication?.importConnection) {
                const intent = publication.importConnection;
                const imported = await loadProviderConnectionsCatalogV1({ ...loadInput, importConnection: {
                    ...intent,
                    isCurrent: () => {
                        context.assertCurrent();
                        return context.accountLifetime.isCurrent() && intent.isCurrent();
                    },
                    commitCatalog: input => {
                        context.assertCurrent();
                        return intent.commitCatalog(input);
                    },
                } });
                if (imported.status !== 'applied' && imported.status !== 'unchanged') return imported;
                const projected = await project(imported.catalog);
                if (projected.status !== 'ready') return { status: 'unavailable' as const, reason: projected.reason };
                try { publication.onReady?.(projected, context.accountLifetime.isCurrent); }
                catch { /* A projection failure cannot erase the verified authoritative winner. */ }
                return { ...imported, catalog: projected };
            }
            return project(await loadProviderConnectionsCatalogV1(loadInput));
        });
    } catch (error) { return failure(error, signal); }
}
export async function readProviderCatalog(scope: ServerAccountScope, signal?: AbortSignal,
    assertCapturedAccountCurrent?: () => void, publication?: ReadPublication): Promise<ProviderConnectionsCatalogSnapshotV1> {
    try {
        assertCapturedAccountCurrent?.();
        return await withAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.(); return readProviderCatalogInContext(context, signal, publication);
        });
    } catch (error) { return failure(error, signal); }
}
export type ProviderCatalogWriteInput = Readonly<{ catalog: ProviderConnectionsCatalogV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    savedSecretRevisions?: ProviderConnectionsRowMutationV1['savedSecretRevisions']; pendingResourceIds?: readonly string[] }>;
export function prepareProviderCatalogMutationInContext(context: LazyActionAccountContext, input: ProviderCatalogWriteInput,
    signal?: AbortSignal): Promise<ProviderConnectionsRowMutationV1> {
    return admit(context, async (mode, material) => {
        const references = listProviderConnectionsCatalogSavedSecretRefsV1(input.catalog).map(reference => reference.secretId);
        const captures = await captureSavedSecretReferenceRevisionsInContext(context, { references, signal,
            savedSecretRevisions: input.savedSecretRevisions, pendingResourceIds: input.pendingResourceIds });
        context.assertCurrent();
        return ProviderConnectionsRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealProviderConnectionsContentV1({ mode, material, catalog: input.catalog, randomBytes: getRandomBytes }), ...captures,
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
    });
}
export async function writeProviderCatalogInContext(context: LazyActionAccountContext, input: ProviderCatalogWriteInput,
    signal?: AbortSignal): Promise<ProviderCatalogMutationResponse> {
    const mutation = await prepareProviderCatalogMutationInContext(context, input, signal);
    context.assertCurrent();
    let response: Response;
    try {
        response = await context.request(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal,
        }, { retry: 'none' });
    } catch (error) { throw new ProviderCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error); }
    const result = ProviderConnectionsRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new ProviderCatalogOperationError(response.ok ? 'outcome_unknown' : `provider_catalog_http_${response.status}`);
    return result.data;
}
export function writeProviderCatalog(scope: ServerAccountScope, input: ProviderCatalogWriteInput, signal?: AbortSignal): Promise<ProviderCatalogMutationResponse> {
    return withAccount(scope, signal, context => writeProviderCatalogAndPublishInContext(context, input, signal));
}
export async function writeProviderCatalogAndPublishInContext(context: LazyActionAccountContext, input: ProviderCatalogWriteInput,
    signal?: AbortSignal): Promise<ProviderCatalogMutationResponse> {
    const result = await writeProviderCatalogInContext(context, input, signal);
    if (result.status === 'updated') {
        const { invalidateProviderCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/providerCatalogEngine');
        try { await invalidateProviderCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId }, context.assertAccountCurrent); }
        catch { /* A projection failure cannot erase the durable row receipt. */ }
    }
    return result;
}
