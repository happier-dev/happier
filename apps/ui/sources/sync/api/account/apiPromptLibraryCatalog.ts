import { loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyRoleOverrideMutationV1, type RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createRoleArtifactStoreV1, retainLegacyRoleArtifactsV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema, PromptLibraryRowMutationV1Schema,
    PromptLibraryRowMutationResponseV1Schema, sealPromptLibraryContentV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import type { PromptLibraryCatalogProjection } from '@/sync/store/settings/promptLibraryCatalogSnapshot';

export type PromptLibraryAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
export type PromptLibraryRowMutationResponseV1 = ReturnType<typeof PromptLibraryRowMutationResponseV1Schema.parse>;
export class PromptLibraryRowOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'PromptLibraryRowOperationError'; }
}
export function requireUpdatedPromptLibraryMutation(result: PromptLibraryRowMutationResponseV1): asserts result is Extract<PromptLibraryRowMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new PromptLibraryRowOperationError(result.status, result);
}
async function admit<T>(context: PromptLibraryAccountContext, operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    const material = storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
    return operation(storage.mode, material);
}
async function withAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: PromptLibraryAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new PromptLibraryRowOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
function failure(error: unknown, signal?: AbortSignal): PromptLibraryCatalogSnapshotV1 {
    if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    const code = error instanceof Error ? 'code' in error ? error.code : error.message : undefined;
    if (code === 'scope-retired' || code === 'action_account_scope_changed' || code === 'action_home_not_found') return { status: 'unavailable', reason: 'scope-retired' };
    if (code === 'unauthorized' || code === 'action_home_signed_out') return { status: 'unavailable', reason: 'unauthorized' };
    if (code === 'forbidden' || code === 'unsupported') return { status: 'unavailable', reason: code };
    if (code === 'account-mode-mismatch') return { status: 'unavailable', reason: code };
    if (code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable') return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    if (error instanceof Error && error.name === 'ZodError') return { status: 'unavailable', reason: 'invalid-stored-content' };
    return { status: 'unavailable', reason: 'unreachable' };
}
async function readRows(context: PromptLibraryAccountContext, signal?: AbortSignal) {
    const response = await context.request(PROMPT_LIBRARY_ROWS_ROUTE_V1, { method: 'GET', signal }, { retry: 'none' });
    context.assertCurrent();
    if (!response.ok) throw new PromptLibraryRowOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const parsed = PromptLibraryRowsListResponseV1Schema.parse(await response.json());
    context.assertCurrent();
    return parsed;
}
type PromptLibraryReadPublication = Readonly<{
    onReady?: (projection: PromptLibraryCatalogProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;
export async function readPromptLibraryCatalogProjectionInContext(context: PromptLibraryAccountContext, signal?: AbortSignal,
    publication?: PromptLibraryReadPublication): Promise<PromptLibraryCatalogProjection> {
    try {
        return await admit(context, async (mode, material) => {
            const source: { value: Awaited<ReturnType<typeof readAccountSettingsBaseline>> | null } = { value: null };
            const project = async (catalog: PromptLibraryCatalogSnapshotV1): Promise<PromptLibraryCatalogProjection> => {
                const { encryption } = await context.resolveAccountEncryption();
                const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
                context.assertCurrent();
                return { catalog: current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' },
                    rawSettings: source.value?.raw ?? {}, sourceSettingsVersion: source.value?.version ?? 0 };
            };
            const catalog = await loadPromptLibraryCatalogV1({ mode, material, signal, readRows: () => readRows(context, signal),
                hasPendingCleanup: publication?.hasPendingCleanup,
                ...(publication?.onReady ? { onReadyBeforeCleanup: async catalog => {
                    const projection = await project(catalog);
                    publication.onReady!(projection, context.accountLifetime.isCurrent);
                } } : {}), transfer: {
                readSourceSnapshot: async () => {
                    const { encryption } = await context.resolveAccountEncryption();
                    source.value = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                        request: (path, init) => context.request(path, init, { retry: 'none' }) });
                    context.assertCurrent();
                    return { raw: source.value.raw ?? {}, version: source.value.version };
                },
                initializeRecord: input => writePromptLibraryRecordInContext(context, input, signal),
                replaceSource: async input => {
                    context.assertCurrent();
                    const result = await context.mutateRawSettings(() => ({ ...input.raw }), {
                        expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                    });
                    context.assertCurrent();
                    return result;
                },
                retainLegacyRoleArtifacts: raw => retainLegacyRoleArtifactsV1({ rawSettings: raw, accountId: context.accountId,
                    artifactStore: createRoleArtifactStoreV1(context.workflowArtifacts), signal }),
                normalizeHistory: async input => normalizeAccountSettingsHistoryAfterTransfer({
                    credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                    settingsScope: { serverId: context.serverId, accountId: context.accountId },
                    destinationAuthority: input,
                    requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                }),
            } });
            return project(catalog);
        });
    } catch (error) { return { catalog: failure(error, signal), rawSettings: {}, sourceSettingsVersion: 0 }; }
}
export async function readPromptLibraryCatalogProjection(scope: ServerAccountScope, signal?: AbortSignal,
    assertCapturedAccountCurrent?: () => void, publication?: PromptLibraryReadPublication): Promise<PromptLibraryCatalogProjection> {
    try {
        assertCapturedAccountCurrent?.();
        return await withAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.();
            return readPromptLibraryCatalogProjectionInContext(context, signal, publication);
        });
    }
    catch (error) { return { catalog: failure(error, signal), rawSettings: {}, sourceSettingsVersion: 0 }; }
}

export type PromptLibraryRecordWriteInput = Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }>;
/** Every screen/Action uses the same captured Account CAS; ambiguity is never replayed blindly. */
export function writePromptLibraryRecordInContext(context: PromptLibraryAccountContext, input: PromptLibraryRecordWriteInput,
    signal?: AbortSignal): Promise<PromptLibraryRowMutationResponseV1> {
    return admit(context, async (mode, material) => {
        if (input.expectedRevision === 'absent' && input.sourceSettingsVersion === undefined) throw new PromptLibraryRowOperationError('source-currentness-unavailable');
        const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealPromptLibraryContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
        context.assertCurrent();
        let response: Response;
        try {
            response = await context.request(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${encodeURIComponent(input.record.key)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal,
            }, { retry: 'none' });
        } catch (error) {
            throw new PromptLibraryRowOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
        }
        const parsed = PromptLibraryRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new PromptLibraryRowOperationError(response.ok ? 'outcome_unknown' : `prompt_library_row_http_${response.status}`);
        return parsed.data;
    });
}
export function writePromptLibraryRecord(scope: ServerAccountScope, input: PromptLibraryRecordWriteInput,
    signal?: AbortSignal): Promise<PromptLibraryRowMutationResponseV1> {
    return withAccount(scope, signal, context => writePromptLibraryRecordAndPublishInContext(context, input, signal));
}
/** Authoring Actions borrow their admitted Account and the same post-receipt publication owner. */
export async function writePromptLibraryRecordAndPublishInContext(context: PromptLibraryAccountContext,
    input: PromptLibraryRecordWriteInput, signal?: AbortSignal): Promise<PromptLibraryRowMutationResponseV1> {
    const { invalidatePromptLibraryCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
    const result = await writePromptLibraryRecordInContext(context, input, signal);
    if (result.status === 'updated' || result.status === 'conflict') {
        try { await invalidatePromptLibraryCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId },
            context.assertAccountCurrent); }
        catch { /* Projection failure cannot erase the received CAS outcome. */ }
    }
    return result;
}

/** Role Actions use the same closed semantic operation and sole row CAS as library authoring. */
export async function mutatePromptLibraryRoleOverrideInContext(context: PromptLibraryAccountContext,
    mutation: RoleOverrideMutationV1, signal?: AbortSignal): Promise<void> {
    const projection = await readPromptLibraryCatalogProjectionInContext(context, signal);
    const read = readPromptLibraryCatalogRecordV1({ catalog: projection.catalog, key: 'role-overrides', rawSettings: projection.rawSettings });
    if (read.status !== 'ready' || read.record.key !== 'role-overrides') throw new PromptLibraryRowOperationError(
        read.status === 'unavailable' ? read.reason : 'invalid-stored-content');
    const result = await writePromptLibraryRecordAndPublishInContext(context, {
        record: { key: 'role-overrides', value: { v: 1, ...applyRoleOverrideMutationV1({ overrides: read.record.value.overrides }, mutation) } },
        expectedRevision: read.revision,
        ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}),
    }, signal);
    requireUpdatedPromptLibraryMutation(result);
}
export function mutatePromptLibraryRoleOverride(scope: ServerAccountScope, mutation: RoleOverrideMutationV1,
    signal?: AbortSignal): Promise<void> {
    return withAccount(scope, signal, context => mutatePromptLibraryRoleOverrideInContext(context, mutation, signal));
}
