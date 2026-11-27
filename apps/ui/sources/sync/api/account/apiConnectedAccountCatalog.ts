import { loadConnectedAccountCatalogV1, type ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1,
    CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
    ConnectedAccountCatalogRowMutationV1Schema, ConnectedAccountCatalogRowMutationResponseV1Schema,
    readRetainedConnectedAccountCatalogRecordV1, listConnectedConfigurationCatalogSavedSecretRefsV1,
    sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogKeyV1, type ConnectedAccountCatalogRecordV1,
    type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { classifyAccountStorageReadFailure, resolveAccountStorageContext, resolveAccountStorageContextForDisclosure } from '@/sync/encryption/accountStorageContext';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { readCurrentAccountSettingsRawSnapshot } from '@/sync/engine/settings/accountSettingsRawSnapshot';
import { normalizeAccountSettingsHistoryAfterTransfer } from '@/sync/engine/settings/accountSettingsHistoryRestore';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';
import { captureSavedSecretReferenceRevisionsInContext } from './apiSavedSecretCatalog';
import { listSavedSecretVoiceCredentialMutationReferencesV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ConnectedServiceConfigurationCatalogHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { randomUUID } from '@/platform/randomUUID';
import { applyAcknowledgedConnectedAccountCatalog } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type ConnectedAccountCatalogAccountContext = Awaited<ReturnType<typeof import('@/sync/ops/actions/actionAccountContext').captureLazyActionAccountContext>>;
export type ConnectedAccountCatalogMutationResponseV1 = ReturnType<typeof ConnectedAccountCatalogRowMutationResponseV1Schema.parse>;
const rowReads = createScopedResolutionSingleFlight<ReturnType<typeof ConnectedAccountCatalogRowReadResponseV1Schema.parse>>();
import { ConnectedAccountCatalogOperationError } from './connectedAccountCatalogOperationError';
export { ConnectedAccountCatalogOperationError };
export function requireUpdatedConnectedAccountCatalogMutation(result: ConnectedAccountCatalogMutationResponseV1): asserts result is Extract<ConnectedAccountCatalogMutationResponseV1, { status: 'updated' }> {
    if (result.status !== 'updated') throw new ConnectedAccountCatalogOperationError(result.status, result);
}
async function admit<T>(context: ConnectedAccountCatalogAccountContext, usage: 'identity' | 'fresh-authority',
    operation: (mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) => Promise<T>): Promise<T> {
    const { encryption } = await context.resolveAccountEncryption();
    const storage = await resolveAccountStorageContext(context.credentials, { encryption, request: context.request, usage });
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
    key: ConnectedAccountCatalogKeyV1, signal?: AbortSignal, options?: Readonly<{ fresh?: boolean }>) {
    return withActionAccountRequestSignal(context, signal, async signal => {
        context.assertCurrent();
        throwIfAborted(signal);
        const path = `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/${key}`;
        const consume = async (response: Response) => {
            if (!response.ok) throw new ConnectedAccountCatalogOperationError(response.status === 401 ? 'unauthorized'
                : response.status === 403 ? 'forbidden' : response.status === 404 ? 'unsupported' : 'unreachable');
            return ConnectedAccountCatalogRowReadResponseV1Schema.parse(await response.json());
        };
        const transport = context.readTransport;
        let parsed: ReturnType<typeof ConnectedAccountCatalogRowReadResponseV1Schema.parse>;
        if (transport) {
            const snapshotKey = transport.key;
            parsed = await rowReads.run(JSON.stringify([snapshotKey, key]), sharedSignal => transport.read(path,
                { method: 'GET', signal: sharedSignal }, { retry: 'none' }, consume), {
                scope: transport.scope ?? snapshotKey, signal, fresh: options?.fresh ?? true,
            });
        } else {
            parsed = await consume(await context.request(path, { method: 'GET', signal }, { retry: 'none' }));
        }
        throwIfAborted(signal);
        context.assertCurrent();
        return parsed;
    });
}
type ConnectedAccountCatalogReadPublication = Readonly<{
    onReady?: (catalog: ConnectedAccountCatalogSnapshotV1, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup?: () => boolean;
}>;
export type ConnectedAccountCatalogSourceAdmission = Readonly<{ sourceMachineId?: string | null }>;
async function readConnectedAccountCatalogWithAdmissionInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal: AbortSignal | undefined,
    publication: ConnectedAccountCatalogReadPublication | null,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission, fresh = false): Promise<ConnectedAccountCatalogSnapshotV1> {
    try {
        return await admit(context, 'identity', async (mode, material) => {
            const project = async (catalog: ConnectedAccountCatalogSnapshotV1): Promise<ConnectedAccountCatalogSnapshotV1> => {
                const { encryption } = await context.resolveAccountEncryption();
                const current = await resolveAccountStorageContextForDisclosure(context.credentials, { encryption, request: context.request });
                context.assertCurrent();
                return current.mode === mode ? catalog : { status: 'unavailable', reason: 'account-mode-mismatch' };
            };
            let emptySourceInitialization = false;
            const catalog = await loadConnectedAccountCatalogV1({ key, mode, material, signal,
                readRow: () => readConnectedAccountCatalogRowInContext(context, key, signal, { fresh: fresh || publication !== null }),
                ...(publication?.onReady ? { onReadyBeforeCleanup: async catalog => {
                    publication.onReady!(await project(catalog), context.accountLifetime.isCurrent);
                } } : {}),
                ...(key === 'purposes' ? { hasPendingCleanup: publication?.hasPendingCleanup } : {}),
                ...(publication === null ? {} : { transfer: {
                    readSourceSnapshot: async ({ purpose }) => {
                        const readSource = async () => {
                            const { encryption } = await context.resolveAccountEncryption();
                            const source = await readAccountSettingsBaseline({ credentials: context.credentials, encryption, accountMode: mode,
                                request: (path, init) => context.request(path, init, { retry: 'none' }) });
                            context.assertCurrent();
                            return source;
                        };
                        if (key === 'purposes' && purpose === 'cleanup') {
                            return readCurrentAccountSettingsRawSnapshot({ serverId: context.serverId, accountId: context.accountId }, {
                                credentials: context.credentials, request: context.request, signal,
                                readBaseline: async () => {
                                    const source = await readSource();
                                    return { raw: source.raw ?? {}, version: source.version };
                                },
                            });
                        }
                        let source = await readSource();
                        emptySourceInitialization = key === 'configurations' && purpose === 'initialization'
                            && !Object.hasOwn(source.raw ?? {}, CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1.configurations);
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
                                { getResolvedAgentCatalogEntries }, { DAEMON_AGENT_CATALOG_SECTIONS }] = await Promise.all([
                                    import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
                                    import('@/agents/backendCatalog/agentCatalogProjection'),
                                    import('@/agents/backendCatalog/agentCatalogSections'),
                                ]);
                            // Purpose defaults read only the Agent catalog.
                            const projectionTarget = { machineId, serverId: context.serverId, accountLifetime: context.accountLifetime,
                                sections: DAEMON_AGENT_CATALOG_SECTIONS };
                            await loadDaemonMergedProjectionCacheEntry({ ...projectionTarget, reuseFreshReady: true, signal });
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
                    normalizeHistory: async destinationAuthority => emptySourceInitialization ? { status: 'complete' as const }
                        : normalizeAccountSettingsHistoryAfterTransfer({
                        credentials: context.credentials, encryption: (await context.resolveAccountEncryption()).encryption,
                        settingsScope: { serverId: context.serverId, accountId: context.accountId }, destinationAuthority,
                        requestContext: { request: context.request, isCurrent: context.accountLifetime.isCurrent },
                    }),
                } }),
            });
            return project(catalog);
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
/** Current readers and edits share row authority; only actual absence activates the source owner. */
export async function readConnectedAccountCatalogForMutationInContext(context: ConnectedAccountCatalogAccountContext,
    key: ConnectedAccountCatalogKeyV1, signal?: AbortSignal,
    publication?: ConnectedAccountCatalogReadPublication,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Promise<ConnectedAccountCatalogSnapshotV1> {
    const admitted = await readConnectedAccountCatalogWithAdmissionInContext(context, key, signal, null, undefined, true);
    if (admitted.status === 'unavailable' && admitted.reason === 'authority-not-confirmed') {
        return readConnectedAccountCatalogInContext(context, key, signal, publication, sourceAdmission);
    }
    publication?.onReady?.(admitted, context.accountLifetime.isCurrent);
    return admitted;
}
export async function readConnectedAccountCatalog(scope: ServerAccountScope, key: ConnectedAccountCatalogKeyV1,
    signal?: AbortSignal, assertCapturedAccountCurrent?: () => void,
    publication?: ConnectedAccountCatalogReadPublication,
    sourceAdmission?: ConnectedAccountCatalogSourceAdmission): Promise<ConnectedAccountCatalogSnapshotV1> {
    try {
        assertCapturedAccountCurrent?.();
        return await withConnectedAccountCatalogAccount(scope, signal, context => {
            assertCapturedAccountCurrent?.();
            return key === 'purposes' && publication
                ? readConnectedAccountCatalogInContext(context, key, signal, publication, sourceAdmission)
                : readConnectedAccountCatalogForMutationInContext(context, key, signal, publication, sourceAdmission);
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
    selectedSecrets?: Readonly<Record<string, SharedSavedSecretReferenceSelectionV1>>;
}>;
/** Capture actual resource use/revisions before publishing a configuration reference. */
export function prepareConnectedAccountCatalogMutationInContext(context: ConnectedAccountCatalogAccountContext,
    input: ConnectedAccountCatalogRecordWriteInput, signal?: AbortSignal): Promise<ConnectedAccountCatalogRowMutationV1> {
    return admit(context, 'fresh-authority', async (mode, material) => {
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
            references, savedSecretRevisions: input.savedSecretRevisions, selectedSecrets: Object.values(input.selectedSecrets ?? {}), signal,
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
    try {
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
        if (parsed.data.status === 'updated') {
            try { applyAcknowledgedConnectedAccountCatalog(context.accountLifetime.scope, input.record,
                parsed.data.revision, context.accountLifetime.isCurrent()); }
            catch { /* Display publication cannot retract the durable row receipt. */ }
        }
        return parsed.data;
    } finally {
        // Unknown write outcomes can have committed. Do not let later reads
        // borrow a pre-write row before the captured Home receives its wake.
        if (context.readTransport) rowReads.invalidate(context.readTransport.scope ?? context.readTransport.key);
    }
}
export async function writeConnectedAccountCatalogRecordAndPublishInContext(context: ConnectedAccountCatalogAccountContext,
    input: ConnectedAccountCatalogRecordWriteInput, signal?: AbortSignal): Promise<ConnectedAccountCatalogMutationResponseV1> {
    const result = await writeConnectedAccountCatalogRecordInContext(context, input, signal);
    if (result.status === 'updated') {
        const { invalidateConnectedAccountCatalogAfterAcknowledgedMutation } = await import('@/sync/engine/settings/connectedAccountCatalogEngine');
        try { fireAndForget(invalidateConnectedAccountCatalogAfterAcknowledgedMutation(context.accountLifetime.scope,
            input.record.key, context.assertAccountCurrent), { tag: 'connectedAccountCatalog.afterAcknowledgedMutation' }); }
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
        read: () => readConnectedAccountCatalogForMutationInContext(context, 'configurations', signal),
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
                selectedSecrets: Object.values(input.selectedSecrets ?? {}),
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
                // The composite transaction publishes and revalidates its exact
                // acknowledged catalogs at the resource owner.
                return { status: 'applied' };
            }
            throw new ConnectedAccountCatalogOperationError(result.reason === 'changed' ? 'connected_account_configuration_changed'
                : result.reason === 'outcome_unknown' ? 'outcome_unknown' : 'connected_account_configuration_persistence_unavailable');
        },
    };
}
