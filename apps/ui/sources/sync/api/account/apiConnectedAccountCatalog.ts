import { loadConnectedAccountCatalogV1, type ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
    ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowMutationResponseV1Schema,
    readRetainedConnectedAccountCatalogRecordV1, listConnectedConfigurationCatalogSavedSecretRefsV1,
    sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogKeyV1, type ConnectedAccountCatalogRecordV1,
    type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { captureSavedSecretReferenceRevisionsInContext } from './apiSavedSecretCatalog';
import { listSavedSecretVoiceCredentialMutationReferencesV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ConnectedServiceConfigurationCatalogHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { randomUUID } from '@/platform/randomUUID';

export type ConnectedAccountCatalogAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
export type ConnectedAccountCatalogMutationResponseV1 = ReturnType<typeof ConnectedAccountCatalogRowMutationResponseV1Schema.parse>;
export class ConnectedAccountCatalogOperationError extends Error {
    constructor(readonly code: string, readonly cause?: unknown) { super(code); this.name = 'ConnectedAccountCatalogOperationError'; }
}
export function requireUpdatedConnectedAccountCatalogMutation(result: ConnectedAccountCatalogMutationResponseV1): asserts result is Extract<ConnectedAccountCatalogMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new ConnectedAccountCatalogOperationError(result.status, result);
}
async function admit<T>(context: ConnectedAccountCatalogAccountContext,
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
    context.assertCurrent();
    const material = storage.mode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(context.credentials);
    return operation(storage.mode, material);
}
export async function withConnectedAccountCatalogAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (context: ConnectedAccountCatalogAccountContext) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(scope.serverId, signal);
    try {
        if (context.accountId !== scope.accountId) throw new ConnectedAccountCatalogOperationError('scope-retired');
        return await operation(context);
    } finally { context.dispose(); }
}
function failure(error: unknown, signal?: AbortSignal): ConnectedAccountCatalogSnapshotV1 {
    return { status: 'unavailable', reason: classifyAccountStorageReadFailure(error, signal) };
}
export async function readConnectedAccountCatalogRowInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal?: AbortSignal) {
    const response = await context.request(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${key}`, { method: 'GET', signal }, { retry: 'none' });
    context.assertCurrent();
    if (!response.ok) throw new ConnectedAccountCatalogOperationError(response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
    const parsed = ConnectedAccountCatalogRowReadResponseV1Schema.parse(await response.json());
    context.assertCurrent();
    return parsed;
}
type ConnectedAccountCatalogReadPublication = Readonly<{
    onReady?: (catalog: ConnectedAccountCatalogSnapshotV1, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;
export type ConnectedAccountCatalogSourceAdmission = Readonly<{ sourceMachineId?: string | null }>;
async function readConnectedAccountCatalogWithAdmissionInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal: AbortSignal | undefined,
    publication: ConnectedAccountCatalogReadPublication | null,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Promise<ConnectedAccountCatalogSnapshotV1> {
    try {
        return await admit(context, async (mode, material) => {
            const catalog = await loadConnectedAccountCatalogV1({ key, mode, material, signal,
                readRow: () => readConnectedAccountCatalogRowInContext(context, key, signal),
                ...(publication?.onReady ? { onReadyBeforeCleanup: async catalog => {
                    context.assertCurrent();
                    publication.onReady!(catalog, context.accountLifetime.isCurrent);
                } } : {}),
                ...(publication === null ? {} : { transfer: {
                    readSourceSnapshot: async ({ purpose }) => {
                        const readSource = async () => {
                            const { encryption } = await context.resolveAccountEncryption();
                            const source = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                                request: (path, init) => context.request(path, init, { retry: 'none' }) });
                            context.assertCurrent();
                            return source;
                        };
                        let source = await readSource();
                        const retained = purpose === 'initialization' && key === 'configurations'
                            ? readRetainedConnectedAccountCatalogRecordV1(source.raw ?? {}, key) : null;
                        // Only a complete genuine source with personal references needs
                        // promotion. Partial source admission remains the catalog owner's.
                        if (retained?.status === 'ready' && retained.record.key === 'configurations'
                            && listConnectedConfigurationCatalogSavedSecretRefsV1(retained.record.value)
                                .some(reference => parseSavedSecretRefV1(reference.secretId).kind === 'personal')) {
                            const { importLegacySavedSecretsInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                            const imported = await importLegacySavedSecretsInContext(context, mode, {
                                serverId: context.serverId, accountId: context.accountId,
                            });
                            context.assertCurrent();
                            if (imported.status !== 'complete') throw new ConnectedAccountCatalogOperationError('source-transfer-unavailable');
                            source = await readSource();
                        }
                        const machineId = sourceAdmission?.sourceMachineId?.trim();
                        if (key === 'purposes' && purpose === 'initialization' && machineId) {
                            const [{ loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry },
                                { getResolvedAgentCatalogEntries }] = await Promise.all([
                                    import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
                                    import('@/agents/backendCatalog/agentCatalogProjection'),
                                ]);
                            const projectionTarget = { machineId, serverId: context.serverId, accountLifetime: context.accountLifetime };
                            await loadDaemonMergedProjectionCacheEntry({ ...projectionTarget, reuseFreshReady: true });
                            context.assertCurrent();
                            const projection = readReusableDaemonMergedProjectionCacheEntry(projectionTarget);
                            const purposeDefaultAgents = projection?.kind === 'ready' ? getResolvedAgentCatalogEntries({
                                enabledAgentIds: Object.keys(projection.inputs.mergedProviderProjectionById),
                                mergedProviderProjectionById: projection.inputs.mergedProviderProjectionById,
                                mergedBackendProjectionById: projection.inputs.mergedBackendProjectionById,
                            }) : null;
                            return { raw: source.raw ?? {}, version: source.version, purposeDefaultAgents };
                        }
                        return { raw: source.raw ?? {}, version: source.version };
                    },
                    initializeRecord: input => writeConnectedAccountCatalogRecordInContext(context, input, signal),
                    replaceSource: input => context.mutateRawSettings(() => ({ ...input.raw }), {
                        expectedSettingsVersion: input.expectedVersion, rebaseOnConflict: false, observeOutcome: true,
                    }),
                    normalizeHistory: async destinationAuthority => normalizeAccountSettingsHistoryAfterTransfer({
                        credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                        settingsScope: { serverId: context.serverId, accountId: context.accountId }, destinationAuthority,
                        requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                    }),
                } }),
            });
            const { encryption } = await context.resolveAccountEncryption();
            const current = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request });
            context.assertCurrent();
            return current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' };
        });
    } catch (error) { return failure(error, signal); }
}
/** An Action read observes admitted row authority without activating or retiring Settings sources. */
export function readAdmittedConnectedAccountCatalogInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal?: AbortSignal): Promise<ConnectedAccountCatalogSnapshotV1> {
    return readConnectedAccountCatalogWithAdmissionInContext(context, key, signal, null);
}
export function readConnectedAccountCatalogInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal?: AbortSignal,
    publication?: ConnectedAccountCatalogReadPublication,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Promise<ConnectedAccountCatalogSnapshotV1> {
    return readConnectedAccountCatalogWithAdmissionInContext(context, key, signal, publication ?? {}, sourceAdmission);
}
export async function readConnectedAccountCatalog(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    signal?: AbortSignal, assertCapturedAccountCurrent?: () => void,
    publication?: ConnectedAccountCatalogReadPublication,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Promise<ConnectedAccountCatalogSnapshotV1> {
    try {
        assertCapturedAccountCurrent?.();
        return await withConnectedAccountCatalogAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.();
            return readConnectedAccountCatalogInContext(context, key, signal, publication, sourceAdmission);
        });
    } catch (error) { return failure(error, signal); }
}
export type ConnectedAccountCatalogRecordWriteInput = Readonly<{
    record: ConnectedAccountCatalogRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    settingsMutation?: ConnectedAccountCatalogRowMutationV1['settingsMutation'];
    /** Transient captured Sync input; these Settings documents never enter the row DTO. */
    voiceCredentialMutation?: Readonly<{
        currentSettings: Readonly<Record<string, unknown>>;
        nextSettings: Readonly<Record<string, unknown>>;
    }>;
    referencedSavedSecretIds?: ConnectedAccountCatalogRowMutationV1['referencedSavedSecretIds'];
    savedSecretRevisions?: ConnectedAccountCatalogRowMutationV1['savedSecretRevisions'];
}>;
/** Capture actual resource use/revisions before publishing a configuration reference. */
export function prepareConnectedAccountCatalogMutationInContext(context: ConnectedAccountCatalogAccountContext,
    input: ConnectedAccountCatalogRecordWriteInput, signal?: AbortSignal): Promise<ConnectedAccountCatalogRowMutationV1> {
    return admit(context, async (mode, material) => {
        if (input.expectedRevision === 'absent' && input.sourceSettingsVersion === undefined) throw new ConnectedAccountCatalogOperationError('source-currentness-unavailable');
        if (input.voiceCredentialMutation && !input.settingsMutation) {
            throw new ConnectedAccountCatalogOperationError('saved-secret-unavailable');
        }
        const rowReferences = input.record.key === 'configurations'
            ? input.record.value.entries.flatMap(entry => Object.values(entry.secretRefs)) : [];
        const voiceReferences = input.voiceCredentialMutation
            ? listSavedSecretVoiceCredentialMutationReferencesV1(input.voiceCredentialMutation.currentSettings,
                input.voiceCredentialMutation.nextSettings, { requestedReferences: input.referencedSavedSecretIds }) : [];
        const references = [...new Set([...rowReferences, ...voiceReferences])];
        if (input.referencedSavedSecretIds !== undefined) {
            const declared = new Set(input.referencedSavedSecretIds);
            if (declared.size !== references.length || references.some(reference => !declared.has(reference))) {
                throw new ConnectedAccountCatalogOperationError('saved-secret-unavailable');
            }
        }
        const captured = await captureSavedSecretReferenceRevisionsInContext(context, {
            references, savedSecretRevisions: input.savedSecretRevisions, signal,
        });
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
            content: sealConnectedAccountCatalogContentV1({ mode, material, record: input.record, randomBytes: getRandomBytes }),
            ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }),
            ...(input.settingsMutation ? { settingsMutation: input.settingsMutation } : {}),
            ...captured,
        });
        context.assertCurrent();
        return mutation;
    });
}
export async function writeConnectedAccountCatalogRecordInContext(context: ConnectedAccountCatalogAccountContext,
    input: ConnectedAccountCatalogRecordWriteInput, signal?: AbortSignal): Promise<ConnectedAccountCatalogMutationResponseV1> {
        const mutation = await prepareConnectedAccountCatalogMutationInContext(context, input, signal);
        let response: Response;
        try {
            response = await context.request(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${input.record.key}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mutation), signal,
            }, { retry: 'none' });
        } catch (error) {
            throw new ConnectedAccountCatalogOperationError(classifyHttpMutationRequestFailure({ error, issued: true, signal }), error);
        }
        const parsed = ConnectedAccountCatalogRowMutationResponseV1Schema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new ConnectedAccountCatalogOperationError(response.ok ? 'outcome_unknown' : `connected_account_catalog_http_${response.status}`);
        return parsed.data;
}
export async function writeConnectedAccountCatalogRecordAndPublishInContext(context: ConnectedAccountCatalogAccountContext,
    input: ConnectedAccountCatalogRecordWriteInput, signal?: AbortSignal): Promise<ConnectedAccountCatalogMutationResponseV1> {
    const result = await writeConnectedAccountCatalogRecordInContext(context, input, signal);
    if (result.status === 'updated') {
        const { invalidateConnectedAccountCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
        try { await invalidateConnectedAccountCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId },
            input.record.key, context.assertAccountCurrent); }
        catch { /* A projection refusal cannot erase the durable mutation receipt. */ }
    }
    return result;
}
export function writeConnectedAccountCatalogRecord(scope: ServerAccountScope, input: ConnectedAccountCatalogRecordWriteInput,
    signal?: AbortSignal): Promise<ConnectedAccountCatalogMutationResponseV1> {
    return withConnectedAccountCatalogAccount(scope, signal, context => writeConnectedAccountCatalogRecordAndPublishInContext(context, input, signal));
}

/** Transport adapter; descriptor validation and replacement semantics are Protocol-owned. */
export function createUiConnectedServiceConfigurationCatalogHost(context: ConnectedAccountCatalogAccountContext,
    resolveMode: ConnectedServiceConfigurationCatalogHostV1['resolveMode'], signal?: AbortSignal): ConnectedServiceConfigurationCatalogHostV1 {
    return {
        resolveMode, createRevision: randomUUID,
        read: async () => {
            const admitted = await readAdmittedConnectedAccountCatalogInContext(context, 'configurations', signal);
            return admitted.status === 'unavailable' && admitted.reason === 'authority-not-confirmed'
                ? readConnectedAccountCatalogInContext(context, 'configurations', signal) : admitted;
        },
        hasSecret: async reference => {
            await captureSavedSecretReferenceRevisionsInContext(context, { references: [reference], signal });
            return true;
        },
        write: async input => {
            context.assertCurrent();
            signal?.throwIfAborted();
            if (!input.newSecrets.length) return writeConnectedAccountCatalogRecordAndPublishInContext(context, input, signal);
            const { createSavedSecretResourcesWithCatalogMutationInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
            const timestamp = Date.now();
            const result = await createSavedSecretResourcesWithCatalogMutationInContext(context, {
                scope: { serverId: context.serverId, accountId: context.accountId }, catalogKeys: ['connectedConfigurations'],
                resources: input.newSecrets.map(secret => ({ id: secret.id, name: `Connected Account ${secret.fieldId}`.slice(0, 100),
                    kind: 'other' as const, encryptedValue: { _isSecretValue: true as const, value: secret.value },
                    createdAt: timestamp, updatedAt: timestamp })),
                mutateCatalogs: ({ catalogs, catalogRevisions, resourceRefs }) => {
                    context.assertCurrent();
                    signal?.throwIfAborted();
                    if (catalogRevisions.connectedConfigurations !== input.expectedRevision) return { ok: false, reason: 'changed' };
                    const value = { ...input.record.value, entries: input.record.value.entries.map(entry => ({ ...entry,
                        secretRefs: Object.fromEntries(Object.entries(entry.secretRefs).map(([field, reference]) =>
                            [field, resourceRefs.get(reference) ?? reference])),
                    })) };
                    return { catalogs: { ...catalogs, connectedConfigurations: value } };
                },
            });
            if (result.ok) {
                try {
                    const { invalidateConnectedAccountCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
                    await invalidateConnectedAccountCatalogAfterAcknowledgedMutation({ serverId: context.serverId, accountId: context.accountId },
                        'configurations', context.assertAccountCurrent);
                } catch { /* Keep the acknowledged effect receipt after retirement. */ }
                return { status: 'applied' };
            }
            throw new ConnectedAccountCatalogOperationError(result.reason === 'changed' ? 'connected_account_configuration_changed'
                : result.reason === 'outcome_unknown' ? 'outcome_unknown' : 'connected_account_configuration_persistence_unavailable');
        },
    };
}
