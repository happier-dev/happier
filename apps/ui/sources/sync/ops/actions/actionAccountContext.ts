import { TokenStorage, subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { ArtifactAccessRecipientCensusResponseV1Schema, isArtifactHtmlHeaderV1, loadAiLaunchProfileArtifacts, readAiLaunchProfileCollection, type ArtifactCallerAccessV1, type ArtifactAccessActionTransportV1, type ArtifactActionInputV1 } from '@happier-dev/protocol';
import type { ArtifactPublicLinkKeyholdingResourceV1, WorkflowDefinitionArtifactOperations } from '@happier-dev/protocol/actions';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent, getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storage';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { syncSettings, requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/connectionManager';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { parseToken } from '@/utils/auth/parseToken';
import { createArtifactWithHeaderViaApi, decryptArtifactListItems, fetchArtifactWithBodyFromApi, updateArtifactWithHeaderViaApi,
    fetchArtifactBodyRevisionsFromApi, fetchArtifactHtmlPreviewFromApi, restoreArtifactBodyRevisionViaApi, type ArtifactDataKeyCache } from '@/sync/engine/artifacts/syncArtifacts';
import { createArtifactAccessApi, deleteArtifact as deleteArtifactApi, fetchArtifacts as fetchArtifactsApi, fetchArtifactStorageUsage } from '@/sync/api/artifacts/apiArtifacts';
import { encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';
import type { ArtifactBodyInput, ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

function encodeArtifactListCursor(row: Readonly<{ artifactId: string; updatedAt: number }>): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify({ updatedAt: row.updatedAt, id: row.artifactId })), 'base64url');
}

function artifactContentUnavailable(): Error & Readonly<{ code: 'content_unavailable' }> {
    return Object.assign(new Error('Artifact content is unavailable'), { code: 'content_unavailable' as const });
}

function readableArtifactHeader(artifact: DecryptedArtifact | null): ArtifactHeader {
    if (!artifact?.isDecrypted || !artifact.header) throw artifactContentUnavailable();
    return artifact.header;
}

function readableRawArtifactHeader(artifact: DecryptedArtifact | null): Readonly<Record<string, unknown>> {
    if (!artifact?.isDecrypted || !artifact.rawHeader) throw artifactContentUnavailable();
    return artifact.rawHeader;
}

const artifactAccessProjectionSchema = ArtifactAccessRecipientCensusResponseV1Schema.pick({ ownerAccountId: true, access: true });
type ArtifactCreateOperation = Readonly<{ artifactId?: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyInput; signal?: AbortSignal }>;
type ArtifactUpdateOperation = Omit<Parameters<WorkflowDefinitionArtifactOperations['update']>[0], 'body'> & Readonly<{ body: ArtifactBodyInput }>;

function requireArtifactAccessProjection(artifact: DecryptedArtifact) {
    const projection = artifactAccessProjectionSchema.safeParse({ ownerAccountId: artifact.ownerAccountId, access: artifact.access });
    if (!projection.success) throw artifactContentUnavailable();
    return projection.data;
}

/**
 * Bind a shared Action invocation to the requested Home and Account, without reading the Account's
 * encryption mode. The mode (`Account.encryptionMode`, the authority) and the keys it implies are
 * resolved once, on first use, by `resolveAccountEncryption()`: every operation here that depends on
 * them (settings baseline, artifacts) awaits it first, so a failed mode read fails that operation
 * closed. Actions that never touch encrypted content (Account Security, Machine Pools) skip the extra
 * round-trip and key derivation.
 */
export async function captureLazyActionAccountContext(serverIdRaw: string, signal?: AbortSignal) {
    const embed = isEmbedWindowContext() ? (await import('@/sync/sync')).sync.getEmbedSessionRequestContext() : null;
    if (embed) {
        if (serverIdRaw !== embed.serverId) throw new Error('action_home_not_found');
        const assertAccountCurrent = () => {
            if (!embed.isCurrent()) throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        };
        const assertCurrent = () => {
            signal?.throwIfAborted();
            assertAccountCurrent();
        };
        const unavailable = async (): Promise<never> => { throw new Error('Account content is unavailable in an embed Session'); };
        const artifactUnavailable = async (): Promise<never> => { assertCurrent(); throw artifactContentUnavailable(); };
        const workflowArtifacts: WorkflowDefinitionArtifactOperations = {
            read: artifactUnavailable, list: artifactUnavailable, create: artifactUnavailable,
            update: artifactUnavailable, delete: artifactUnavailable,
        };
        const artifactAccessGrants: ArtifactAccessActionTransportV1 = {
            list: artifactUnavailable, set: artifactUnavailable, remove: artifactUnavailable,
        };
        return {
            serverId: embed.serverId, serverIdentityId: undefined, accountId: embed.accountId,
            accountLifetime: { scope: { serverId: embed.serverId, accountId: embed.accountId }, isCurrent: embed.isCurrent, onRetire: embed.onRetire },
            credentials: embed.credentials, credentialAuthorityKind: 'api_token' as const,
            request: embed.request, assertCurrent, assertAccountCurrent, dispose: () => {},
            resolveAccountEncryption: unavailable, readSettings: unavailable, readRawSettings: unavailable, readLaunchProfiles: unavailable, readLaunchProfileSnapshot: unavailable,
            mutateRawSettings: async (_mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | Promise<Record<string, unknown>>) => unavailable(), readLiveSettings: () => null,
            runPrepared: async <T>(run: () => Promise<T>): Promise<T> => { assertCurrent(); const result = await run(); assertCurrent(); return result; },
            fetchArtifact: async (_artifactId: string) => unavailable(),
            createArtifact: async (_header: Readonly<Record<string, unknown>>, _body: string) => unavailable(),
            createArtifactDocument: async (_input: ArtifactCreateOperation) => artifactUnavailable(),
            updateArtifactDocument: async (_input: ArtifactUpdateOperation) => artifactUnavailable(),
            readArtifactHtmlPreview: async (_artifact: DecryptedArtifact, _signal?: AbortSignal): Promise<Readonly<{ previewUrl?: string; previewError?: 'artifact_html_preview_unavailable' }>> => artifactUnavailable(),
            updateArtifact: async (_artifactId: string, _header: ArtifactHeader, _body: string, _basis?: DecryptedArtifact) => unavailable(),
            workflowArtifacts, artifactAccessGrants, encodeArtifactListCursor,
            listArtifacts: async (_options: Parameters<WorkflowDefinitionArtifactOperations['list']>[0]) => artifactUnavailable(),
            listArtifactRevisions: async (_artifactId: string, _signal?: AbortSignal) => artifactUnavailable(),
            restoreArtifactRevision: async (_input: ArtifactActionInputV1<'artifact.revisions.restore'>, _signal?: AbortSignal) => artifactUnavailable(),
            readArtifactStorageUsage: async (_signal?: AbortSignal) => artifactUnavailable(),
            readArtifactPublicLinkResource: async (_artifactId: string, _signal?: AbortSignal): Promise<ArtifactPublicLinkKeyholdingResourceV1 | null> => artifactUnavailable(),
        };
    }
    if (isEmbedWindowContext()) throw new Error('action_home_signed_out');
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw);
    const profile = getServerProfileById(serverId);
    if (!profile) throw new Error('action_home_not_found');
    const serverIdentityId = profile.serverIdentityId?.trim() || undefined;
    const applied = getAppliedActiveServerSnapshot();
    const currentness = areServerProfileIdentifiersEquivalent(applied.serverId, serverId)
        ? captureActiveServerAccountScopeCurrentness() : null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const watch = () => {
        const retirement = currentness?.onRetire(abort);
        const unsubscribe = subscribeHomeCredentialMutations((event) => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) abort();
        });
        return () => {
            retirement?.dispose();
            unsubscribe();
        };
    };
    const dispose = watch();
    const assertAccountCurrent = () => {
        if (controller.signal.aborted || (currentness && !currentness.isCurrent())) {
            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        }
    };
    const assertCurrent = () => {
        signal?.throwIfAborted();
        assertAccountCurrent();
    };
    try {
        signal?.throwIfAborted();
        const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
        assertCurrent();
        signal?.throwIfAborted();
        if (!credentials) throw new Error('action_home_signed_out');
        const credentialAuthorityKind = readCredentialAuthorityKind(credentials.token);
        const accountId = parseToken(credentials.token);
        const scope = { serverId, accountId };
        const accountLifetime = {
            scope,
            isCurrent: () => {
                try { assertCurrent(); return true; } catch { return false; }
            },
            onRetire: (cancel: () => void) => {
                if (controller.signal.aborted || signal?.aborted) { cancel(); return { dispose: () => {} }; }
                controller.signal.addEventListener('abort', cancel, { once: true });
                signal?.addEventListener('abort', cancel, { once: true });
                return { dispose: () => {
                    controller.signal.removeEventListener('abort', cancel);
                    signal?.removeEventListener('abort', cancel);
                } };
            },
        };
        // Every Action owns an explicit Home target. Resolve it through the
        // canonical scoped carrier so a staged focus change cannot retarget an
        // Action through the ambient focused request path.
        const request: ServerFetch = async (path, init, options) => {
            assertCurrent();
            const cancellation = mergeAbortSignals([controller.signal, signal, init?.signal ?? undefined]);
            try {
                cancellation.signal.throwIfAborted();
                const requestInit = { ...init, signal: cancellation.signal };
                const transport = await resolveServerScopedTransport({ profile, credentials });
                try {
                    assertCurrent();
                    cancellation.signal.throwIfAborted();
                    const response = await createServerFetchAtEndpoint({
                        endpointUrl: transport.canonicalServerUrl,
                        runtimeOrigin: transport.runtimeOrigin,
                        serverId,
                        credentials,
                        signal: cancellation.signal,
                        ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                    })(path, requestInit, options);
                    assertCurrent();
                    return response;
                } finally {
                    try { await transport.release(); } finally { assertCurrent(); }
                }
            } finally {
                cancellation.dispose();
            }
        };
        const loadAccountEncryption = async () => {
            const accountMode = (await fetchAccountEncryptionMode(credentials, { request })).mode;
            const encryption = accountMode === 'plain' ? null : await createEncryptionFromAuthCredentials(credentials);
            assertCurrent();
            return { accountMode, encryption };
        };
        let accountEncryption: ReturnType<typeof loadAccountEncryption> | null = null;
        const resolveAccountEncryption = () => (accountEncryption ??= loadAccountEncryption());
        // The existing artifact codec requires an invocation-local key map. Never reuse the
        // focused sync singleton's Account-owned keys or publish a background Home into it.
        const artifactDataKeys: ArtifactDataKeyCache = new Map();
        const canPublish = () => {
            assertCurrent();
            return areAccountSettingsScopesEqual(storage.getState().settingsScope, scope);
        };
        const artifactParams = async () => ({
            request, serverId, credentials, encryption: (await resolveAccountEncryption()).encryption, artifactDataKeys,
        });
        const fetchArtifact = async (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => {
            assertCurrent();
            const artifact = await fetchArtifactWithBodyFromApi({ ...await artifactParams(), artifactId, signal: options?.signal ?? signal });
            assertCurrent();
            return artifact;
        };
        const accessApi = createArtifactAccessApi(credentials, { request });
        const withArtifactPreparation = async <T extends Readonly<{ access: ArtifactCallerAccessV1 | null }>>(artifactId: string, operation: () => Promise<T>, operationSignal?: AbortSignal): Promise<T> => {
            assertCurrent();
            operationSignal?.throwIfAborted();
            const result = await operation();
            assertCurrent();
            // A committed self-revocation has no readable audience for this caller.
            // Preserve the mutation result rather than reopening the inaccessible Artifact.
            if (result.access === null) return result;
            // Opening through the sync owner reuses its exact envelope/key cache
            // and runs the shared preparation pass for the resulting audience.
            const artifact = await fetchArtifact(artifactId, { signal: operationSignal });
            if (!artifact) {
                throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
            }
            readableArtifactHeader(artifact);
            assertCurrent();
            return result;
        };
        const artifactAccessGrants: ArtifactAccessActionTransportV1 = {
            list: (input, operationSignal) => withArtifactPreparation(input.artifactId, () => accessApi.list(input, operationSignal), operationSignal),
            set: (input, operationSignal) => withArtifactPreparation(input.artifactId, () => accessApi.set(input, operationSignal), operationSignal),
            remove: (input, operationSignal) => withArtifactPreparation(input.artifactId, () => accessApi.remove(input, operationSignal), operationSignal),
        };
        const listArtifacts = async (options: Parameters<WorkflowDefinitionArtifactOperations['list']>[0]) => {
                assertCurrent();
                const params = await artifactParams();
                assertCurrent();
                const artifacts = await fetchArtifactsApi(credentials, { request, ...options });
                assertCurrent();
                const openedArtifacts = await decryptArtifactListItems({ ...params, artifacts, includeBody: options.includeBody });
                assertCurrent();
                const items = [];
                for (const [index, artifact] of artifacts.entries()) {
                    const opened = openedArtifacts[index] ?? null;
                    // Unopened headers cannot be classified; body failures keep
                    // their readable header for the owning document's typed result.
                    const header = opened?.isDecrypted && opened.rawHeader ? opened.rawHeader : {};
                    items.push({ artifactId: artifact.id, header,
                        ...(options.includeBody && opened?.isDecrypted ? { body: opened.body, bodyVersion: opened.bodyVersion } : {}),
                        headerVersion: artifact.headerVersion, seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
                        ownerAccountId: artifact.ownerAccountId, access: artifact.access,
                    });
                }
                const last = artifacts.at(-1);
                const nextCursor = options.limit !== undefined && artifacts.length === options.limit && last
                    ? encodeArtifactListCursor({ artifactId: last.id, updatedAt: last.updatedAt }) : undefined;
                return { items, ...(nextCursor ? { nextCursor } : {}) };
        };
        const readArtifactHtmlPreview = async (artifact: DecryptedArtifact, operationSignal?: AbortSignal): Promise<Readonly<{ previewUrl?: string; previewError?: 'artifact_html_preview_unavailable' }>> => {
            if (!isArtifactHtmlHeaderV1(artifact.rawHeader ?? artifact.header)) return {};
            try {
                const previewUrl = await fetchArtifactHtmlPreviewFromApi({ ...await artifactParams(), artifactId: artifact.id,
                    artifact, signal: operationSignal ?? signal, forbiddenOrigins: [new URL(profile.serverUrl).origin] });
                assertCurrent();
                return { previewUrl };
            } catch {
                assertCurrent();
                operationSignal?.throwIfAborted();
                return { previewError: 'artifact_html_preview_unavailable' };
            }
        };
        const createArtifactDocument = async ({ artifactId, header, body, signal: operationSignal }: ArtifactCreateOperation) => {
            assertCurrent();
            const publication: { artifact?: DecryptedArtifact } = {};
            await createArtifactWithHeaderViaApi({ ...await artifactParams(), artifactId, signal: operationSignal ?? signal,
                header, body,
                addArtifact: (artifact) => {
                    assertCurrent();
                    publication.artifact = artifact;
                    if (canPublish()) storage.getState().addArtifact(artifact);
                },
            });
            assertCurrent();
            const created = publication.artifact;
            if (!created?.isDecrypted || created.bodyVersion === undefined) throw artifactContentUnavailable();
            return { artifactId: created.id, revision: { headerVersion: created.headerVersion, bodyVersion: created.bodyVersion },
                ...await readArtifactHtmlPreview(created, operationSignal) };
        };
        const updateArtifactDocument = async ({ artifactId, expectedRevision, header, body, signal: operationSignal }: ArtifactUpdateOperation) => {
                const current = await fetchArtifact(artifactId, { signal: operationSignal });
                if (!current) return { ok: false as const, errorCode: 'not_found', error: 'Artifact not found' };
                readableArtifactHeader(current);
                const publication: { artifact?: DecryptedArtifact } = {};
                try {
                    await updateArtifactWithHeaderViaApi({ ...await artifactParams(), artifactId, expectedRevision, signal: operationSignal,
                        header, body, getArtifact: () => current,
                        updateArtifact: (artifact) => {
                            assertCurrent();
                            publication.artifact = artifact;
                            if (canPublish()) storage.getState().updateArtifact(artifact);
                        },
                    });
                    assertCurrent();
                    const updated = publication.artifact;
                    if (!updated || updated.bodyVersion === undefined) throw artifactContentUnavailable();
                    return { ok: true as const, revision: { headerVersion: updated.headerVersion, bodyVersion: updated.bodyVersion },
                        ...await readArtifactHtmlPreview(updated, operationSignal) };
                } catch (error) {
                    assertCurrent();
                    if (error instanceof Error && 'code' in error && error.code === 'version_mismatch') {
                        return { ok: false as const, errorCode: 'version_mismatch', error: error.message };
                    }
                    throw error;
                }
        };
        const workflowArtifacts: WorkflowDefinitionArtifactOperations = {
            read: async (artifactId, options) => {
                const artifact = await fetchArtifact(artifactId, options);
                if (!artifact) return null;
                const header = readableRawArtifactHeader(artifact);
                if (artifact.bodyVersion === undefined || (artifact.body !== null && typeof artifact.body !== 'string')) throw artifactContentUnavailable();
                return { artifactId: artifact.id, header, body: artifact.body,
                    ...requireArtifactAccessProjection(artifact),
                    revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            },
            list: listArtifacts,
            create: async (input) => (await createArtifactDocument(input)).artifactId,
            update: updateArtifactDocument,
            delete: async (artifactId, options) => {
                assertCurrent();
                try {
                    await deleteArtifactApi(credentials, artifactId, { request, ...options });
                    assertCurrent();
                    artifactDataKeys.delete(artifactId);
                    if (canPublish()) storage.getState().deleteArtifact(artifactId);
                    return { ok: true };
                } catch (error) {
                    assertCurrent();
                    if (error instanceof HappyError && error.status === 409 && options?.expectedRevision) {
                        return { ok: false, errorCode: 'version_mismatch', error: error.message };
                    }
                    if (error instanceof HappyError && error.status === 404) {
                        return { ok: false, errorCode: 'not_found', error: error.message };
                    }
                    throw error;
                }
            },
        };
        const readLaunchProfileSnapshot = async (rawProfiles: unknown) => {
            const artifactsById = await loadAiLaunchProfileArtifacts(rawProfiles, workflowArtifacts, signal);
            assertCurrent();
            return readAiLaunchProfileCollection(rawProfiles, { artifactsById, includeShared: true });
        };
        return {
            serverId, serverIdentityId, accountId, credentials, credentialAuthorityKind, request, assertCurrent, assertAccountCurrent, dispose, accountLifetime,
            resolveAccountEncryption,
            readLaunchProfileSnapshot,
            readLaunchProfiles: async (rawProfiles: unknown) => {
                return (await readLaunchProfileSnapshot(rawProfiles)).entries
                    .flatMap((entry) => entry.kind === 'opaque' ? [] : [entry.profile]);
            },
            readRawSettings: async () => {
                const { accountMode, encryption } = await resolveAccountEncryption();
                const baseline = await readAccountSettingsBaseline({ request, credentials, encryption, accountMode });
                assertCurrent();
                if (baseline.raw === null && baseline.content !== null) throw artifactContentUnavailable();
                return baseline.raw ?? {};
            },
            mutateRawSettings: async (mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | Promise<Record<string, unknown>>) => {
                const { accountMode, encryption } = await resolveAccountEncryption();
                const baseline = await readAccountSettingsBaseline({ request, credentials, encryption, accountMode });
                assertCurrent();
                const result = await syncSettings({ credentials, encryption, signal, settingsScope: scope,
                    requestContext: { scope, endpointUrl: profile.serverUrl, request }, pendingSettings: {}, clearPendingSettings: () => {},
                    oneShotServerSettingsMutation: { expectedSettingsVersion: baseline.version, rebaseOnConflict: true,
                        mutate: async (raw) => { assertCurrent(); const settings = await mutate(raw); assertCurrent(); return { settings, value: undefined }; } },
                });
                assertCurrent();
                if (!result) throw new Error('Account Settings mutation did not run');
                requireOneShotAccountSettingsMutationApplied(result);
            },
            readSettings: async (): Promise<Settings> => {
                const state = storage.getState();
                if (areAccountSettingsScopesEqual(state.settingsScope, scope)) return state.settings;
                const persisted = loadAccountSettings(scope);
                if (persisted.version !== null) return settingsParse(persisted.settings);
                const { accountMode, encryption } = await resolveAccountEncryption();
                const baseline = await readAccountSettingsBaseline({ request, credentials, encryption, accountMode });
                assertCurrent();
                return settingsParse(baseline.raw);
            },
            readLiveSettings: () => areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                ? storage.getState().settings : null,
            // A prepared invocation retains its original admitted input, not listeners or
            // an idle transport. Recheck its captured credential before that input runs.
            runPrepared: async <T>(run: () => Promise<T>): Promise<T> => {
                const stopWatching = watch();
                try {
                    assertCurrent();
                    signal?.throwIfAborted();
                    const current = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
                    if (current?.token !== credentials.token) abort();
                    assertCurrent();
                    signal?.throwIfAborted();
                    const result = await run();
                    assertCurrent();
                    return result;
                } finally { stopWatching(); }
            },
            fetchArtifact,
            createArtifactDocument,
            updateArtifactDocument, readArtifactHtmlPreview,
            readArtifactPublicLinkResource: async (artifactId: string, operationSignal?: AbortSignal): Promise<ArtifactPublicLinkKeyholdingResourceV1 | null> => {
                const artifact = await fetchArtifact(artifactId, { signal: operationSignal });
                if (!artifact) return null;
                const header = readableRawArtifactHeader(artifact);
                const { accountMode } = await resolveAccountEncryption();
                assertCurrent();
                return { artifactId: artifact.id, header, body: artifact.body,
                    ...requireArtifactAccessProjection(artifact), encryptionMode: accountMode,
                    dataKey: accountMode === 'plain' ? null : artifactDataKeys.get(artifactId)?.dataKey ?? null,
                    ...(artifact.bodyVersion === undefined ? {} : { revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }) };
            },
            workflowArtifacts, artifactAccessGrants, encodeArtifactListCursor, listArtifacts,
            listArtifactRevisions: async (artifactId: string, operationSignal?: AbortSignal) => {
                assertCurrent();
                const result = await fetchArtifactBodyRevisionsFromApi({ ...await artifactParams(), artifactId, signal: operationSignal ?? signal });
                assertCurrent();
                return result;
            },
            restoreArtifactRevision: async (input: ArtifactActionInputV1<'artifact.revisions.restore'>, operationSignal?: AbortSignal) => {
                assertCurrent();
                const result = await restoreArtifactBodyRevisionViaApi({ ...await artifactParams(), ...input, signal: operationSignal ?? signal,
                    updateArtifact: (artifact) => { if (canPublish()) storage.getState().updateArtifact(artifact); },
                });
                assertCurrent();
                return result;
            },
            readArtifactStorageUsage: async (operationSignal?: AbortSignal) => {
                assertCurrent();
                const result = await fetchArtifactStorageUsage(credentials, { request, signal: operationSignal ?? signal });
                assertCurrent();
                return result;
            },
            createArtifact: async (header: Readonly<Record<string, unknown>>, body: string) => (await createArtifactDocument({ header, body })).artifactId,
            // `basis` is the exact read a caller validated its change against; its
            // versions become the CAS expectation. Without one, the latest row is.
            updateArtifact: async (artifactId: string, header: ArtifactHeader, body: string, basis?: DecryptedArtifact) => {
                const current = basis ?? await fetchArtifact(artifactId);
                await updateArtifactWithHeaderViaApi({
                    ...await artifactParams(), artifactId, header, body,
                    getArtifact: () => current ?? undefined,
                    updateArtifact: (artifact: DecryptedArtifact) => { if (canPublish()) storage.getState().updateArtifact(artifact); },
                });
                assertCurrent();
            },
        };
    } catch (error) {
        dispose();
        throw error;
    }
}

export type LazyActionAccountContext = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;

/**
 * Bind a shared Action invocation to the requested Home and resolve its encryption mode and keys
 * before returning, for callers that read `accountMode` / `encryption` directly.
 */
export async function captureActionAccountContext(serverIdRaw: string, signal?: AbortSignal) {
    const context = await captureLazyActionAccountContext(serverIdRaw, signal);
    try {
        const { accountMode, encryption } = await context.resolveAccountEncryption();
        return { ...context, accountMode, encryption };
    } catch (error) {
        context.dispose();
        throw error;
    }
}

export type ActionAccountContext = Awaited<ReturnType<typeof captureActionAccountContext>>;
