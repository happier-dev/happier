import {
    MCP_SERVER_CATALOG_ROWS_ROUTE_V1,
    McpServerCatalogRowReadResponseV1Schema,
    McpServerCatalogRowMutationV1Schema,
    McpServerCatalogRowMutationResponseV1Schema,
    McpServerCatalogV1Schema,
    sealMcpServerCatalogContentV1,
    listMcpServerCatalogSavedSecretRefsV1,
    type McpServerCatalogV1,
    type McpServerCatalogRowMutationV1,
    type McpServerCatalogRowMutationResponseV1,
    type McpServerCatalogRowReadResponseV1,
} from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { loadMcpServerCatalogV1, commitMcpServerCatalogMutationV1, readRetainedMcpServerCatalogSourceV1,
    type McpServerCatalogSnapshotV1, type McpServerCatalogMutationV1,
    type McpServerCatalogMutationResponseV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { captureSavedSecretReferenceRevisionsInContext } from './apiSavedSecretCatalog';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type McpServerCatalogAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;

export class McpServerCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) {
        super(code);
        this.name = 'McpServerCatalogOperationError';
    }
}

/** Transport-only inventory read: conversion and secret census must not activate a source. */
export async function fetchMcpServerCatalogRowV1(input: Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
    assertCurrent?: () => void;
}>): Promise<McpServerCatalogRowReadResponseV1> {
    input.assertCurrent?.();
    const response = await input.request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { method: 'GET', signal: input.signal });
    input.assertCurrent?.();
    if (!response.ok) throw new McpServerCatalogOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const result = McpServerCatalogRowReadResponseV1Schema.parse(await response.json());
    input.assertCurrent?.();
    return result;
}

/** Borrow the caller's exact Account lifetime, without importing or cleaning retained Settings. */
export function readMcpServerCatalogRowInContext(context: McpServerCatalogAccountContext,
    signal?: AbortSignal): Promise<McpServerCatalogRowReadResponseV1> {
    return fetchMcpServerCatalogRowV1({ signal, assertCurrent: context.assertCurrent,
        request: (path, init) => context.request(path, init, { retry: 'none' }) });
}

async function admit<T>(context: McpServerCatalogAccountContext,
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return operation(storage.mode, storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials));
}

async function withAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: McpServerCatalogAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new McpServerCatalogOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}

export function classifyMcpServerCatalogReadFailure(error: unknown, signal?: AbortSignal):
    Extract<McpServerCatalogSnapshotV1, { status: 'unavailable' }> {
    if (signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
    const code = error instanceof Error ? 'code' in error ? error.code : error.message : undefined;
    if (code === 'scope-retired' || code === 'action_account_scope_changed' || code === 'action_home_not_found') return { status: 'unavailable', reason: 'scope-retired' };
    if (code === 'unauthorized' || code === 'action_home_signed_out') return { status: 'unavailable', reason: 'unauthorized' };
    if (code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' || code === 'invalid-reference') return { status: 'unavailable', reason: code };
    if (code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable'
        || code === 'encryption-material-unavailable') return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    if (error instanceof Error && error.name === 'ZodError') return { status: 'unavailable', reason: 'invalid-stored-content' };
    return { status: 'unavailable', reason: 'unreachable' };
}

async function checkMcpServerCatalogAccountMode(context: McpServerCatalogAccountContext, mode: 'plain' | 'e2ee',
    snapshot: McpServerCatalogSnapshotV1): Promise<McpServerCatalogSnapshotV1> {
    const { encryption } = await context.resolveAccountEncryption();
    const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return current.mode === mode ? snapshot : { status: 'unavailable', reason: 'account-mode-mismatch' };
}

type ReadPublication = Readonly<{
    onReady?: (snapshot: McpServerCatalogSnapshotV1, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;

/** Only an absent destination consults retained Settings; personal refs first require SavedSecret admission. */
async function readMcpServerCatalogWithMaintenanceInContext(context: McpServerCatalogAccountContext,
    signal: AbortSignal | undefined, publication: ReadPublication | undefined,
    finishReady: (snapshot: McpServerCatalogSnapshotV1) => void): Promise<McpServerCatalogSnapshotV1> {
    try {
        return await admit(context, async (mode, material) => {
            const readSourceSnapshot = async () => {
                const { encryption } = await context.resolveAccountEncryption();
                const source = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                    request: (path, init) => context.request(path, { ...init, signal }, { retry: 'none' }) });
                context.assertCurrent();
                return { raw: source.raw ?? {}, version: source.version };
            };
            let first: McpServerCatalogRowReadResponseV1 | undefined = await readMcpServerCatalogRowInContext(context, signal);
            if (first.status === 'absent') {
                const retained = readRetainedMcpServerCatalogSourceV1((await readSourceSnapshot()).raw);
                if (retained.status === 'opened') {
                    let needsPersonalImport: boolean;
                    try {
                        needsPersonalImport = listMcpServerCatalogSavedSecretRefsV1(retained.catalog)
                            .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal');
                    } catch { return { status: 'unavailable', reason: 'invalid-reference' }; }
                    if (needsPersonalImport) {
                        const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                        const imported = await importLegacySavedSecretsInContext(context, mode, { serverId: context.serverId, accountId: context.accountId });
                        context.assertCurrent();
                        if (imported.status !== 'complete') return { status: 'unavailable', reason: 'invalid-reference' };
                        first = await readMcpServerCatalogRowInContext(context, signal);
                    }
                }
            }
            const result = await loadMcpServerCatalogV1({ mode, material, signal,
                readRow: () => {
                    const initial = first;
                    first = undefined;
                    return initial ? Promise.resolve(initial) : readMcpServerCatalogRowInContext(context, signal);
                }, hasPendingCleanup: publication?.hasPendingCleanup,
                onReadyBeforeCleanup: async snapshot => {
                    const admitted = await checkMcpServerCatalogAccountMode(context, mode, snapshot);
                    publication?.onReady?.(admitted, context.accountLifetime.isCurrent);
                    finishReady(admitted);
                }, transfer: {
                    readSourceSnapshot,
                    initializeCatalog: input => writeMcpServerCatalogInContext(context, input, signal),
                    replaceSource: async input => {
                        context.assertCurrent();
                        const receipt = await context.mutateRawSettings(() => ({ ...input.raw }), {
                            expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                        });
                        context.assertCurrent();
                        return receipt;
                    },
                    normalizeHistory: async input => normalizeAccountSettingsHistoryAfterTransfer({
                        credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                        settingsScope: { serverId: context.serverId, accountId: context.accountId }, destinationAuthority: input,
                        requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                    }),
                } });
            return checkMcpServerCatalogAccountMode(context, mode, result);
        });
    } catch (error) { return classifyMcpServerCatalogReadFailure(error, signal); }
}

export async function readMcpServerCatalogInContext(context: McpServerCatalogAccountContext, signal?: AbortSignal,
    publication?: ReadPublication): Promise<McpServerCatalogSnapshotV1> {
    let finishReady!: (snapshot: McpServerCatalogSnapshotV1) => void;
    const ready = new Promise<McpServerCatalogSnapshotV1>(resolve => { finishReady = resolve; });
    const read = () => readMcpServerCatalogWithMaintenanceInContext(context, signal, publication, finishReady);
    // The engine owns full maintenance completion. Finite borrowers can return
    // the admitted projection while runPrepared retains its exact Account watch.
    if (publication?.onReady) return read();
    const completion = context.runPrepared(read).catch(error => classifyMcpServerCatalogReadFailure(error, signal));
    return Promise.race([ready, completion]);
}

export async function readMcpServerCatalog(scope: ServerAccountScope, signal?: AbortSignal,
    assertCapturedAccountCurrent?: () => void, publication?: ReadPublication): Promise<McpServerCatalogSnapshotV1> {
    try {
        assertCapturedAccountCurrent?.();
        return await withAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.();
            return readMcpServerCatalogInContext(context, signal, publication);
        });
    } catch (error) { return classifyMcpServerCatalogReadFailure(error, signal); }
}

export type McpServerCatalogWriteInput = Readonly<{
    catalog: McpServerCatalogV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    expectedMode?: 'plain' | 'e2ee'; savedSecretRevisions?: McpServerCatalogRowMutationV1['savedSecretRevisions'];
    pendingResourceIds?: readonly string[];
}>;

/** Composite resource transactions use this same crypto/reference producer, without a separate write. */
export function prepareMcpServerCatalogMutationInContext(context: McpServerCatalogAccountContext,
    input: McpServerCatalogWriteInput, signal?: AbortSignal): Promise<McpServerCatalogRowMutationV1> {
    return admit(context, async (mode, material) => {
        if (input.expectedMode !== undefined && input.expectedMode !== mode) throw new McpServerCatalogOperationError('account-mode-mismatch');
        const catalog = McpServerCatalogV1Schema.parse(input.catalog);
        const proofs = await captureSavedSecretReferenceRevisionsInContext(context, {
            references: listMcpServerCatalogSavedSecretRefsV1(catalog).map(reference => reference.secretId),
            savedSecretRevisions: input.savedSecretRevisions, pendingResourceIds: input.pendingResourceIds, signal,
        });
        context.assertCurrent();
        return McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealMcpServerCatalogContentV1({ catalog, mode, material, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }), ...proofs });
    });
}

export async function writeMcpServerCatalogInContext(context: McpServerCatalogAccountContext,
    input: McpServerCatalogWriteInput, signal?: AbortSignal): Promise<McpServerCatalogRowMutationResponseV1> {
    const mutation = await prepareMcpServerCatalogMutationInContext(context, input, signal);
    context.assertCurrent();
    let response: Response;
    try {
        response = await context.request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation) }, { retry: 'none' });
    } catch (error) { throw new McpServerCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error); }
    const parsed = McpServerCatalogRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new McpServerCatalogOperationError(response.ok ? 'outcome_unknown' : `mcp_catalog_http_${response.status}`);
    return parsed.data;
}

export async function writeMcpServerCatalogAndPublishInContext(context: McpServerCatalogAccountContext,
    input: McpServerCatalogWriteInput, signal?: AbortSignal): Promise<McpServerCatalogRowMutationResponseV1> {
    const result = await writeMcpServerCatalogInContext(context, input, signal);
    if (result.status === 'updated') {
        const { invalidateMcpServerCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
        try { await invalidateMcpServerCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId }, context.assertAccountCurrent); }
        catch { /* A refresh failure cannot erase the durable authoring receipt. */ }
    }
    return result;
}

export function writeMcpServerCatalog(scope: ServerAccountScope, input: McpServerCatalogWriteInput,
    signal?: AbortSignal): Promise<McpServerCatalogRowMutationResponseV1> {
    return withAccount(scope, signal, context => writeMcpServerCatalogAndPublishInContext(context, input, signal));
}

export function requireUpdatedMcpServerCatalogMutation(result: McpServerCatalogRowMutationResponseV1):
    asserts result is Extract<McpServerCatalogRowMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new McpServerCatalogOperationError(result.status, result);
}

export async function mutateMcpServerCatalogInContext(context: McpServerCatalogAccountContext,
    input: Readonly<{ expectedRevision: number | 'absent'; change: McpServerCatalogMutationV1 }>,
    signal?: AbortSignal): Promise<McpServerCatalogMutationResponseV1> {
    let snapshot: McpServerCatalogSnapshotV1;
    try {
        snapshot = await admit(context, async (mode, material) => checkMcpServerCatalogAccountMode(context, mode,
            await loadMcpServerCatalogV1({ mode, material, signal,
                readRow: () => readMcpServerCatalogRowInContext(context, signal) })));
    } catch (error) {
        throw new McpServerCatalogOperationError(classifyMcpServerCatalogReadFailure(error, signal).reason, error);
    }
    if (snapshot.status !== 'ready' || snapshot.authority !== 'active' || snapshot.revision === 'absent') {
        throw new McpServerCatalogOperationError(snapshot.status === 'unavailable' ? snapshot.reason : 'authority-not-confirmed');
    }
    if (snapshot.revision !== input.expectedRevision) return { status: 'conflict', revision: snapshot.revision };
    return commitMcpServerCatalogMutationV1({ catalog: snapshot.catalog, revision: snapshot.revision, change: input.change,
        scope: { serverId: context.serverId, accountId: context.accountId },
        writeCatalog: value => writeMcpServerCatalogAndPublishInContext(context, value, signal) });
}
