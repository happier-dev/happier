import { loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { applyRoleOverrideMutationV1, type RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createRoleArtifactStoreV1, retainLegacyRoleArtifactsV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema, PromptLibraryRowMutationV1Schema,
    PromptLibraryRowMutationResponseV1Schema, PromptLibraryRowReadResponseV1Schema, sealPromptLibraryContentV1,
    PromptLibraryRowsInitializationV1Schema, PromptLibraryRowsInitializationResponseV1Schema,
    type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1, type PromptLibraryRowsInitializationResponseV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext, resolveAccountStorageContextForDisclosure } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { applyPromptLibraryCatalogAcknowledgedRecord, type PromptLibraryCatalogProjection } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { captureSavedSecretReferenceRevisionsInContext } from './apiSavedSecretCatalog';
import { listSavedSecretReferenceCatalogRefsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createScopedResolutionSingleFlight, type ScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

export type PromptLibraryAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
export type PromptLibraryRowMutationResponseV1 = ReturnType<typeof PromptLibraryRowMutationResponseV1Schema.parse>;
const catalogReads = createScopedResolutionSingleFlight<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>>();
// Coalesce before Account admission can stagger sibling finite reads. Authority
// stays with this exact captured context; neutral wire sharing remains separate.
const finiteCatalogAcquisitions = createScopedResolutionSingleFlight<PromptLibraryCatalogProjection>();
const rowReads = createScopedResolutionSingleFlight<ReturnType<typeof PromptLibraryRowReadResponseV1Schema.parse>>();
export class PromptLibraryRowOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'PromptLibraryRowOperationError'; }
}
export function requireUpdatedPromptLibraryMutation(result: PromptLibraryRowMutationResponseV1): asserts result is Extract<PromptLibraryRowMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new PromptLibraryRowOperationError(result.status, result);
}
async function admit<T>(context: PromptLibraryAccountContext, usage: 'identity' | 'fresh-authority',
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage });
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
    return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
}
function readCatalogResource<T>(context: PromptLibraryAccountContext, path: string, parse: (value: unknown) => T,
    reads: ScopedResolutionSingleFlight<T>, signal?: AbortSignal): Promise<T> {
    return withActionAccountRequestSignal(context, signal, async signal => {
        context.assertCurrent();
        throwIfAborted(signal);
        const consume = async (response: Response) => {
            if (!response.ok) throw new PromptLibraryRowOperationError(response.status === 401 ? 'unauthorized'
                : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
            return parse(await response.json());
        };
        const transport = context.readTransport;
        const binding = transport?.key;
        const parsed = transport && binding
            ? await reads.run(path, sharedSignal => transport.read(path, { method: 'GET', signal: sharedSignal }, { retry: 'none' }, consume),
                { scope: transport.scope ? [transport.scope, binding] : binding, signal })
            : await consume(await context.request(path, { method: 'GET', signal }, { retry: 'none' }));
        throwIfAborted(signal);
        context.assertCurrent();
        return parsed;
    });
}
function readRows(context: PromptLibraryAccountContext, signal?: AbortSignal) {
    return readCatalogResource(context, PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema.parse, catalogReads, signal);
}
type PromptLibraryReadPublication = Readonly<{
    onReady?: (projection: PromptLibraryCatalogProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;
async function readPromptLibraryCatalogWithMaintenanceInContext(context: PromptLibraryAccountContext, signal?: AbortSignal,
    publication?: PromptLibraryReadPublication): Promise<PromptLibraryCatalogProjection> {
    const artifactStore = createRoleArtifactStoreV1({ ...context.workflowArtifacts, read: context.readArtifactContent });
    try {
        return await admit(context, 'identity', async (mode, material) => {
            const source: { value: Awaited<ReturnType<typeof readAccountSettingsBaseline>> | null } = { value: null };
            const project = async (catalog: PromptLibraryCatalogSnapshotV1): Promise<PromptLibraryCatalogProjection> => {
                const { encryption } = await context.resolveAccountEncryption();
                const current = await resolveAccountStorageContextForDisclosure(context.credentials, { encryption, request: context.request });
                context.assertCurrent();
                return { catalog: current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' },
                    rawSettings: source.value?.raw ?? {}, sourceSettingsVersion: source.value?.version ?? 0 };
            };
            const catalog = await loadPromptLibraryCatalogV1({ mode, material, signal, readRows: () => readRows(context, signal),
                // Finite Actions need current destination rows and required migration,
                // while the observed catalog loader owns retained-source/history cleanup.
                ...(publication?.onReady ? {} : { maintainSource: false }),
                skillMigration: {
                    writeRecord: input => writePromptLibraryRecordInContext(context, input, signal),
                    readArtifact: async ref => {
                        if (ref.serverId !== undefined && !areServerProfileIdentifiersEquivalent(ref.serverId, context.serverId)) return null;
                        context.assertCurrent();
                        const artifact = await artifactStore.read(ref.artifactId, { signal });
                        context.assertCurrent();
                        return artifact;
                    },
                },
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
                initializeRecords: input => initializePromptLibraryRecordsInContext(context, input, signal),
                replaceSource: async input => {
                    context.assertCurrent();
                    const result = await context.mutateRawSettings(() => ({ ...input.raw }), {
                        expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                    });
                    context.assertCurrent();
                    return result;
                },
                retainLegacyRoleArtifacts: raw => retainLegacyRoleArtifactsV1({ rawSettings: raw, accountId: context.accountId,
                    artifactStore, signal }),
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
/** Finite Actions borrow admitted rows; the existing Account watch owns the cleanup tail. */
export function readPromptLibraryCatalogProjectionInContext(context: PromptLibraryAccountContext, signal?: AbortSignal,
    publication?: PromptLibraryReadPublication): Promise<PromptLibraryCatalogProjection> {
    if (publication) return readPromptLibraryCatalogWithMaintenanceInContext(context, signal, publication);
    return withActionAccountRequestSignal(context, signal, async signal => {
        context.assertCurrent();
        throwIfAborted(signal);
        const transport = context.readTransport;
        const projection = await finiteCatalogAcquisitions.run(PROMPT_LIBRARY_ROWS_ROUTE_V1,
            sharedSignal => readPromptLibraryCatalogWithMaintenanceInContext(context, sharedSignal), {
                scope: transport ? [context, transport.key] : context, signal,
            });
        throwIfAborted(signal);
        context.assertCurrent();
        return projection;
    }).catch((error: unknown) => ({ catalog: failure(error, signal), rawSettings: {}, sourceSettingsVersion: 0 }));
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

export type PromptLibraryRecordWriteInput = Readonly<{ record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    savedSecretRevisions?: readonly Readonly<{resourceId:string;expectedRevision:number}>[];pendingResourceIds?:readonly string[] }>;
/** Raw destination read for reference census; it never activates or cleans retained sources. */
export async function readPromptLibraryRowInContext(context: PromptLibraryAccountContext, key: PromptLibraryCatalogKeyV1,
    signal?: AbortSignal) {
    return readCatalogResource(context, `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${encodeURIComponent(key)}`,
        PromptLibraryRowReadResponseV1Schema.parse, rowReads, signal);
}

/** Read only demanded active rows, with the same Account admission and envelope decoder as the catalog. */
export async function readPromptLibraryCatalogRowsProjection(scope: ServerAccountScope, keys: readonly PromptLibraryCatalogKeyV1[]): Promise<Readonly<{
    projection: PromptLibraryCatalogProjection; isAccountCurrent: () => boolean;
}> | null> {
    try {
        return await withAccount(scope, undefined, context => admit(context, 'identity', async (mode, material) => {
            let absent = false;
            const catalog = await loadPromptLibraryCatalogV1({ mode, material, readRows: async () => {
                const reads = await Promise.all(keys.map(async key => ({ key, row: await readPromptLibraryRowInContext(context, key) })));
                const rows: Extract<ReturnType<typeof PromptLibraryRowsListResponseV1Schema.parse>, { status: 'listed' }>['rows'] = [];
                for (const { key, row } of reads) {
                    if (row.status === 'absent') { absent = true; continue; }
                    if (row.status !== 'present' && row.status !== 'deleted') return row;
                    rows.push({ key, revision: row.revision, content: row.status === 'present' ? row.content : null });
                }
                return { status: 'listed', rows };
            } });
            const { encryption } = await context.resolveAccountEncryption();
            const current = await resolveAccountStorageContextForDisclosure(context.credentials, { encryption, request: context.request });
            context.assertCurrent();
            const projection: PromptLibraryCatalogProjection = { catalog: current.mode === mode ? catalog
                : { status: 'unavailable', reason: 'account-mode-mismatch' }, rawSettings: {}, sourceSettingsVersion: 0 };
            // An absent destination still needs the canonical source activation/migration path.
            return absent && current.mode === mode ? null : { projection, isAccountCurrent: context.accountLifetime.isCurrent };
        }));
    } catch (error) { return { projection: { catalog: failure(error), rawSettings: {}, sourceSettingsVersion: 0 }, isAccountCurrent: () => true }; }
}

/** One admitted Account's sealed row content and saved-secret reference proofs. */
async function sealPromptLibraryRecordInAdmission(context: PromptLibraryAccountContext, mode: 'plain' | 'e2ee',
    material: AccountScopedCryptoMaterial | null, input: Pick<PromptLibraryRecordWriteInput, 'record' | 'savedSecretRevisions' | 'pendingResourceIds'>,
    signal?: AbortSignal) {
    const references=input.record.key==='registry-sources'?listSavedSecretReferenceCatalogRefsV1({profileRecords:[],registrySources:input.record.value}).map(ref=>ref.secretId):[];
    const proofs=references.length?await captureSavedSecretReferenceRevisionsInContext(context,{references:references.filter(ref=>parseSavedSecretRefV1(ref).kind==='shared_resource'),
        savedSecretRevisions:input.savedSecretRevisions,pendingResourceIds:input.pendingResourceIds,signal}):null;
    return { content: sealPromptLibraryContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
        ...(proofs?{referencedSavedSecretIds:references,savedSecretRevisions:proofs.savedSecretRevisions}:{}) };
}
/** Preparation is shared by the sole row writer and atomic credential promotion. */
export function preparePromptLibraryRecordMutationInContext(context: PromptLibraryAccountContext, input: PromptLibraryRecordWriteInput, signal?:AbortSignal) {
    return admit(context, 'fresh-authority', async (mode, material) => {
        if (input.expectedRevision === 'absent' && input.sourceSettingsVersion === undefined) throw new PromptLibraryRowOperationError('source-currentness-unavailable');
        const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            ...await sealPromptLibraryRecordInAdmission(context, mode, material, input, signal),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
        context.assertCurrent();
        return mutation;
    });
}
/** A subsequent read must not join a pre-write request, even when the issued mutation's response is lost. */
function invalidatePromptLibraryReads(context: PromptLibraryAccountContext): void {
    finiteCatalogAcquisitions.invalidate(context);
    const transport = context.readTransport;
    if (transport) {
        const scope = transport.scope ? [transport.scope, transport.key] : transport.key;
        catalogReads.invalidate(scope);
        rowReads.invalidate(scope);
    }
}
/**
 * First activation writes every absent row in one Account write: one admission (encryption currentness),
 * one request and one change publication instead of one of each per row.
 */
async function initializePromptLibraryRecordsInContext(context: PromptLibraryAccountContext,
    input: Readonly<{ records: readonly PromptLibraryRecordV1[]; sourceSettingsVersion: number }>,
    signal?: AbortSignal): Promise<PromptLibraryRowsInitializationResponseV1> {
    const body = await admit(context, 'fresh-authority', async (mode, material) => {
        const rows = [];
        for (const record of input.records) rows.push({ key: record.key, ...await sealPromptLibraryRecordInAdmission(context, mode, material, { record }, signal) });
        const initialization = PromptLibraryRowsInitializationV1Schema.parse({ sourceSettingsVersion: input.sourceSettingsVersion, rows });
        context.assertCurrent();
        return initialization;
    });
    let response: Response;
    try {
        response = await context.request(PROMPT_LIBRARY_ROWS_ROUTE_V1, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
        }, { retry: 'none' });
    } catch (error) {
        throw new PromptLibraryRowOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
    } finally { invalidatePromptLibraryReads(context); }
    const parsed = PromptLibraryRowsInitializationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new PromptLibraryRowOperationError(response.ok ? 'outcome_unknown' : `prompt_library_row_http_${response.status}`);
    return parsed.data;
}
/** Every screen/Action uses the same captured Account CAS; ambiguity is never replayed blindly. */
export function writePromptLibraryRecordInContext(context: PromptLibraryAccountContext, input: PromptLibraryRecordWriteInput,
    signal?: AbortSignal): Promise<PromptLibraryRowMutationResponseV1> {
    return (async () => {
        let mutation: Awaited<ReturnType<typeof preparePromptLibraryRecordMutationInContext>>;
        try {
            mutation = await preparePromptLibraryRecordMutationInContext(context, input, signal);
            context.assertCurrent();
        } catch (error) {
            if (error instanceof PromptLibraryRowOperationError) throw error;
            const classified = failure(error, signal);
            // No row mutation was issued. Keep known preparation refusals in
            // the same typed boundary used to retain earlier effect receipts.
            if (classified.status === 'unavailable' && classified.reason !== 'unreachable')
                throw new PromptLibraryRowOperationError(classified.reason, error);
            throw error;
        }
        let response: Response;
        try {
            response = await context.request(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${encodeURIComponent(input.record.key)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal,
            }, { retry: 'none' });
        } catch (error) {
            throw new PromptLibraryRowOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
        } finally { invalidatePromptLibraryReads(context); }
        const parsed = PromptLibraryRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new PromptLibraryRowOperationError(response.ok ? 'outcome_unknown' : `prompt_library_row_http_${response.status}`);
        return parsed.data;
    })();
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
        try {
            context.assertAccountCurrent();
            const scope = { serverId: context.serverId, accountId: context.accountId };
            if (result.status === 'updated') applyPromptLibraryCatalogAcknowledgedRecord(scope, input.record, result.revision, true);
            if (result.status === 'conflict') {
                fireAndForget(invalidatePromptLibraryCatalogAfterAcknowledgedMutation(scope, context.assertAccountCurrent),
                    { tag: 'promptLibraryCatalog.afterAcknowledgedMutation' });
            }
        }
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
