import { pick } from 'zod/mini';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { TokenStorage, subscribeHomeCredentialMutations, areCredentialsEqual, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { ArtifactAccessRecipientCensusResponseV1Schema, type ArtifactAccessGrantMutationResponseV1, type ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { completeArtifactAccessMutationPreparationV1 } from '@happier-dev/protocol/artifacts/artifactRecipientKeyPreparationV1';
import { artifactKindHasSharedWidgetInputsV1, readArtifactSharedAudienceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { loadAiLaunchProfileArtifacts, readAiLaunchProfileCollection } from '@happier-dev/protocol/profiles/read';
import type { ArtifactAccessActionTransportV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import type { ArtifactActionInputV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { artifactHtmlBundleFromBodyV1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import type { ArtifactSavedByV1, ArtifactWorkspaceSourceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ArtifactPublicLinkKeyholdingResourceV1, WorkflowDefinitionArtifactOperations } from '@happier-dev/protocol/actions';
import type { getActionSpec } from '@happier-dev/protocol';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { areServerProfileIdentifiersEquivalent, buildHomeConnectionDescriptorForProfile, getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storage';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { syncSettings, requireOneShotAccountSettingsMutationApplied, type AccountSettingsMutationCapture } from '@/sync/engine/settings/syncSettings';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { bindAccountEncryptionObservation, captureAccountEncryptionObservationForHome, readAccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { parseToken } from '@/utils/auth/parseToken';
import { createArtifactWithHeaderViaApi, decryptArtifactListItems, fetchArtifactWithBodyFromApi, fetchArtifactsWithBodiesFromApi, updateArtifactWithHeaderViaApi,
    fetchArtifactBodyRevisionsFromApi, fetchArtifactBinaryFromApi, restoreArtifactBodyRevisionViaApi, type ArtifactDataKeyCache } from '@/sync/engine/artifacts/syncArtifacts';
import { listArtifactHeadersV1, type ArtifactListPageOptionsV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { createArtifactAccessApi, deleteArtifact as deleteArtifactApi, fetchArtifactListPage, fetchArtifactStorageUsage, encodeArtifactListCursor } from '@/sync/api/artifacts/apiArtifacts';
import { HappyError } from '@/utils/errors/errors';
import type { Artifact, ArtifactBodyInput, ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { resolveHomeTarget as resolveCapturedHomeTarget, resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { isActionEffectResult as isEffectResult } from '@/sync/domains/scope/actionAccountScopeError';

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

const artifactAccessProjectionSchema = pick(ArtifactAccessRecipientCensusResponseV1Schema, { ownerAccountId: true, access: true });
type ArtifactCreateOperation = Readonly<{ artifactId?: string; header: Readonly<Record<string, unknown>>; body: ArtifactBodyInput; savedBy?: ArtifactSavedByV1; source?: ArtifactWorkspaceSourceV1; memoryDecisionSource?: CoordinationMessageRefV1; signal?: AbortSignal }>;
type ArtifactUpdateOperation = Omit<Parameters<WorkflowDefinitionArtifactOperations['update']>[0], 'body'> & Readonly<{ body: ArtifactBodyInput; savedBy?: ArtifactSavedByV1 }>;
type ArtifactContentReadOptions = NonNullable<Parameters<WorkflowDefinitionArtifactOperations['read']>[1]> & Readonly<{ includeGrants?: boolean }>;
type ArtifactContentRead = NonNullable<Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>>> & Readonly<{
    publicAudience?: DecryptedArtifact['publicAudience'];
    grants?: ArtifactAccessGrantsListResponseV1['grants'] | null;
}>;
type ArtifactHtmlBundleRead = Readonly<{ bundle: ArtifactHtmlBundleV1; revision: Readonly<{ headerVersion: number; bodyVersion: number }> }>;
type ArtifactReadOptions = Readonly<{ signal?: AbortSignal; prepareRecipientKeys?: boolean; fresh?: boolean }>;
type ActionEffectClass = ReturnType<typeof getActionSpec>['sideEffectClass'];
export type RawSettingsMutationOptions = Readonly<{
    signal?: AbortSignal;
    expectedProfileTransferRevision?: number | 'absent';
    expectedSettingsVersion?: number;
    rebaseOnConflict?: boolean;
    observeOutcome?: boolean;
    capture?: (transition: AccountSettingsMutationCapture) => unknown;
}>;

/** A refreshed Account bearer keeps authority; replacement identity, keys and restricted credentials do not. */
function retainsActionAccountCredential(original: AuthCredentials | null, next: AuthCredentials | null | undefined): boolean {
    if (!original || !next) return false;
    if (areCredentialsEqual(original, next)) return true;
    if (readCredentialAuthorityKind(original.token) !== 'account' || readCredentialAuthorityKind(next.token) !== 'account') return false;
    try {
        return parseToken(original.token) === parseToken(next.token)
            && areCredentialsEqual({ ...original, token: next.token }, next);
    } catch {
        return false;
    }
}

function requireArtifactAccessProjection(artifact: DecryptedArtifact) {
    const projection = artifactAccessProjectionSchema.safeParse({ ownerAccountId: artifact.ownerAccountId, access: artifact.access });
    if (!projection.success) throw artifactContentUnavailable();
    return projection.data;
}

/**
 * Bind a shared Action invocation to the requested Home and Account, without reading the Account's
 * encryption mode. The mode (`Account.encryptionMode`, the authority) is resolved once, on first use,
 * by `resolveAccountMode()`. `resolveAccountEncryption()` additionally resolves its keys: every operation here that depends on
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
            throwIfAborted(signal);
            assertAccountCurrent();
        };
        const assertResultCurrent = (effectClass?: ActionEffectClass, invocationSignal = signal) => {
            if (!isEffectResult(effectClass)) { throwIfAborted(invocationSignal); assertAccountCurrent(); }
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
            // The embed producer publishes its captured scope.endpointUrl as serverId.
            serverId: embed.serverId, endpointUrl: embed.serverId, serverIdentityId: undefined, accountId: embed.accountId,
            resolveHomeTarget: unavailable, shareableServerUrl: null,
            accountLifetime: { scope: { serverId: embed.serverId, accountId: embed.accountId }, isCurrent: embed.isCurrent, onRetire: embed.onRetire },
            accountOnlyLifetime: { scope: { serverId: embed.serverId, accountId: embed.accountId }, isCurrent: embed.isCurrent, onRetire: embed.onRetire },
            credentials: embed.credentials, credentialAuthorityKind: 'api_token' as const, invocationSignal: signal,
            request: embed.request, readTransport: undefined,
            assertCurrent, assertAccountCurrent, assertResultCurrent, dispose: () => {},
            resolveAccountMode: unavailable, resolveAccountEncryption: unavailable, readSettings: unavailable, readRawSettings: unavailable,
            readRawSettingsSnapshot: unavailable,
            readLaunchProfiles: unavailable, readLaunchProfileSnapshot: unavailable,
            mutateRawSettings: async (_mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | Promise<Record<string, unknown>>,
                options?: RawSettingsMutationOptions) => {
                    assertCurrent();
                    throwIfAborted(options?.signal);
                    return unavailable();
                }, readLiveSettings: () => null,
            runPrepared: async <T>(run: () => Promise<T>, effectClass?: ActionEffectClass): Promise<T> => {
                assertCurrent(); const result = await run(); assertResultCurrent(effectClass); return result;
            },
            fetchArtifact: async (_artifactId: string, _options?: ArtifactReadOptions) => unavailable(),
            readArtifact: async (_artifactId: string, _options?: ArtifactReadOptions): Promise<DecryptedArtifact | null> => artifactUnavailable(),
            readArtifactContent: async (_artifactId: string, _options?: ArtifactContentReadOptions): Promise<ArtifactContentRead | null> => artifactUnavailable(),
            readArtifactContents: async (_ids: readonly string[], _options?: Parameters<WorkflowDefinitionArtifactOperations['read']>[1]):
                Promise<PromiseSettledResult<Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>>>[]> => artifactUnavailable(),
            createArtifact: async (_header: Readonly<Record<string, unknown>>, _body: string) => unavailable(),
            createArtifactDocument: async (_input: ArtifactCreateOperation) => artifactUnavailable(),
            updateArtifactDocument: async (_input: ArtifactUpdateOperation) => artifactUnavailable(),
            updateArtifact: async (_artifactId: string, _header: ArtifactHeader, _body: string, _basis?: DecryptedArtifact, _onIssued?: () => void) => unavailable(),
            workflowArtifacts, artifactAccessGrants, encodeArtifactListCursor,
            homeHubArtifactTransport: { read: artifactUnavailable, create: artifactUnavailable, update: artifactUnavailable } satisfies HomeHubArtifactTransportV1,
            listArtifacts: async (_options: Parameters<WorkflowDefinitionArtifactOperations['list']>[0]) => artifactUnavailable(),
            listArtifactRevisions: async (_artifactId: string, _signal?: AbortSignal) => artifactUnavailable(),
            restoreArtifactRevision: async (_input: ArtifactActionInputV1<'artifact.revisions.restore'>, _signal?: AbortSignal, _savedBy?: ArtifactSavedByV1) => artifactUnavailable(),
            readArtifactStorageUsage: async (_signal?: AbortSignal) => artifactUnavailable(),
            readArtifactPublicLinkResource: async (_artifactId: string, _signal?: AbortSignal,
                _options?: Readonly<{ prepareRecipientKeys?: boolean }>): Promise<ArtifactPublicLinkKeyholdingResourceV1 | null> => artifactUnavailable(),
            readArtifactHtmlBundle: async (_artifactId: string, _signal?: AbortSignal): Promise<ArtifactHtmlBundleRead> => artifactUnavailable(),
        };
    }
    if (isEmbedWindowContext()) {
        const { AccountStorageCurrentnessUnavailableError } = await import('@/sync/encryption/accountStorageContext');
        throw new AccountStorageCurrentnessUnavailableError(undefined, 'unauthorized', 'action_home_signed_out');
    }
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw);
    const profile = getServerProfileById(serverId);
    if (!profile) throw new Error('action_home_not_found');
    const endpointUrl = profile.serverUrl;
    const shareableServerUrl = profile.shareableServerUrl ?? null;
    // Resolve only when a Home task needs it, using the Profile captured before
    // credential admission. A later focused Home cannot replace this target.
    const resolveHomeTarget = async () => {
        const descriptor = buildHomeConnectionDescriptorForProfile(profile);
        const savedProfile = { id: profile.id, serverUrl: profile.canonicalServerUrl ?? profile.serverUrl,
            webappUrl: profile.serverUrl };
        return descriptor
            ? resolveHomeTargetFromDescriptor({ descriptor, authority: 'current_connection', profile: savedProfile })
            : resolveCapturedHomeTarget({ input: { kind: 'saved_profile', profileRef: profile.id },
                readSavedProfile: async () => savedProfile });
    };
    const serverIdentityId = profile.serverIdentityId?.trim() || undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    let admittedCredentials: AuthCredentials | null = null;
    const watch = () => {
        // Actions retain their explicit Home/Account, including while focused
        // Sync reauthenticates. Transport availability is not Account retirement.
        const unsubscribe = subscribeHomeCredentialMutations((event) => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                && (event.kind === 'credentials_removed' || !retainsActionAccountCredential(admittedCredentials, event.credentials))) abort();
        });
        return unsubscribe;
    };
    const dispose = watch();
    const assertAccountCurrent = () => {
        if (controller.signal.aborted) {
            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        }
    };
    const assertCurrent = () => {
        throwIfAborted(signal);
        assertAccountCurrent();
    };
    // Disclose read content only in its current scope; an effect receipt stays true for its invoker.
    const assertResultCurrent = (effectClass?: ActionEffectClass, invocationSignal = signal) => {
        if (!isEffectResult(effectClass)) { throwIfAborted(invocationSignal); assertAccountCurrent(); }
    };
    try {
        throwIfAborted(signal);
        const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
        assertCurrent();
        throwIfAborted(signal);
        if (!credentials) {
            const { AccountStorageCurrentnessUnavailableError } = await import('@/sync/encryption/accountStorageContext');
            throw new AccountStorageCurrentnessUnavailableError(undefined, 'unauthorized', 'action_home_signed_out');
        }
        admittedCredentials = credentials;
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
        // Capability cleanup can outlive user cancellation, but can never
        // borrow a replacement Account. Reuse the original credential watch.
        const accountOnlyLifetime = {
            scope,
            isCurrent: () => { try { assertAccountCurrent(); return true; } catch { return false; } },
            onRetire: (cancel: () => void) => {
                if (controller.signal.aborted) { cancel(); return { dispose: () => {} }; }
                controller.signal.addEventListener('abort', cancel, { once: true });
                return { dispose: () => controller.signal.removeEventListener('abort', cancel) };
            },
        };
        const accountEncryptionObservation = credentialAuthorityKind === 'api_token' ? undefined
            : captureAccountEncryptionObservationForHome({
                serverId, endpointUrl: profile.canonicalServerUrl ?? profile.serverUrl, credentials,
                isCurrent: accountLifetime.isCurrent, signals: [controller.signal, signal],
            });
        // Restricted reads retain their invocation's Action authorization; a
        // neutral Account transport cannot borrow mutation/claim admission.
        const readTransport = credentialAuthorityKind === 'api_token' ? undefined
            : createCapturedServerReadTransport({ serverId, profile, credentials, accountEncryptionObservation });
        // Every Action owns an explicit Home target. Resolve it through the
        // canonical scoped carrier so a staged focus change cannot retarget an
        // Action through the ambient focused request path.
        const request: ServerFetch = async (path, init, options) => {
            assertCurrent();
            const method = (init?.method ?? 'GET').toUpperCase();
            const mutation = method !== 'GET' && method !== 'HEAD';
            const cancellation = mergeAbortSignals([controller.signal, signal, init?.signal ?? undefined]);
            try {
                throwIfAborted(cancellation.signal);
                const requestInit = { ...init, signal: cancellation.signal };
                const transport = await resolveServerScopedTransport({ profile, credentials });
                try {
                    assertCurrent();
                    throwIfAborted(cancellation.signal);
                    const response = await createServerFetchAtEndpoint({
                        endpointUrl: transport.canonicalServerUrl,
                        runtimeOrigin: transport.runtimeOrigin,
                        serverId,
                        credentials,
                        accountEncryptionObservation,
                        recoverStoredCredentials: true,
                        signal: cancellation.signal,
                        ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                    })(path, requestInit, options);
                    if (!mutation) assertCurrent();
                    return response;
                } finally {
                    try { await transport.release(); }
                    finally { if (!mutation) assertCurrent(); }
                }
            } finally {
                cancellation.dispose();
            }
        };
        const loadAccountMode = async () => {
            const transport = await resolveServerScopedTransport({ profile, credentials });
            const cancellation = mergeAbortSignals([controller.signal, signal]);
            try {
                assertCurrent();
                throwIfAborted(cancellation.signal);
                const endpointRequest = createServerFetchAtEndpoint({
                    endpointUrl: transport.canonicalServerUrl,
                    runtimeOrigin: transport.runtimeOrigin,
                    serverId,
                    credentials,
                    accountEncryptionObservation,
                    recoverStoredCredentials: true,
                    isCurrent: accountLifetime.isCurrent,
                    ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                });
                // Only the actual resolved carrier may lend its authenticated
                // observation to later reads in this captured invocation.
                const binding = readAccountEncryptionObservationBinding(endpointRequest, credentials) ?? undefined;
                bindAccountEncryptionObservation(request, binding);
                const modeRequest: ServerFetch = (path, init, options) => endpointRequest(path,
                    { ...init, signal: cancellation.signal }, options);
                bindAccountEncryptionObservation(modeRequest, binding);
                const mode = (await fetchAccountEncryptionMode(credentials, { request: modeRequest, usage: 'identity' })).mode;
                assertCurrent();
                return mode;
            } finally {
                try { await transport.release(); }
                finally { cancellation.dispose(); }
                assertCurrent();
            }
        };
        let accountMode: ReturnType<typeof loadAccountMode> | null = null;
        const resolveAccountMode = () => {
            assertCurrent();
            return (accountMode ??= loadAccountMode());
        };
        const loadAccountEncryption = async () => {
            const accountMode = await resolveAccountMode();
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
            return accountLifetime.isCurrent() && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope);
        };
        const artifactParams = async () => {
            assertCurrent();
            return { request, readTransport, serverId, credentials, encryption: (await resolveAccountEncryption()).encryption, artifactDataKeys };
        };
        const withArtifactReadSignal = async <T>(operationSignal: AbortSignal | undefined,
            operation: (borrowerSignal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
            assertCurrent();
            try {
                const result = await withActionAccountRequestSignal({ accountLifetime, invocationSignal: signal }, operationSignal, operation);
                assertCurrent();
                return result;
            } catch (error) {
                assertCurrent();
                throw error;
            }
        };
        const readArtifact = async (artifactId: string, options?: ArtifactReadOptions) => {
            return withArtifactReadSignal(options?.signal, async borrowerSignal =>
                fetchArtifactWithBodyFromApi({ ...await artifactParams(), artifactId, signal: borrowerSignal,
                    prepareRecipientKeys: options?.prepareRecipientKeys, fresh: options?.fresh }));
        };
        const fetchArtifact = async (artifactId: string, options?: ArtifactReadOptions) => {
            const artifact = await readArtifact(artifactId, options);
            if (canPublish()) {
                // One read publishes one row, without claiming inventory readiness.
                if (artifact) storage.getState().updateArtifact(artifact);
                else storage.getState().deleteArtifact(artifactId);
            }
            return artifact;
        };
        const accessApi = createArtifactAccessApi(credentials, { request, readTransport, serverId });
        const prepareArtifact = async (artifactId: string, operationSignal?: AbortSignal) => {
            // A held pre-operation census cannot witness the resulting audience.
            const artifact = await fetchArtifact(artifactId, { signal: operationSignal, fresh: true });
            if (!artifact) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
            readableArtifactHeader(artifact);
            assertCurrent();
        };
        const withArtifactPreparation = async (artifactId: string, operation: () => Promise<ArtifactAccessGrantMutationResponseV1>, operationSignal?: AbortSignal) => {
            assertCurrent();
            throwIfAborted(operationSignal);
            const result = await operation();
            // A committed self-revocation has no readable audience for this caller.
            // Preserve the mutation result rather than reopening the inaccessible Artifact.
            if (result.access === null) {
                artifactDataKeys.delete(artifactId);
                if (canPublish()) storage.getState().deleteArtifact(artifactId);
                return result;
            }
            return completeArtifactAccessMutationPreparationV1({ result, prepare: () => prepareArtifact(artifactId, operationSignal) });
        };
        const artifactAccessGrants: ArtifactAccessActionTransportV1 = {
            list: async (input, operationSignal) => {
                assertCurrent();
                throwIfAborted(operationSignal);
                const result = await accessApi.list(input, operationSignal);
                await prepareArtifact(input.artifactId, operationSignal);
                return result;
            },
            set: (input, operationSignal) => withArtifactPreparation(input.artifactId, () => accessApi.set(input, operationSignal), operationSignal),
            remove: (input, operationSignal) => withArtifactPreparation(input.artifactId, () => accessApi.remove(input, operationSignal), operationSignal),
        };
        const projectArtifactListItem = (artifact: Pick<Artifact, 'id' | 'bodyVersion' | 'headerVersion' | 'seq' | 'createdAt' | 'updatedAt' | 'ownerAccountId' | 'access'>,
            opened: DecryptedArtifact | null | undefined, includeBody?: boolean) => ({
                artifactId: artifact.id, header: opened?.isDecrypted && opened.rawHeader ? opened.rawHeader : {},
                ...(artifact.bodyVersion !== undefined ? { bodyVersion: artifact.bodyVersion } : {}),
                ...(includeBody && opened?.isDecrypted ? { body: opened.body, bodyVersion: opened.bodyVersion,
                    provenance: opened.provenance } : {}),
                headerVersion: artifact.headerVersion, seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
                ownerAccountId: artifact.ownerAccountId, access: artifact.access,
                publicAudience: opened?.publicAudience,
            });
        const listArtifacts = async (options: ArtifactListPageOptionsV1) => {
                // Only the background inventory yields to the routed Session.
                // Exact reads and user writes (including Approve) have their
                // own captured Account and must not wait for that acquisition.
                const { sync } = await import('@/sync/sync');
                await sync.awaitBootstrapForegroundAcquisition();
                assertCurrent();
                const params = await artifactParams();
                assertCurrent();
                const page = await withArtifactReadSignal(options.signal, borrowerSignal =>
                    fetchArtifactListPage(credentials, { request, readTransport, ...options, serverId, signal: borrowerSignal }));
                const artifacts = page.items;
                assertCurrent();
                // Header inventories classify content without consuming private attribution.
                // Exact/body reads retain its validation and disclosure boundary.
                const openedArtifacts = await decryptArtifactListItems({ ...params, artifacts,
                    includeBody: options.includeBody, includeProvenance: options.includeBody === true });
                assertCurrent();
                const items = [];
                let coverage: 'complete' | 'partial' = 'complete';
                for (const [index, artifact] of artifacts.entries()) {
                    const opened = openedArtifacts[index] ?? null;
                    // Unopened headers cannot be classified; body failures keep
                    // their readable header for the owning document's typed result.
                    if (!opened?.isDecrypted || !opened.rawHeader) {
                        coverage = 'partial';
                        // A failed header remains a structural row in ordinary
                        // lists, but cannot supply a classification repair.
                        if (options.unclassified) continue;
                    }
                    items.push(projectArtifactListItem(artifact, opened, options.includeBody));
                }
                const last = artifacts.at(-1);
                const nextCursor = options.limit !== undefined && artifacts.length === options.limit && last
                    ? encodeArtifactListCursor({ artifactId: last.id, updatedAt: last.updatedAt }) : undefined;
                return { items, coverage, ...(page.kindCoverage ? { kindCoverage: page.kindCoverage } : {}),
                    ...(page.hasUnclassified === undefined ? {} : { hasUnclassified: page.hasUnclassified }),
                    ...(nextCursor ? { nextCursor } : {}) };
        };
        const createArtifactDocument = async ({ artifactId, header, body, savedBy, source, memoryDecisionSource, signal: operationSignal }: ArtifactCreateOperation) => {
            assertCurrent();
            const publication: { artifact?: DecryptedArtifact } = {};
            await createArtifactWithHeaderViaApi({ ...await artifactParams(), artifactId, signal: operationSignal ?? signal,
                header, body, source, memoryDecisionSource, savedBy: savedBy ?? { kind: 'person', accountId },
                addArtifact: (artifact) => {
                    publication.artifact = artifact;
                    if (canPublish()) storage.getState().addArtifact(artifact);
                },
            });
            const created = publication.artifact;
            if (!created?.isDecrypted || created.bodyVersion === undefined) throw artifactContentUnavailable();
            return { artifactId: created.id, artifact: created, revision: { headerVersion: created.headerVersion, bodyVersion: created.bodyVersion } };
        };
        const updateArtifactDocument = async ({ artifactId, expectedRevision, header, body, savedBy, memoryDecisionSource, signal: operationSignal }: ArtifactUpdateOperation) => {
                const current = await fetchArtifact(artifactId, { signal: operationSignal, fresh: true });
                if (!current) return { ok: false as const, errorCode: 'not_found', error: 'Artifact not found' };
                readableArtifactHeader(current);
                const publication: { artifact?: DecryptedArtifact } = {};
                try {
                    await updateArtifactWithHeaderViaApi({ ...await artifactParams(), artifactId, expectedRevision, signal: operationSignal ?? signal,
                        header, body, memoryDecisionSource, savedBy: savedBy ?? { kind: 'person', accountId }, getArtifact: () => current,
                        updateArtifact: (artifact) => {
                            publication.artifact = artifact;
                            if (canPublish()) storage.getState().updateArtifact(artifact);
                        },
                    });
                    const updated = publication.artifact;
                    if (!updated || updated.bodyVersion === undefined) throw artifactContentUnavailable();
                    return { ok: true as const, revision: { headerVersion: updated.headerVersion, bodyVersion: updated.bodyVersion } };
                } catch (error) {
                    if (error instanceof Error && 'code' in error && error.code === 'version_mismatch') {
                        return { ok: false as const, errorCode: 'version_mismatch', error: error.message };
                    }
                    throw error;
                }
        };
        const projectArtifactDocument = async (artifact: DecryptedArtifact | null,
            options?: ArtifactContentReadOptions): Promise<ArtifactContentRead | null> => {
                if (!artifact) return null;
                const artifactId = artifact.id;
                const header = readableRawArtifactHeader(artifact);
                if (artifact.bodyVersion === undefined || (artifact.body !== null && typeof artifact.body !== 'string')) throw artifactContentUnavailable();
                const access = requireArtifactAccessProjection(artifact);
                // Sharing admission and a visible roster borrow the same exact-key read.
                // This promise lives only for this document projection, not beyond its lifetime.
                let grantsRead: Promise<ArtifactAccessGrantsListResponseV1> | undefined;
                const readGrants = () => grantsRead ??= accessApi.list({ artifactId }, options?.signal);
                const sharing = artifactKindHasSharedWidgetInputsV1(header.kind)
                    ? { shared: await readArtifactSharedAudienceV1({ current: { artifactId, header, ...access,
                        publicAudience: artifact.publicAudience }, signal: options?.signal,
                        // The audience is a read of this row, not a roster operation: listing through
                        // `artifactAccessGrants` would reopen and re-prepare the Artifact just read.
                        readGrants }) } : {};
                // Optional presentation never weakens the authoritative shared-input check above.
                const audience = options?.includeGrants ? await readGrants().catch(() => null) : null;
                assertCurrent();
                throwIfAborted(options?.signal);
                return { artifactId: artifact.id, header, body: artifact.body,
                    provenance: artifact.provenance,
                    ...access, ...sharing,
                    ...(options?.includeGrants ? { grants: audience?.artifactId === artifactId
                        && audience.ownerAccountId === access.ownerAccountId ? audience.grants : null } : {}),
                    publicAudience: artifact.publicAudience,
                    revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
        };
        const readArtifactDocument = async (publish: boolean, artifactId: string, options?: ArtifactContentReadOptions) =>
            projectArtifactDocument(await (publish ? fetchArtifact : readArtifact)(artifactId, options), options);
        const readArtifactContents = async (artifactIds: readonly string[], options?: Parameters<WorkflowDefinitionArtifactOperations['read']>[1]) => {
            assertCurrent(); throwIfAborted(options?.signal);
            const results = await withArtifactReadSignal(options?.signal, async borrowerSignal =>
                fetchArtifactsWithBodiesFromApi({ ...await artifactParams(), artifactIds, signal: borrowerSignal }));
            assertCurrent(); throwIfAborted(options?.signal);
            return Promise.allSettled(results.map(async result => {
                if (result.status === 'rejected') throw result.reason;
                return projectArtifactDocument(result.value, options);
            }));
        };
        const workflowArtifacts: WorkflowDefinitionArtifactOperations = {
            read: (...args) => readArtifactDocument(true, ...args),
            list: async options => {
                let bodyCoveragePartial = false;
                const page = await listArtifactHeadersV1({ options,
                    readPage: pageOptions => listArtifacts(pageOptions ?? {}), encodeCursor: encodeArtifactListCursor,
                    // Exact-kind selection opens only matching headers. Ordinary structural
                    // lists retain their existing page/body coverage contract.
                    ...((options.kind || options.kinds || options.headerFilter) && options.includeBody ? { readBodies: async (items: readonly ReturnType<typeof projectArtifactListItem>[]) => {
                        const results = await withArtifactReadSignal(options.signal, async borrowerSignal =>
                            fetchArtifactsWithBodiesFromApi({ ...await artifactParams(), artifactIds: items.map(item => item.artifactId), signal: borrowerSignal }));
                        assertCurrent();
                        return results.flatMap(result => {
                            if (result.status === 'rejected') throw result.reason;
                            const artifact = result.value;
                            if (!artifact) return [];
                            if (!artifact.isDecrypted || !artifact.rawHeader) bodyCoveragePartial = true;
                            return [projectArtifactListItem({ ...artifact, ...requireArtifactAccessProjection(artifact) }, artifact, true)];
                        });
                    } } : {}),
                });
                return bodyCoveragePartial ? { ...page, coverage: 'partial' as const } : page;
            },
            create: async (input) => (await createArtifactDocument(input)).artifactId,
            update: updateArtifactDocument,
            delete: async (artifactId, options) => {
                assertCurrent();
                try {
                    await deleteArtifactApi(credentials, artifactId, { request, readTransport, serverId, ...options });
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
        const homeHubArtifactTransport = {
            read: workflowArtifacts.read,
            list: workflowArtifacts.list,
            delete: workflowArtifacts.delete,
            create: async input => {
                const receipt = await createArtifactDocument(input);
                const artifact = receipt.artifact;
                if (artifact.body !== null && typeof artifact.body !== 'string') throw artifactContentUnavailable();
                const acknowledged = await workflowArtifacts.read(receipt.artifactId, { signal: input.signal });
                if (!acknowledged) throw artifactContentUnavailable();
                return acknowledged;
            },
            update: updateArtifactDocument,
        } satisfies HomeHubArtifactTransportV1 & Pick<WorkflowDefinitionArtifactOperations, 'list' | 'delete'>;
        const readLaunchProfileSnapshot = async (rawProfiles: unknown) => {
            const artifactsById = await loadAiLaunchProfileArtifacts(rawProfiles, workflowArtifacts, signal);
            assertCurrent();
            return readAiLaunchProfileCollection(rawProfiles, { artifactsById, includeShared: true });
        };
        const readRawSettingsSnapshot = async () => {
            const { accountMode, encryption } = await resolveAccountEncryption();
            const baseline = await readAccountSettingsBaseline({ request, credentials, encryption, accountMode });
            assertCurrent();
            if (baseline.raw === null && baseline.content !== null) throw artifactContentUnavailable();
            return { raw: baseline.raw ?? {}, version: baseline.version };
        };
        return {
            serverId, endpointUrl, serverIdentityId, accountId, credentials, credentialAuthorityKind, invocationSignal: signal,
            readTransport,
            resolveHomeTarget, shareableServerUrl,
            request, assertCurrent, assertAccountCurrent, assertResultCurrent, dispose, accountLifetime, accountOnlyLifetime,
            resolveAccountMode, resolveAccountEncryption,
            readLaunchProfileSnapshot,
            readLaunchProfiles: async (rawProfiles: unknown) => {
                return (await readLaunchProfileSnapshot(rawProfiles)).entries
                    .flatMap((entry) => entry.kind === 'opaque' ? [] : [entry.profile]);
            },
            readRawSettingsSnapshot,
            readRawSettings: async () => (await readRawSettingsSnapshot()).raw,
            mutateRawSettings: async (mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown> | Promise<Record<string, unknown>>,
                options?: RawSettingsMutationOptions) => {
                const cancellation = mergeAbortSignals([signal, options?.signal, controller.signal]);
                const assertMutationCurrent = () => {
                    assertCurrent();
                    throwIfAborted(cancellation.signal);
                };
                const mutationRequest: ServerFetch = async (path, init, requestOptions) => {
                    const requestCancellation = mergeAbortSignals([cancellation.signal, init?.signal ?? undefined]);
                    try {
                        assertMutationCurrent();
                        return await request(path, { ...init, signal: requestCancellation.signal }, requestOptions);
                    } finally { requestCancellation.dispose(); }
                };
                try {
                    assertMutationCurrent();
                    const { accountMode, encryption } = await resolveAccountEncryption();
                    assertMutationCurrent();
                    const settingsSecretsKeys = await resolveSettingsSecretsKeySet({ credentials, scope });
                    assertMutationCurrent();
                    const baseline = await readAccountSettingsBaseline({ request: mutationRequest, credentials, encryption, accountMode });
                    assertMutationCurrent();
                    const result = await syncSettings({ credentials, encryption, signal: cancellation.signal, settingsScope: scope,
                        settingsSecretsKey: settingsSecretsKeys?.writeKey ?? null,
                        settingsSecretsReadKeys: settingsSecretsKeys?.readKeys ?? [],
                        requestContext: { scope, endpointUrl: profile.serverUrl, request: mutationRequest }, pendingSettings: {}, clearPendingSettings: () => {},
                        oneShotServerSettingsMutation: { expectedSettingsVersion: options?.expectedSettingsVersion ?? baseline.version,
                            rebaseOnConflict: options?.rebaseOnConflict ?? true,
                            ...(options?.capture ? { capture: options.capture } : {}),
                            ...(options?.expectedProfileTransferRevision === undefined ? {} : { expectedProfileTransferRevision: options.expectedProfileTransferRevision }),
                            mutate: async (raw) => {
                                assertMutationCurrent();
                                const settings = await mutate(raw);
                                assertMutationCurrent();
                                return { settings, value: undefined };
                            } },
                    });
                    // A committed effect receipt stays true after retirement. The
                    // Settings owner separately guards publication into the live scope.
                    if (result?.status !== 'applied') assertCurrent();
                    if (!result) throw new Error('Account Settings mutation did not run');
                    if (result.status === 'invalid') return requireOneShotAccountSettingsMutationApplied(result);
                    if (!options?.observeOutcome) requireOneShotAccountSettingsMutationApplied(result);
                    return result;
                } finally { cancellation.dispose(); }
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
            runPrepared: async <T>(run: () => Promise<T>, effectClass?: ActionEffectClass): Promise<T> => {
                const stopWatching = watch();
                try {
                    assertCurrent();
                    throwIfAborted(signal);
                    const current = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
                    if (!retainsActionAccountCredential(credentials, current)) abort();
                    assertCurrent();
                    throwIfAborted(signal);
                    const result = await run();
                    assertResultCurrent(effectClass);
                    return result;
                } finally { stopWatching(); }
            },
            fetchArtifact,
            readArtifact,
            // Finite content observations use the same codec and authority without
            // invalidating the list that is currently reading them.
            readArtifactContent: (artifactId: string, options?: ArtifactContentReadOptions): Promise<ArtifactContentRead | null> => readArtifactDocument(false, artifactId, options),
            readArtifactContents,
            createArtifactDocument,
            updateArtifactDocument,
            readArtifactHtmlBundle: async (artifactId: string, operationSignal?: AbortSignal): Promise<ArtifactHtmlBundleRead> => {
                const artifact = await fetchArtifact(artifactId, { signal: operationSignal });
                const header = readableRawArtifactHeader(artifact);
                if (!artifact || header.kind !== 'html' || artifact.body == null || artifact.bodyVersion === undefined) throw artifactContentUnavailable();
                const body = typeof artifact.body === 'string' ? artifact.body
                    : await fetchArtifactBinaryFromApi({ ...await artifactParams(), artifactId, reference: artifact.body, artifact, signal: operationSignal ?? signal });
                assertCurrent();
                throwIfAborted(operationSignal);
                const mime = typeof artifact.body === 'string' ? typeof header.mime === 'string' ? header.mime : undefined : artifact.body.mime;
                return { bundle: artifactHtmlBundleFromBodyV1(body, mime, 'stored'), revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
            },
            readArtifactPublicLinkResource: async (artifactId: string, operationSignal?: AbortSignal,
                options?: Readonly<{ prepareRecipientKeys?: boolean }>): Promise<ArtifactPublicLinkKeyholdingResourceV1 | null> => {
                const artifact = await fetchArtifact(artifactId, { signal: operationSignal, prepareRecipientKeys: options?.prepareRecipientKeys });
                if (!artifact) return null;
                const header = readableRawArtifactHeader(artifact);
                // A shared resource retains its owner's admitted mode, not this reader's Account mode.
                const mode = artifact.storageMode;
                if (mode !== 'plain' && mode !== 'e2ee') throw artifactContentUnavailable();
                assertCurrent();
                return { artifactId: artifact.id, header, body: artifact.body,
                    ...requireArtifactAccessProjection(artifact), encryptionMode: mode,
                    dataKey: mode === 'plain' ? null : artifactDataKeys.get(artifactId)?.dataKey ?? null,
                    ...(artifact.bodyVersion === undefined ? {} : { revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } }) };
            },
            workflowArtifacts, homeHubArtifactTransport, artifactAccessGrants, encodeArtifactListCursor, listArtifacts,
            listArtifactRevisions: async (artifactId: string, operationSignal?: AbortSignal) => {
                assertCurrent();
                const result = await fetchArtifactBodyRevisionsFromApi({ ...await artifactParams(), artifactId, signal: operationSignal ?? signal });
                assertCurrent();
                return result;
            },
            restoreArtifactRevision: async (input: ArtifactActionInputV1<'artifact.revisions.restore'>, operationSignal?: AbortSignal, savedBy?: ArtifactSavedByV1) => {
                assertCurrent();
                const result = await restoreArtifactBodyRevisionViaApi({ ...await artifactParams(), ...input, signal: operationSignal ?? signal,
                    savedBy: savedBy ?? { kind: 'person', accountId },
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
            updateArtifact: async (artifactId: string, header: ArtifactHeader, body: string, basis?: DecryptedArtifact, onIssued?: () => void) => {
                const current = basis ?? await fetchArtifact(artifactId, { fresh: true });
                const artifactOptions = await artifactParams();
                await updateArtifactWithHeaderViaApi({
                    ...artifactOptions, artifactId, header, body,
                    ...(onIssued ? { request: ((path, init, options) => artifactOptions.request(path, init, {
                        ...options,
                        ...(init?.method === 'POST' ? { onIssued: () => { onIssued(); options?.onIssued?.(); } } : {}),
                    })) satisfies ServerFetch } : {}),
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

/** One RPC observation borrows its Action's caller and Account cancellation owners. */
export async function withActionAccountRequestSignal<TResult>(
    account: Partial<Pick<LazyActionAccountContext, 'accountLifetime' | 'invocationSignal'>> | undefined,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal | undefined) => Promise<TResult>,
): Promise<TResult> {
    if (!account?.accountLifetime) return await operation(signal ?? account?.invocationSignal);
    const cancellation = new AbortController();
    const retirement = account.accountLifetime.onRetire(() => cancellation.abort());
    const merged = mergeAbortSignals([cancellation.signal, signal ?? account.invocationSignal]);
    try { return await operation(merged.signal); }
    finally { merged.dispose(); retirement.dispose(); }
}

/** Only the Home-open ACK, or a decided terminal outcome whose invoking intent ended, may outlive its invocation signal/lifetime. */
export async function captureApprovalSettlementAccount(original: LazyActionAccountContext, request: ApprovalRequest) {
    if (request.v !== 2 || request.executionOriginV1.accountId !== original.accountId
        || !areServerProfileIdentifiersEquivalent(request.executionOriginV1.serverId, original.serverId)) return null;
    // The invoking intent (for example a Settings write cancelled by a
    // declaration change) may end after the approval was decided. The decided
    // terminal outcome still belongs to the live Account, so only that intent's
    // signal is released from the final Artifact CAS.
    const intentEnded = original.accountOnlyLifetime.isCurrent() && original.invocationSignal?.aborted === true
        && (request.status === 'executed' || request.status === 'failed');
    const homeOpenAck = !original.accountLifetime.isCurrent() && request.actionId === 'account.home_continuation.invoke' && request.status === 'executed'
        && request.execution?.ok === true && typeof request.actionArgs === 'object' && request.actionArgs !== null
        && 'operation' in request.actionArgs && request.actionArgs.operation === 'open'
        && typeof request.execution.result === 'object' && request.execution.result !== null
        && 'status' in request.execution.result && request.execution.result.status === 'completed';
    if (!intentEnded && !homeOpenAck) return null;
    const settlement = await captureLazyActionAccountContext(original.serverId, intentEnded ? undefined : original.invocationSignal);
    if (settlement.accountId !== original.accountId || settlement.endpointUrl !== original.endpointUrl
        || settlement.serverIdentityId !== original.serverIdentityId || !retainsActionAccountCredential(original.credentials, settlement.credentials)) {
        settlement.dispose();
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    return settlement;
}

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
