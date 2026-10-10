import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema, AcpCatalogRowMutationV1Schema,
    AcpCatalogRowMutationResponseV1Schema, AcpCatalogRecordV1Schema, openAcpCatalogContentV1, sealAcpCatalogContentV1,
    readFreshAcpCatalogSourceV1, listAcpCatalogSavedSecretRefsV1, rewriteAcpCatalogSavedSecretRefsV1,
    type AcpCatalogRecordV1, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { prepareAcpCatalogTransferV2, readAcpCatalogTransferSourceV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import type { AcpCatalogCleanupV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { KIRO_ACP_STDERR_RULES } from '@happier-dev/plugins-kiro/agent/acp/transport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ServerFetch } from '@/sync/http/client';
import { captureSavedSecretReferenceRevisionsInContext, type SavedSecretReferenceRevisionProof } from './apiSavedSecretCatalog';
import { sealAccountSettingsCleanup } from '@/sync/engine/settings/sealAccountSettingsCleanup';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';

export type AcpCatalogAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
export type AcpCatalogProjection = Readonly<{ catalog: AcpCatalogSnapshotV1;
    source?: Readonly<{ raw: Readonly<Record<string, unknown>>; version: number; mode: 'plain' | 'e2ee' }> }>;
type AcpCatalogWireMutationResponseV1 = ReturnType<typeof AcpCatalogRowMutationResponseV1Schema.parse>;
export type AcpCatalogRowMutationResponseV1 = Exclude<AcpCatalogWireMutationResponseV1, { status: 'updated' }>
    | (Extract<AcpCatalogWireMutationResponseV1, { status: 'updated' }> & Readonly<{ cleanup?: AcpCatalogCleanupV1 }>);
export class AcpCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'AcpCatalogOperationError'; }
}
async function admit<T>(context: AcpCatalogAccountContext,
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    return operation(storage.mode, storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials));
}
async function withAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: AcpCatalogAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new AcpCatalogOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
function failure(error: unknown, signal?: AbortSignal): AcpCatalogProjection {
    const reason = classifyAccountStorageReadFailure(error, signal);
    return { catalog: { status: 'unavailable', reason: reason === 'unreachable' && error instanceof AcpCatalogOperationError
        ? error.code : reason } };
}
/** Captured row transport preserves absent versus tombstone for complete reference censuses. */
export async function readAcpCatalogRow(input: Readonly<{ request: ServerFetch; assertCurrent: () => void; signal?: AbortSignal }>) {
    input.assertCurrent();
    const response = await input.request(ACP_CATALOG_ROWS_ROUTE_V1, { method: 'GET', signal: input.signal }, { retry: 'none' });
    input.assertCurrent();
    if (!response.ok) throw new AcpCatalogOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const row = AcpCatalogRowReadResponseV1Schema.parse(await response.json());
    input.assertCurrent();
    return row;
}
export function readAcpCatalogRowInContext(context: AcpCatalogAccountContext, signal?: AbortSignal) {
    return readAcpCatalogRow({ request: context.request, assertCurrent: context.assertCurrent, signal });
}
/** Reads never write: characterized predecessor data is a captured projection, not destination authority. */
export async function readAcpCatalogInContext(context: AcpCatalogAccountContext, signal?: AbortSignal): Promise<AcpCatalogProjection> {
    try {
        return await admit(context, async (mode, material) => {
            const row = await readAcpCatalogRowInContext(context, signal);
            let catalog: AcpCatalogSnapshotV1;
            let capturedSource: AcpCatalogProjection['source'];
            if (row.status === 'present') {
                const opened = openAcpCatalogContentV1({ mode, material, content: row.content });
                catalog = opened.status === 'opened' ? { status: 'ready', record: opened.record, revision: row.revision } : opened;
            } else if (row.status === 'absent') {
                const { encryption } = await context.resolveAccountEncryption();
                const baseline = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                    request: (path, init) => context.request(path, init, { retry: 'none' }) });
                context.assertCurrent();
                const rawSettings = baseline.format === 'empty' ? {} : baseline.raw;
                if (rawSettings !== null) capturedSource = { raw: rawSettings, version: baseline.version, mode };
                const source = readFreshAcpCatalogSourceV1(rawSettings);
                if (source.status === 'ready') catalog = { status: 'ready', record: source.record, revision: 'absent', source: 'fresh', sourceSettingsVersion: baseline.version };
                else {
                    const transfer = prepareAcpCatalogTransferV2({ rawSettings, sourceSettingsVersion: baseline.version, kiroStderrRules: KIRO_ACP_STDERR_RULES });
                    catalog = transfer.status === 'ready' ? { status: 'ready', record: transfer.record, revision: 'absent', source: 'predecessor', sourceSettingsVersion: transfer.sourceSettingsVersion }
                        : transfer.status === 'partial' ? { status: 'partial', record: transfer.record, reason: transfer.reason, diagnostics: transfer.diagnostics }
                        : transfer.status === 'unavailable' ? transfer : source;
                }
            } else if (row.status === 'deleted') catalog = { status: 'ready', record: { v: 1, definitions: [] }, revision: row.revision };
            else catalog = { status: 'unavailable', reason: row.status };
            const { encryption } = await context.resolveAccountEncryption();
            const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
            context.assertCurrent();
            if (current.mode !== mode) return { catalog: { status: 'unavailable', reason: 'account-mode-mismatch' } };
            return { catalog,
                ...(capturedSource ? { source: capturedSource } : {}) };
        });
    } catch (error) { return failure(error, signal); }
}
export async function readAcpCatalog(scope: ServerAccountScope, signal?: AbortSignal): Promise<AcpCatalogProjection> {
    try { return await withAccount(scope, signal, context => readAcpCatalogInContext(context, signal)); }
    catch (error) { return failure(error, signal); }
}
export type AcpCatalogRecordWriteInput = Readonly<{ record: AcpCatalogRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    savedSecretRevisions?: readonly SavedSecretReferenceRevisionProof[]; pendingResourceIds?: readonly string[] }>;
export function requireUpdatedAcpCatalogMutation(result: AcpCatalogRowMutationResponseV1): asserts result is Extract<AcpCatalogRowMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new AcpCatalogOperationError(result.status, result);
}
/** Only explicit mutations demand personal material; the original source and exact S2 ACK retain CAS custody. */
async function prepareAcpCatalogSourceForMutationInContext(context: AcpCatalogAccountContext,
    projection: AcpCatalogProjection,
    expectation: Readonly<{ expectedRevision?: number | 'absent'; sourceSettingsVersion?: number }>, signal?: AbortSignal,
): Promise<Readonly<{ projection: AcpCatalogProjection; references?: ReadonlyMap<string, string>; sourceSettingsVersion?: number }>> {
    const { catalog, source } = projection;
    if (catalog.status !== 'unavailable' || catalog.reason !== 'saved-secret-unavailable' || !source) return { projection };
    if (expectation.expectedRevision !== undefined && expectation.expectedRevision !== 'absent') throw new AcpCatalogOperationError('conflict');
    if ((expectation.expectedRevision === 'absent' || expectation.sourceSettingsVersion !== undefined)
        && expectation.sourceSettingsVersion !== source.version) {
        throw new AcpCatalogOperationError('settings-conflict');
    }
    const original = readAcpCatalogTransferSourceV2({ rawSettings: source.raw, sourceSettingsVersion: source.version });
    if (original.status !== 'ready' || original.references.length === 0) return { projection };
    const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
    const imported = await importLegacySavedSecretsInContext(context, source.mode, context.accountLifetime.scope, undefined, source);
    context.assertCurrent();
    if (imported.status !== 'complete') throw new AcpCatalogOperationError(imported.reason === 'changed' ? 'settings-conflict' : 'saved-secret-unavailable', imported);
    if (imported.sourceSettingsVersion === undefined) throw new AcpCatalogOperationError('source-stale');
    const current = await readAcpCatalogInContext(context, signal);
    context.assertCurrent();
    if (current.catalog.status === 'ready' && current.catalog.revision !== 'absent') throw new AcpCatalogOperationError('conflict');
    if (current.source?.version !== imported.sourceSettingsVersion) throw new AcpCatalogOperationError('settings-conflict');
    const references = new Map<string, string>();
    for (const reference of imported.verifiedReferences ?? []) {
        if (reference.source.kind === 'personal-saved-secret') references.set(reference.source.secretId, reference.resourceRef);
    }
    return { projection: current, references, sourceSettingsVersion: imported.sourceSettingsVersion };
}
/** Pure preparation borrows the admitted Account and never activates or transfers a source. */
export function prepareAcpCatalogMutationInContext(context: AcpCatalogAccountContext, input: AcpCatalogRecordWriteInput,
    signal?: AbortSignal): Promise<ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>> {
    return admit(context, async (mode, material) => {
        const { catalog, source } = await readAcpCatalogInContext(context, signal);
        context.assertCurrent();
        if (catalog.status !== 'ready') throw new AcpCatalogOperationError(catalog.status === 'loading' ? 'loading' : catalog.reason);
        if (catalog.revision !== input.expectedRevision) throw new AcpCatalogOperationError('conflict');
        if (input.expectedRevision === 'absent' && (catalog.revision !== 'absent'
            || catalog.sourceSettingsVersion !== input.sourceSettingsVersion || !source)) throw new AcpCatalogOperationError('settings-conflict');
        if (input.expectedRevision !== 'absent' && input.sourceSettingsVersion !== undefined) throw new AcpCatalogOperationError('invalid-stored-content');
        if (catalog.revision === 'absent' && catalog.source === 'predecessor'
            && !areAccountSettingsJsonValuesEqual(input.record, catalog.record)) throw new AcpCatalogOperationError('source-transfer-required');
        const references = listAcpCatalogSavedSecretRefsV1(input.record).map(reference => reference.secretId);
        const proofs = await captureSavedSecretReferenceRevisionsInContext(context, { references,
            savedSecretRevisions: input.savedSecretRevisions, pendingResourceIds: input.pendingResourceIds, signal });
        let settingsCleanup: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>['settingsCleanup'];
        if (catalog.revision === 'absent' && source && Object.hasOwn(source.raw, 'acpCatalogSettingsV1')) {
            const nextSettings = { ...source.raw };
            delete nextSettings.acpCatalogSettingsV1;
            settingsCleanup = sealAccountSettingsCleanup(mode, material, source.version, nextSettings);
        }
        const mutation = AcpCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision, ...proofs,
            content: sealAcpCatalogContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
            ...(catalog.revision === 'absent' ? { source: catalog.source, sourceSettingsVersion: catalog.sourceSettingsVersion,
                ...(settingsCleanup ? { settingsCleanup } : {}) } : {}) });
        context.assertCurrent();
        return mutation;
    });
}
async function postAcpCatalogMutationInContext(context: AcpCatalogAccountContext,
    mutation: ReturnType<typeof AcpCatalogRowMutationV1Schema.parse>, signal?: AbortSignal): Promise<AcpCatalogRowMutationResponseV1> {
    context.assertCurrent();
    let response: Response;
    try {
        response = await context.request(ACP_CATALOG_ROWS_ROUTE_V1, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal,
        }, { retry: 'none' });
    } catch (error) {
        throw new AcpCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
    }
    const parsed = AcpCatalogRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AcpCatalogOperationError(response.ok ? 'outcome_unknown' : `acp_catalog_http_${response.status}`);
    if (parsed.data.status === 'updated') {
        let cleanup: AcpCatalogCleanupV1;
        try {
            const { encryption } = await context.resolveAccountEncryption();
            const maintenance = await normalizeAccountSettingsHistoryAfterTransfer({ credentials: context.credentials, encryption,
                settingsScope: context.accountLifetime.scope,
                destinationAuthority: { activeTransferredRoots: ['acpCatalogSettingsV1'],
                    activePrivateCatalogRevisions: { acp: parsed.data.revision } },
                requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent } });
            cleanup = maintenance.status === 'complete' ? { status: 'complete' }
                : { status: 'cleanup-pending', reason: 'history-incomplete' };
        } catch {
            // History maintenance cannot retract or replay the acknowledged destination/source transaction.
            cleanup = { status: 'cleanup-pending', reason: 'history-incomplete' };
        }
        return { ...parsed.data, cleanup };
    }
    return parsed.data;
}
export async function writeAcpCatalogRecordInContext(context: AcpCatalogAccountContext, input: AcpCatalogRecordWriteInput,
    signal?: AbortSignal): Promise<AcpCatalogRowMutationResponseV1> {
    if (input.expectedRevision === 'absent') {
        const prepared = await prepareAcpCatalogSourceForMutationInContext(context, await readAcpCatalogInContext(context, signal), input, signal);
        const { catalog } = prepared.projection;
        if (prepared.references) {
            input = { ...input, record: rewriteAcpCatalogSavedSecretRefsV1(input.record, prepared.references),
                sourceSettingsVersion: prepared.sourceSettingsVersion };
        }
        if (catalog.status === 'ready' && catalog.revision === 'absent' && catalog.source === 'predecessor') {
            if (catalog.sourceSettingsVersion !== input.sourceSettingsVersion) throw new AcpCatalogOperationError('settings-conflict');
            const exact = await prepareAcpCatalogMutationInContext(context, { record: catalog.record, expectedRevision: 'absent',
                sourceSettingsVersion: catalog.sourceSettingsVersion }, signal);
            const transferred = await postAcpCatalogMutationInContext(context, exact, signal);
            if (transferred.status !== 'updated') return transferred;
            if (areAccountSettingsJsonValuesEqual(input.record, catalog.record)) return transferred;
            try {
                context.assertCurrent();
                const delta = await prepareAcpCatalogMutationInContext(context, { ...input, expectedRevision: transferred.revision,
                    sourceSettingsVersion: undefined }, signal);
                return await postAcpCatalogMutationInContext(context, delta, signal);
            } catch (error) {
                if ((error instanceof AcpCatalogOperationError && error.code === 'scope-retired')
                    || (error instanceof Error && 'code' in error && error.code === 'action_account_scope_changed')) {
                    throw new AcpCatalogOperationError('scope-retired', { revision: transferred.revision, reason: 'scope-retired' });
                }
                throw error;
            }
        }
    }
    return postAcpCatalogMutationInContext(context, await prepareAcpCatalogMutationInContext(context, input, signal), signal);
}
export async function writeAcpCatalogRecordAndPublishInContext(context: AcpCatalogAccountContext, input: AcpCatalogRecordWriteInput,
    signal?: AbortSignal): Promise<AcpCatalogRowMutationResponseV1> {
    const result = await writeAcpCatalogRecordInContext(context, input, signal);
    if (result.status === 'updated') {
        try {
            const { invalidateAcpCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/acpCatalogEngine');
            await invalidateAcpCatalogAfterAcknowledgedMutation(context.accountLifetime.scope, context.assertAccountCurrent);
        } catch { /* A failed projection refresh cannot retract the durable row receipt. */ }
    }
    return result;
}
export function writeAcpCatalogRecord(scope: ServerAccountScope, input: AcpCatalogRecordWriteInput,
    signal?: AbortSignal): Promise<AcpCatalogRowMutationResponseV1> {
    return withAccount(scope, signal, context => writeAcpCatalogRecordAndPublishInContext(context, input, signal));
}
/** Existing ACP Action mutations retain their semantic callback and replace only its persistence owner. */
export async function updateAcpCatalogInContext(context: AcpCatalogAccountContext,
    input: Readonly<{ mutate: (current: unknown) => unknown; signal?: AbortSignal;
        expectedRevision?: AcpCatalogRecordWriteInput['expectedRevision']; sourceSettingsVersion?: number }>): Promise<Readonly<{
            revision: number; cleanup?: AcpCatalogCleanupV1;
        }> | undefined> {
    if (input.sourceSettingsVersion !== undefined && input.expectedRevision !== 'absent') throw new AcpCatalogOperationError('invalid-stored-content');
    const prepared = await prepareAcpCatalogSourceForMutationInContext(context, await readAcpCatalogInContext(context, input.signal), input, input.signal);
    const { catalog } = prepared.projection;
    if (catalog.status !== 'ready') throw new AcpCatalogOperationError(catalog.status === 'loading' ? 'loading' : catalog.reason);
    if (input.expectedRevision !== undefined && input.expectedRevision !== catalog.revision) {
        throw new AcpCatalogOperationError('conflict', { status: 'conflict', revision: catalog.revision });
    }
    if (input.expectedRevision === 'absent' && (catalog.revision !== 'absent'
        || (prepared.references ? prepared.sourceSettingsVersion : input.sourceSettingsVersion) !== catalog.sourceSettingsVersion)) throw new AcpCatalogOperationError('settings-conflict');
    const current = { v: 2, backends: catalog.record.definitions };
    const next = input.mutate(current);
    if (next === current) return;
    if (!next || typeof next !== 'object' || Array.isArray(next) || Reflect.get(next, 'v') !== 2) throw new AcpCatalogOperationError('invalid-stored-content');
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: Reflect.get(next, 'backends') });
    const result = await writeAcpCatalogRecordAndPublishInContext(context, { record, expectedRevision: catalog.revision,
        ...(catalog.revision === 'absent' ? { sourceSettingsVersion: catalog.sourceSettingsVersion } : {}) }, input.signal);
    requireUpdatedAcpCatalogMutation(result);
    return { revision: result.revision, ...(result.cleanup ? { cleanup: result.cleanup } : {}) };
}
