import { NotificationChannelCatalogReadResponseV1Schema, NOTIFICATION_CHANNELS_ROUTE_V1,
    NotificationChannelCatalogRecordV1Schema, NotificationChannelCatalogMutationV1Schema,
    sealNotificationChannelCatalogContentV1, listNotificationChannelSavedSecretRefsV1,
    type NotificationChannelCatalogReadResponseV1, type NotificationChannelCatalogRecordV1,
    NotificationChannelCatalogMutationResponseV1Schema,
    type NotificationChannelCatalogMutationV1, type NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { admitProfileAccount, type ProfileAccountContext } from './apiProfileCatalog';
import { captureSavedSecretReferenceRevisionsInContext, readSavedSecretCatalogInContext,
    readSavedSecretReferenceInContext, type SavedSecretReferenceRevisionProof } from './apiSavedSecretCatalog';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { loadNotificationChannelCatalogV1, type NotificationChannelSigningSecretPreparationV1 } from '@happier-dev/protocol/account/settings/notificationChannelCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import type { AccountSettingsHistorySavedSecretRecoveryV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import type { SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import type { NotificationChannelCatalogProjection } from '@/sync/store/settings/notificationChannelCatalogSnapshot';

export type NotificationChannelCatalogAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
/** Conversion and finite Actions borrow the initiating captured transport, never an ambient Home. */
export type NotificationChannelCatalogReadContext = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    isCurrent: () => boolean;
}>;
export class NotificationChannelCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'NotificationChannelCatalogOperationError'; }
}
function requireCurrent(context: NotificationChannelCatalogReadContext): void {
    if (!context.isCurrent()) throw new NotificationChannelCatalogOperationError('scope-retired');
}
export async function readNotificationChannelCatalogRowInContext(context: NotificationChannelCatalogReadContext,
    signal?: AbortSignal): Promise<NotificationChannelCatalogReadResponseV1> {
    signal?.throwIfAborted();
    requireCurrent(context);
    const response = await context.request(NOTIFICATION_CHANNELS_ROUTE_V1, { method: 'GET', signal });
    requireCurrent(context);
    if (!response.ok) throw new NotificationChannelCatalogOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const row = NotificationChannelCatalogReadResponseV1Schema.safeParse(await response.json());
    requireCurrent(context);
    signal?.throwIfAborted();
    if (!row.success) throw new NotificationChannelCatalogOperationError('invalid-stored-content', row.error);
    return row.data;
}
export async function withNotificationChannelAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: NotificationChannelCatalogAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new NotificationChannelCatalogOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
export function readNotificationChannelCatalogRow(scope: ServerAccountScope,
    signal?: AbortSignal): Promise<NotificationChannelCatalogReadResponseV1> {
    return withNotificationChannelAccount(scope, signal, context => readNotificationChannelCatalogRowInContext({
        request: (path, init) => context.request(path, init, { retry: 'none' }), isCurrent: context.accountLifetime.isCurrent,
    }, signal));
}

/** The outer resource transaction owns the write; this producer only prepares its row packet. */
export function prepareNotificationChannelCatalogMutationInContext(context: ProfileAccountContext, input: Readonly<{
    record: NotificationChannelCatalogRecordV1;
    expectedRevision: number | 'absent';
    sourceSettingsVersion?: number;
    expectedMode?: 'plain' | 'e2ee';
    savedSecretRevisions?: readonly SavedSecretReferenceRevisionProof[];
    pendingResourceIds?: readonly string[];
    settingsMutation?: NotificationChannelCatalogMutationV1['settingsMutation'];
}>, signal?: AbortSignal): Promise<NotificationChannelCatalogMutationV1> {
    return admitProfileAccount(context, async (captured, mode, material) => {
        signal?.throwIfAborted();
        if (input.expectedMode !== undefined && input.expectedMode !== mode) {
            throw new NotificationChannelCatalogOperationError('account-mode-mismatch');
        }
        const record = NotificationChannelCatalogRecordV1Schema.parse(input.record);
        const proofs = await captureSavedSecretReferenceRevisionsInContext(captured, {
            references: listNotificationChannelSavedSecretRefsV1(record), savedSecretRevisions: input.savedSecretRevisions,
            pendingResourceIds: input.pendingResourceIds, signal,
        });
        signal?.throwIfAborted();
        captured.assertCurrent();
        return NotificationChannelCatalogMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealNotificationChannelCatalogContentV1({ record, mode, material, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }),
            ...(input.settingsMutation === undefined ? {} : { settingsMutation: input.settingsMutation }),
            savedSecretRevisions: proofs.referencedSavedSecretIds.map((resourceRef, index) => ({ resourceRef,
                revision: proofs.savedSecretRevisions[index]!.expectedRevision })),
        });
    });
}

export type NotificationChannelCatalogMutationResponse = ReturnType<typeof NotificationChannelCatalogMutationResponseV1Schema.parse>;
export type NotificationChannelCatalogWriteInput = Parameters<typeof prepareNotificationChannelCatalogMutationInContext>[1];
export async function writeNotificationChannelCatalogInContext(context: NotificationChannelCatalogAccountContext,
    input: NotificationChannelCatalogWriteInput, signal?: AbortSignal): Promise<NotificationChannelCatalogMutationResponse> {
    const mutation = await prepareNotificationChannelCatalogMutationInContext(context, input, signal);
    context.assertCurrent();
    let response: Response;
    try { response = await context.request(NOTIFICATION_CHANNELS_ROUTE_V1, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal }, { retry: 'none' }); }
    catch (error) { throw new NotificationChannelCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error); }
    const receipt = NotificationChannelCatalogMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
    if (!receipt.success) throw new NotificationChannelCatalogOperationError(response.ok ? 'outcome_unknown'
        : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unreachable');
    return receipt.data;
}
export function requireUpdatedNotificationChannelCatalog(receipt: NotificationChannelCatalogMutationResponse):
    asserts receipt is Extract<NotificationChannelCatalogMutationResponse, { status: 'updated' }> {
    if (receipt.status !== 'updated') throw new NotificationChannelCatalogOperationError(receipt.status, receipt);
}
function catalogFailure(error: unknown, signal?: AbortSignal): NotificationChannelCatalogSnapshotV1 {
    return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
}
type NotificationChannelCatalogReadPublication = Readonly<{
    onReady?: (projection: NotificationChannelCatalogProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;

/** Existing deterministic bindings are reusable only with owned, usable exact material. */
async function captureSigningResources(context: NotificationChannelCatalogAccountContext,
    signingSecrets: readonly NotificationChannelSigningSecretPreparationV1[], signal?: AbortSignal) {
    const catalog = await readSavedSecretCatalogInContext(context, signal);
    if (!catalog.ok) throw new NotificationChannelCatalogOperationError('secret-unavailable');
    const proofs: SavedSecretReferenceRevisionProof[] = [];
    const fresh: NotificationChannelSigningSecretPreparationV1[] = [];
    for (const secret of signingSecrets) {
        const resource = catalog.resources.find(row => 'resourceId' in row ? row.resourceId === secret.resourceId
            : row.entry.repair?.resourceId === secret.resourceId);
        if (!resource) { fresh.push(secret); continue; }
        if (!('resourceId' in resource) || resource.entry.relationship !== 'owner'
            || (resource.entry.owner?.accountId ?? resource.entry.ownerAccountId) !== context.accountId || !resource.entry.capabilities.use
            || resource.entry.materialStatus !== 'ready' || resource.entry.revision === null)
            throw new NotificationChannelCatalogOperationError('secret-unavailable');
        const opened = await readSavedSecretReferenceInContext(context, formatSharedSavedSecretRefV1(secret.resourceId), signal);
        if (!opened.ok || opened.revision !== resource.entry.revision || opened.value !== secret.value)
            throw new NotificationChannelCatalogOperationError('secret-unavailable');
        proofs.push({ resourceId: secret.resourceId, expectedRevision: opened.revision });
    }
    context.assertCurrent();
    return { proofs, fresh };
}
function signingHistoryRecovery(context: NotificationChannelCatalogAccountContext,
    source: AccountSettingsHistorySavedSecretRecoveryV1['source'], materials: readonly SavedSecretResourceMaterialV1[],
    signal?: AbortSignal): AccountSettingsHistorySavedSecretRecoveryV1 {
    const resources = materials.flatMap(resource => 'resourceId' in resource
        && resource.entry.relationship === 'owner'
        && (resource.entry.owner?.accountId ?? resource.entry.ownerAccountId) === context.accountId
        && resource.entry.materialStatus === 'ready' && resource.entry.capabilities.use && resource.entry.revision !== null
        ? [{ resourceId: resource.resourceId, ownerAccountId: context.accountId,
            revision: resource.entry.revision, materialStatus: resource.entry.materialStatus }] : []);
    return { accountId: context.accountId, source, resources,
        resolveResourceValue: async resourceId => {
            const proof = resources.find(resource => resource.resourceId === resourceId);
            if (!proof) return null;
            const opened = await readSavedSecretReferenceInContext(context, formatSharedSavedSecretRefV1(resourceId), signal);
            return opened.ok && opened.revision === proof.revision ? opened.value : null;
        } };
}
export async function readNotificationChannelCatalogProjectionInContext(context: NotificationChannelCatalogAccountContext,
    signal?: AbortSignal, publication?: NotificationChannelCatalogReadPublication,
    admitInitializationRecord?: (record: NotificationChannelCatalogRecordV1) => void): Promise<NotificationChannelCatalogProjection> {
    const operationAdmission: { failure: Readonly<{ error: unknown }> | null } = { failure: null };
    try {
        return await admitProfileAccount(context, async (_context, mode, material) => {
            let source: Awaited<ReturnType<typeof context.readRawSettingsSnapshot>> | null = null;
            const project = async (catalog: NotificationChannelCatalogSnapshotV1): Promise<NotificationChannelCatalogProjection> => {
                const { encryption } = await context.resolveAccountEncryption();
                const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
                context.assertCurrent();
                return { catalog: current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' },
                    rawSettings: source?.raw ?? {}, sourceSettingsVersion: source?.version ?? 0 };
            };
            const sourceKeys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope: context.accountLifetime.scope });
            context.assertCurrent();
            const catalog = await loadNotificationChannelCatalogV1({ mode, material, signal,
                settingsSecretsReadKeys: sourceKeys?.readKeys ?? [],
                readRow: () => readNotificationChannelCatalogRowInContext({ request: (path, init) => context.request(path, init, { retry: 'none' }),
                    isCurrent: context.accountLifetime.isCurrent }, signal),
                hasPendingCleanup: publication?.hasPendingCleanup,
                ...(publication?.onReady ? { onReadyBeforeCleanup: async catalog => {
                    publication.onReady?.(await project(catalog), context.accountLifetime.isCurrent);
                } } : {}),
                transfer: {
                    accountId: context.accountId,
                    readSourceSnapshot: async () => {
                        source = await context.readRawSettingsSnapshot();
                        context.assertCurrent();
                        return source;
                    },
                    initializeRecord: async input => {
                        // An operation can require existing source membership before
                        // the first import write; passive observation imports normally.
                        try { admitInitializationRecord?.(input.record); }
                        catch (error) { operationAdmission.failure = { error }; throw error; }
                        if (!input.signingSecrets.length) return writeNotificationChannelCatalogInContext(context, input, signal);
                        if (!source) throw new NotificationChannelCatalogOperationError('secret-unavailable');
                        const captured = await captureSigningResources(context, input.signingSecrets, signal);
                        if (!captured.fresh.length) return writeNotificationChannelCatalogInContext(context,
                            { ...input, savedSecretRevisions: captured.proofs }, signal);
                        const { createSavedSecretResourcesWithCatalogMutationInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                        const created = await createSavedSecretResourcesWithCatalogMutationInContext(context, {
                            scope: context.accountLifetime.scope, referenceScope: 'full',
                            resources: captured.fresh.map(secret => SavedSecretSchema.parse({ id: secret.resourceId,
                                name: secret.displayName, kind: secret.kind, encryptedValue: { _isSecretValue: true, value: secret.value } })),
                            originalSource: { rawSettings: source.raw, settingsVersion: input.sourceSettingsVersion },
                            notificationSavedSecretRevisions: captured.proofs,
                            mutateCatalogs: capture => {
                                if (capture.catalogs.notificationChannels !== undefined) return { ok: false, reason: 'changed' };
                                return { settings: capture.rawSettings, catalogs: { ...capture.catalogs, notificationChannels: input.record } };
                            },
                        });
                        if (!created.ok) throw new NotificationChannelCatalogOperationError(created.reason, created);
                        return { status: 'applied', settingsVersion: created.settingsVersion };
                    },
                    admitSourceCleanup: async prepared => {
                        const captured = await captureSigningResources(context, prepared.signingSecrets, signal);
                        return captured.fresh.length === 0 && source !== null;
                    },
                    replaceSource: input => context.mutateRawSettings(() => ({ ...input.raw }), {
                        expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                    }),
                    normalizeHistory: async input => {
                        // Source cleanup may have advanced Settings. Historical
                        // proof needs the actual cleaned current document, both
                        // on the first pass and on a later maintenance retry.
                        const historySource = await context.readRawSettingsSnapshot();
                        const resources = await readSavedSecretCatalogInContext(context, signal);
                        context.assertCurrent();
                        const savedSecretRecovery = resources.ok
                            ? signingHistoryRecovery(context, historySource, resources.resources, signal) : undefined;
                        return normalizeAccountSettingsHistoryAfterTransfer({
                            credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                            settingsScope: context.accountLifetime.scope, destinationAuthority: input,
                            ...(savedSecretRecovery ? { savedSecretRecovery } : {}),
                            requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                        });
                    },
                },
            });
            if (operationAdmission.failure) throw operationAdmission.failure.error;
            return project(catalog);
        });
    } catch (error) {
        if (operationAdmission.failure && error === operationAdmission.failure.error) throw error;
        return { catalog: catalogFailure(error, signal), rawSettings: {}, sourceSettingsVersion: 0 };
    }
}
export async function readNotificationChannelCatalogProjection(scope: ServerAccountScope, signal?: AbortSignal,
    assertCapturedAccountCurrent?: () => void, publication?: NotificationChannelCatalogReadPublication): Promise<NotificationChannelCatalogProjection> {
    try {
        assertCapturedAccountCurrent?.();
        return await withNotificationChannelAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.();
            return readNotificationChannelCatalogProjectionInContext(context, signal, publication);
        });
    } catch (error) { return { catalog: catalogFailure(error, signal), rawSettings: {}, sourceSettingsVersion: 0 }; }
}
export async function publishAcknowledgedNotificationChannelCatalog(context: NotificationChannelCatalogAccountContext): Promise<void> {
    const { invalidateNotificationChannelCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/notificationChannelCatalogEngine');
    try { await invalidateNotificationChannelCatalogAfterAcknowledgedMutation(context.accountLifetime.scope, context.assertAccountCurrent); }
    catch { /* Revalidation cannot erase the durable receipt for this Account. */ }
}
