import { createPlainSessionOwnerMetadataEnvelopeV1, type SessionOwnerMetadataEnvelopeV1, type SessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import type {
    SessionMetadataOwnerMigrationCurrentnessV1,
} from '@happier-dev/cli-common/sessionMetadata';
import type { DecryptOptions } from '@/sync/encryption/encryptor';
import type { EncryptionScopeInput } from '@/sync/encryption/encryption';
import { createSessionDisplayCrypto } from '@/sync/encryption/sessionDisplayCrypto';
import { validateSessionDisplayProjectionV1 } from '@happier-dev/protocol';
import { updateSessionMetadataWithRetry } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';
import { emitSessionMetadataTuplePatch } from './emitSessionMetadataUpdateWithServerScope';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { fetchAndApplySessionById, type SessionByIdContentDemand, type SessionByIdEncryption, type SessionByIdPrefetchedRead } from '@/sync/engine/sessions/sessionById';
import { fetchAccountEncryptionCurrentness, captureAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { readSessionDetailAccessProjectionVersion } from '@/sync/api/session/sessionDetailAccessProjection';

import {
    createServerRequestForResolvedServerScope,
    runWithServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
    type ServerAccountRequestOptions,
} from './createServerRequestWithServerScope';
import { resolveServerAccountRequestContext, type ResolvedServerAccountRequestContext } from './resolveServerAccountRequestContext';
import { storage } from '@/sync/domains/state/storage';
import {
    resolveUiClientEncryptionRequirement,
    resolveUiClientEncryptionRequirementForScope,
} from '@/sync/domains/settings/clientEncryptionRequirement';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { CapturedServerReadTransport } from './capturedServerReadTransport';
import { sameAccountEncryptionIdentity } from '@happier-dev/sync-client';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

export type SessionMetadataTupleWriterContext = Readonly<{
    encodeSharedDisplay: ReturnType<typeof createSessionDisplayCrypto>['encodeSharedDisplay'];
    encodeOwnerDisplay: ReturnType<typeof createSessionDisplayCrypto>['encodeOwnerDisplay'];
    encryptPayload: (payload: unknown) => Promise<string>;
    encodeOwnerMetadata: (
        ownerMetadata: SessionOwnerMetadataV1,
    ) => SessionOwnerMetadataEnvelopeV1;
    ownerMigrationCurrentness?:
        SessionMetadataOwnerMigrationCurrentnessV1;
}>;

/**
 * Exact HTTP witness retained only for this finite operation's metadata/key
 * correspondence. Its Account/Settings cursors must never come from a socket
 * encryption-identity observation, even when that socket remains connected.
 */
export function createOperationAccountCurrentnessSource(params: Readonly<{
    credentials: AuthCredentials;
    request: (path: string, init: RequestInit) => Promise<Response>;
    initial?: AccountEncryptionCurrentnessResponse;
    serverId?: string | null;
}>) {
    let currentness = params.initial;
    let expected = params.initial;
    let inFlight: Promise<AccountEncryptionCurrentnessResponse> | null = null;
    let readWithdrawn = false;
    const observation = captureAccountEncryptionCurrentness(params.serverId, () => {
        currentness = undefined;
        // Finish a pending read before starting its replacement; concurrent
        // borrowers still share one HTTP read through this finite owner.
        if (inFlight) readWithdrawn = true;
    });
    const isCurrent = observation.isCurrent;
    const assertCurrent = () => {
        if (!isCurrent()) throw Object.assign(new Error('Account encryption currentness changed'),
            { code: 'account_encryption_currentness_changed' });
    };
    const read = async (): Promise<AccountEncryptionCurrentnessResponse> => {
        assertCurrent();
        if (currentness) return currentness;
        if (!inFlight) {
            readWithdrawn = false;
            inFlight = fetchAccountEncryptionCurrentness(params.credentials, { request: params.request });
        }
        const pending = inFlight;
        const observed = await pending;
        assertCurrent();
        if (pending !== inFlight) return await read();
        inFlight = null;
        if (readWithdrawn) return await read();
        if (expected && !sameAccountEncryptionIdentity(expected, observed)) {
            observation.dispose();
            assertCurrent();
        }
        expected ??= observed;
        currentness = observed;
        return observed;
    };
    return {
        isCurrent,
        assertCurrent,
        dispose: observation.dispose,
        peek: () => { assertCurrent(); return currentness; },
        ensureCurrent: async () => {
            assertCurrent();
            if (expected && !currentness) await read();
            assertCurrent();
        },
        read,
    };
}

function resolveOwnerMigrationCurrentness(params: Readonly<{
    credentials: AuthCredentials;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
}>): SessionMetadataTupleWriterContext['ownerMigrationCurrentness'] {
    if (params.accountCurrentness.mode === 'plain') {
        return {
            expectedAccountEncryptionMode: 'plain',
            expectedAccountContentPublicKeyFingerprint: null,
        };
    }
    const snapshot = resolveCurrentAccountOwnerMetadataMaterialSnapshot({
        credentials: params.credentials,
        accountCurrentness: params.accountCurrentness,
    });
    return {
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
            snapshot.contentPublicKeyFingerprint,
    };
}

function resolveCurrentAccountOwnerMetadataMaterialSnapshot(params: Readonly<{
    credentials: AuthCredentials;
    accountCurrentness: AccountEncryptionCurrentnessResponse;
}>) {
    if (params.accountCurrentness.mode === 'plain') {
        throw new Error(
            'Plain Account metadata does not use Account encryption material',
        );
    }
    const snapshot = resolveCurrentAccountScopedCryptoMaterialSnapshot(params);
    if (!snapshot) {
        throw new Error(
            'Account encryption material does not match current Account state',
        );
    }
    return snapshot;
}

export function getScopedSessionByIdEncryption(context: Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: SessionByIdEncryption['initializeSessions'];
    getSessionEncryption: (sessionId: string) => unknown;
    removeSessionEncryption?: (sessionId: string) => void;
    getCurrentEncryptionGenerationScope?: SessionByIdEncryption['getCurrentEncryptionGenerationScope'];
    isCurrentEncryptionGenerationScope?: SessionByIdEncryption['isCurrentEncryptionGenerationScope'];
}> | null): SessionByIdEncryption {
    if (!context) {
        return {
            decryptEncryptionKey: async () => null,
            initializeSessions: async () => {},
            getSessionEncryption: () => null,
        };
    }
    return {
        decryptEncryptionKey: (value) => context.decryptEncryptionKey(value),
        initializeSessions: (keys, options) => context.initializeSessions(keys, options),
        removeSessionEncryption: (sessionId) => context.removeSessionEncryption?.(sessionId),
        ...(context.getCurrentEncryptionGenerationScope ? {
            getCurrentEncryptionGenerationScope: (scope?: EncryptionScopeInput) =>
                context.getCurrentEncryptionGenerationScope!(scope),
        } : {}),
        ...(context.isCurrentEncryptionGenerationScope ? {
            isCurrentEncryptionGenerationScope: (scope) =>
                context.isCurrentEncryptionGenerationScope!(scope),
        } : {}),
        getSessionEncryption: (sessionId) => {
            const candidate = context.getSessionEncryption(sessionId);
            if (!candidate || typeof candidate !== 'object') {
                return null;
            }

            const maybeEncryption = candidate as Partial<{
                encryptRaw: (payload: unknown) => Promise<string>;
                decryptRaw: (ciphertext: string) => Promise<unknown>;
                decryptAgentState: (version: number, value: string | null) => Promise<unknown>;
                decryptAgentStateResult: (version: number, value: string | null | undefined) => Promise<import('@/sync/encryption/sessionEncryption').AgentStateOpenResult>;
                decryptMetadata: (version: number, value: string, options?: DecryptOptions) => Promise<unknown>;
                decryptMetadataPayload: (version: number, value: string, options?: DecryptOptions) => Promise<unknown | null>;
            }>;
            if (typeof maybeEncryption.decryptAgentState !== 'function' || typeof maybeEncryption.decryptMetadata !== 'function') {
                return null;
            }

            return {
                ...(typeof maybeEncryption.decryptRaw === 'function'
                    ? { decryptRaw: (ciphertext: string) => maybeEncryption.decryptRaw!(ciphertext) }
                    : {}),
                ...(typeof maybeEncryption.encryptRaw === 'function'
                    ? {
                        encryptRaw: (payload: unknown) =>
                            maybeEncryption.encryptRaw!(payload),
                    }
                    : {}),
                decryptAgentState: (version, value) =>
                    maybeEncryption.decryptAgentState!(version, value),
                ...(typeof maybeEncryption.decryptAgentStateResult === 'function' ? {
                    decryptAgentStateResult: (version: number, value: string | null | undefined) => maybeEncryption.decryptAgentStateResult!(version, value),
                } : {}),
                decryptMetadata: (version, value, options) =>
                    maybeEncryption.decryptMetadata!(version, value, options),
                ...(typeof maybeEncryption.decryptMetadataPayload === 'function'
                    ? {
                        decryptMetadataPayload: (version: number, value: string, options?: DecryptOptions) =>
                            maybeEncryption.decryptMetadataPayload!(version, value, options),
                    }
                    : {}),
            };
        },
    };
}

async function withMetadataTupleWriterContext<T extends Awaited<
    ReturnType<typeof fetchAndApplySessionById>
>>(params: Readonly<{
    result: T;
    includeMetadataTupleMutationSnapshot?: boolean;
    credentials: AuthCredentials;
    accountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource>;
    encryption: SessionByIdEncryption;
    sessionId: string;
}>): Promise<T & Readonly<{
    metadataTupleWriterContext?: SessionMetadataTupleWriterContext;
}>> {
    if (
        params.includeMetadataTupleMutationSnapshot !== true
        || !params.result.ok
        || !params.result.metadataTupleMutationSnapshot
    ) {
        return params.result;
    }
    let mutationSnapshot =
        params.result.metadataTupleMutationSnapshot;
    const sessionEncryption =
        params.result.session?.encryptionMode === 'plain'
            ? null
            : params.encryption.getSessionEncryption(params.sessionId);
    if (
        params.result.session?.encryptionMode !== 'plain'
        && typeof sessionEncryption?.encryptRaw !== 'function'
    ) {
        throw new Error(
            `Session encryption is required to mutate metadata for ${params.sessionId}`,
        );
    }
    const encryptPayload = async (payload: unknown) => {
        await params.accountCurrentnessSource.ensureCurrent();
        const encrypted = params.result.session?.encryptionMode === 'plain'
            ? JSON.stringify(payload)
            : await sessionEncryption!.encryptRaw!(payload);
        await params.accountCurrentnessSource.ensureCurrent();
        return encrypted;
    };
    const displayCrypto = createSessionDisplayCrypto({
        sessionMode: params.result.session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
        accountMode: params.accountCurrentnessSource.peek()?.mode, credentials: params.credentials,
        sessionEncryption });
    let result = params.result;
    if (mutationSnapshot.mode === 'owner') {
        const accountCurrentness = params.accountCurrentnessSource.peek();
        const linked = validateSessionDisplayProjectionV1({
            projection: mutationSnapshot.displayProjectionV1,
            sessionMode: params.result.session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            accountMode: accountCurrentness?.mode,
            metadataVersion: mutationSnapshot.metadataVersion,
            metadataLayoutVersion: mutationSnapshot.metadataLayoutVersion,
        });
        const shared = linked.ok && (await displayCrypto.openSharedDisplay(linked.projection.shared)).ok;
        const owner = linked.ok && accountCurrentness !== undefined
            && displayCrypto.openOwnerDisplay(linked.projection.owner, accountCurrentness).ok;
        await params.accountCurrentnessSource.ensureCurrent();
        mutationSnapshot = { ...mutationSnapshot, displayProjectionV1Availability: { shared, owner } };
        result = { ...params.result, metadataTupleMutationSnapshot: mutationSnapshot };
    }
    const encodeSharedDisplay: SessionMetadataTupleWriterContext['encodeSharedDisplay'] = async display => {
        await params.accountCurrentnessSource.ensureCurrent();
        const envelope = await displayCrypto.encodeSharedDisplay(display);
        await params.accountCurrentnessSource.ensureCurrent();
        return envelope;
    };
    if (mutationSnapshot.mode === 'shared_editor') {
        return {
            ...result,
            metadataTupleWriterContext: {
                encryptPayload,
                encodeSharedDisplay,
                encodeOwnerDisplay: () => {
                    params.accountCurrentnessSource.assertCurrent();
                    throw new Error(`Shared Session metadata cannot encode owner display for ${params.sessionId}`);
                },
                encodeOwnerMetadata: () => {
                    params.accountCurrentnessSource.assertCurrent();
                    throw new Error(
                        `Shared Session metadata cannot encode owner metadata for ${params.sessionId}`,
                    );
                },
            },
        };
    }
    // Only a tuple writer needs the witness; a retired caller has no result to publish.
    const accountCurrentness = params.accountCurrentnessSource.peek();
    if (!accountCurrentness) {
        throw new Error(
            `Account currentness is required to mutate metadata for ${params.sessionId}`,
        );
    }
    const ownerMigrationCurrentness = resolveOwnerMigrationCurrentness({
        credentials: params.credentials, accountCurrentness,
    });
    return {
        ...result,
        metadataTupleWriterContext: {
            encodeSharedDisplay,
            encodeOwnerDisplay: display => {
                params.accountCurrentnessSource.assertCurrent();
                const envelope = displayCrypto.encodeOwnerDisplay(display);
                params.accountCurrentnessSource.assertCurrent();
                return envelope;
            },
            get ownerMigrationCurrentness() {
                params.accountCurrentnessSource.assertCurrent();
                return ownerMigrationCurrentness;
            },
            encryptPayload,
            encodeOwnerMetadata: (ownerMetadata) => {
                params.accountCurrentnessSource.assertCurrent();
                return accountCurrentness.mode === 'plain'
                    ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
                    : sealSessionOwnerMetadataEnvelopeV1({
                        material:
                            resolveCurrentAccountOwnerMetadataMaterialSnapshot({
                                credentials: params.credentials,
                                accountCurrentness,
                            }).material,
                        ownerMetadata,
                        randomBytes: getRandomBytes,
                    });
            },
        },
    };
}

type FullSessionReadResult = Awaited<ReturnType<typeof fetchAndApplySessionById>>;
type CapturedTupleRead = FullSessionReadResult & Readonly<{
    metadataTupleWriterContext?: SessionMetadataTupleWriterContext;
    displayProjectionMaintenance?: 'satisfied' | 'deferred';
}>;

/** Maintenance consumes this very full read; neither a display row nor a mount is a writer. */
async function maintainAuthorizedFullRead(params: Readonly<{
    result: FullSessionReadResult;
    requestedTuple: boolean;
    credentials: AuthCredentials;
    accountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource>;
    encryption: SessionByIdEncryption;
    sessionId: string;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    readParams: Parameters<typeof fetchAndApplySessionById>[0];
}>): Promise<CapturedTupleRead> {
    const snapshot = params.result.ok ? params.result.metadataTupleMutationSnapshot : null;
    if (!snapshot || (!params.requestedTuple && (snapshot.mode === 'shared_editor'
        || readCredentialAuthorityKind(params.credentials.token) !== 'account'))) return params.result;
    try {
        if (snapshot.mode !== 'shared_editor') await params.accountCurrentnessSource.read();
        const captured = await withMetadataTupleWriterContext({ ...params,
            includeMetadataTupleMutationSnapshot: true });
        if (params.requestedTuple) return captured;
        let current = captured;
        const initialSnapshot = captured.ok ? captured.metadataTupleMutationSnapshot : null;
        if (!initialSnapshot || initialSnapshot.mode === 'shared_editor' || !captured.metadataTupleWriterContext) return params.result;
        const writer = () => {
            params.accountCurrentnessSource.assertCurrent();
            if (params.signal?.aborted) throw params.signal.reason ?? new Error('Session maintenance cancelled');
            if (params.isCurrent?.() === false) throw new Error('Session maintenance authority retired');
            if (!current.metadataTupleWriterContext) throw new Error('Session tuple writer unavailable');
            return current.metadataTupleWriterContext;
        };
        await updateSessionMetadataWithRetry({
            sessionId: params.sessionId,
            initialSnapshot,
            getSession: () => ({ metadata: initialSnapshot.value.metadata, metadataVersion: initialSnapshot.metadataVersion,
                metadataLayoutVersion: initialSnapshot.metadataLayoutVersion }),
            refreshSessions: async () => { throw new Error('Session maintenance requires its captured full tuple'); },
            acquireTupleSnapshot: async () => {
                current = await withMetadataTupleWriterContext({
                    result: await fetchAndApplySessionById({ ...params.readParams, prefetched: undefined,
                        includeMetadataTupleMutationSnapshot: true, fresh: true }),
                    includeMetadataTupleMutationSnapshot: true, credentials: params.credentials,
                    accountCurrentnessSource: params.accountCurrentnessSource, encryption: params.encryption, sessionId: params.sessionId,
                });
                if (!current.ok || !current.metadataTupleMutationSnapshot) throw new Error('Session tuple refresh unavailable');
                writer();
                return current.metadataTupleMutationSnapshot;
            },
            tupleCrypto: {
                encryptPayload: payload => writer().encryptPayload(payload),
                encodeOwnerMetadata: metadata => writer().encodeOwnerMetadata(metadata),
                encodeSharedDisplay: display => writer().encodeSharedDisplay(display),
                encodeOwnerDisplay: display => writer().encodeOwnerDisplay(display),
            },
            getOwnerMigrationCurrentness: () => writer().ownerMigrationCurrentness,
            emitUpdateMetadata: payload => {
                writer();
                if (!('mode' in payload)) throw new Error('Session display maintenance requires a tuple patch');
                return emitSessionMetadataTuplePatch({ sessionId: params.sessionId, patch: payload,
                    request: (path, init) => params.request(path, { ...init, signal: params.signal }),
                    assertCurrent: () => { writer(); } });
            },
            // A CAS receipt is not a freshly opened full Session. Ordinary server
            // publication/read currentness owns any subsequent local version advance.
            applyTupleSnapshot: () => {},
            updater: 'ensureDisplayProjection',
        });
        return { ...params.result, displayProjectionMaintenance: 'satisfied' };
    } catch (error) {
        if (params.requestedTuple) throw error;
        console.warn('[SessionDisplay] Owner display maintenance deferred; readable full Session retained');
        return { ...params.result, displayProjectionMaintenance: 'deferred' };
    }
}

/** Ordinary reads publish immediately; explicit maintenance keeps its containing work budget. */
async function completeAuthorizedFullRead(params: Parameters<typeof maintainAuthorizedFullRead>[0] & Readonly<{
    awaitDisplayProjectionMaintenance?: true;
}>): Promise<CapturedTupleRead> {
    if (params.requestedTuple || params.awaitDisplayProjectionMaintenance) return maintainAuthorizedFullRead(params);
    const snapshot = params.result.ok ? params.result.metadataTupleMutationSnapshot : null;
    if (!snapshot || snapshot.mode === 'shared_editor' || readCredentialAuthorityKind(params.credentials.token) !== 'account') return params.result;
    const serverId = params.readParams.serverId;
    if (!serverId) {
        console.warn('[SessionDisplay] Owner display maintenance deferred; full read has no captured Home');
        return params.result;
    }
    // The caller can release its read authority as soon as this returns. The
    // existing scoped authority owns the maintenance carrier until its CAS ends.
    // Adopt the read's admitted HTTP witness and subscribe before any await, so
    // disposing the parent observation neither loses invalidation nor adds a read.
    let maintenanceRequest = params.request;
    const source = createOperationAccountCurrentnessSource({ credentials: params.credentials, serverId,
        initial: params.accountCurrentnessSource.peek(),
        request: (path, init) => maintenanceRequest(path, init),
    });
    fireAndForget(runWithServerRequestAuthorityForServerAccountScope({ serverId, activeRequest: params.request,
        signal: params.signal }, async authority => {
        const credentials = authority.context.credentials;
        if (!credentials || resolveAuthCredentialsScopeKey(credentials) !== resolveAuthCredentialsScopeKey(params.credentials)) {
            throw new Error('Session display maintenance Account changed');
        }
        maintenanceRequest = authority.request;
        await maintainAuthorizedFullRead({ ...params, credentials, request: authority.request, accountCurrentnessSource: source,
            readParams: { ...params.readParams, request: authority.request, readTransport: authority.readTransport,
                fetchAccountCurrentness: source.read, ensureAccountCurrentness: source.ensureCurrent,
                isCurrent: () => source.isCurrent() && params.isCurrent?.() !== false },
        });
    }).finally(() => source.dispose()), { onError: () => console.warn('[SessionDisplay] Owner display maintenance deferred; readable full Session retained') });
    return params.result;
}

export async function fetchSessionByIdWithServerScope(params: Readonly<{
    sessionId: string;
    prefetched?: SessionByIdPrefetchedRead;
    contentDemand?: SessionByIdContentDemand;
    serverId?: string | null;
    activeCredentials: AuthCredentials;
    sessionKey?: string | null;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
    accountMode?: 'plain' | 'e2ee';
    activeEncryption?: SessionByIdEncryption | null;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
    activeRequest: (path: string, init?: RequestInit, options?: ServerAccountRequestOptions) => Promise<Response>;
    activeReadTransport?: CapturedServerReadTransport;
    applySessions: (sessions: AppliedSession[]) => void;
    applySessionListRows?: Parameters<typeof fetchAndApplySessionById>[0]['applySessionListRows'];
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    getCurrentSessionListRenderable?: (sessionId: string) => SessionListRenderableSession | null | undefined;
    log: { log: (message: string) => void };
    timeoutMs?: number;
    signal?: AbortSignal;
    includeTurnsProjection?: boolean | 'required';
    onSessionObservation?: Parameters<typeof fetchAndApplySessionById>[0]['onSessionObservation'];
    /** Explicit list maintenance awaits its CAS inside the containing concurrency budget. */
    awaitDisplayProjectionMaintenance?: true;
    authority?: ServerAccountRequestAuthority;
    /** Shares the exact Account reader selected here; consumers must not resolve it again. */
    onResolvedContext?: (context: ResolvedServerAccountRequestContext) => void;
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    isCurrent?: () => boolean;
}> & (
    | Readonly<{ includeMetadataTupleMutationSnapshot?: false;
        accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource> }>
    | Readonly<{ includeMetadataTupleMutationSnapshot?: boolean;
        accountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource> }>
)): Promise<
    Awaited<ReturnType<typeof fetchAndApplySessionById>>
    & Readonly<{
        metadataTupleWriterContext?: SessionMetadataTupleWriterContext;
        displayProjectionMaintenance?: 'satisfied' | 'deferred';
    }>
> {
    if (params.sessionKey !== undefined) {
        return await fetchAndApplySessionById({
            sessionId: params.sessionId, serverId: params.serverId,
            prefetched: params.prefetched,
            contentDemand: params.contentDemand,
            credentials: params.activeCredentials, sessionKey: params.sessionKey,
            composerOptionsInput: params.composerOptionsInput ?? null,
            accountMode: params.accountMode,
            encryption: getScopedSessionByIdEncryption(params.activeEncryption ?? null),
            sessionDataKeys: params.sessionDataKeys, sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            request: params.activeRequest,
            applySessions: params.applySessions, applySessionListRows: params.applySessionListRows, getExistingSession: params.getExistingSession,
            getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
            log: params.log, timeoutMs: params.timeoutMs,
            signal: params.signal,
            includeTurnsProjection: params.includeTurnsProjection, isCurrent: params.isCurrent,
            accessProjectionVersion: 1,
        });
    }
    const currentSettings = storage.getState().settings;
    // An unqualified request cannot establish a Home from mutable focus.
    // Keep unknown provenance conservative instead of inventing authority.
    const activeCurrentnessServerId = params.authority?.scope.serverId ?? params.serverId;
    const clientEncryptionRequirement = resolveUiClientEncryptionRequirement({
        syncedSettings: currentSettings,
        localSettings: currentSettings,
    });
    const context = params.authority?.context ?? await resolveServerAccountRequestContext({
        serverId: params.serverId ?? null,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
    });
    const ownsContext = !params.authority;
    let ownedAccountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource> | undefined;
    try {
    params.onResolvedContext?.(context);

    if (context.scope === 'active') {
        const request = params.activeRequest;
        const accountCurrentnessSource =
            params.accountCurrentnessSource ?? (ownedAccountCurrentnessSource = createOperationAccountCurrentnessSource({
                credentials: params.activeCredentials,
                request,
                initial: params.accountCurrentness,
                serverId: activeCurrentnessServerId,
            }));
        const activeEncryption = getScopedSessionByIdEncryption(params.activeEncryption ?? null);
        const readParams = {
            sessionId: params.sessionId,
            prefetched: params.prefetched,
            contentDemand: params.contentDemand,
            serverId: params.serverId ?? null,
            credentials: params.activeCredentials,
            accountCurrentness: accountCurrentnessSource.peek(),
            fetchAccountCurrentness: accountCurrentnessSource.read,
            ensureAccountCurrentness: accountCurrentnessSource.ensureCurrent,
            encryption: activeEncryption,
            sessionDataKeys: params.sessionDataKeys,
            sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            request: params.activeRequest,
            readTransport: params.authority?.readTransport ?? params.activeReadTransport,
            signal: params.signal,
            applySessions: params.applySessions,
            applySessionListRows: params.applySessionListRows,
            getExistingSession: params.getExistingSession,
            getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
            log: params.log,
            timeoutMs: params.timeoutMs,
            includeTurnsProjection: params.includeTurnsProjection,
            includeMetadataTupleMutationSnapshot:
                params.includeMetadataTupleMutationSnapshot === true
                || ((params.contentDemand === undefined || params.contentDemand === 'session')
                    && readCredentialAuthorityKind(params.activeCredentials.token) === 'account'),
            fresh: params.includeMetadataTupleMutationSnapshot === true,
            onSessionObservation: params.onSessionObservation,
            isCurrent: () => accountCurrentnessSource.isCurrent() && params.isCurrent?.() !== false,
            accessProjectionVersion: params.prefetched ? params.prefetched.accessProjectionVersion : readSessionDetailAccessProjectionVersion(params.serverId),
            clientEncryptionRequirement,
        } satisfies Parameters<typeof fetchAndApplySessionById>[0];
        const result = await fetchAndApplySessionById(readParams);
        return await completeAuthorizedFullRead({
            result,
            readParams,
            awaitDisplayProjectionMaintenance: params.awaitDisplayProjectionMaintenance,
            requestedTuple: params.includeMetadataTupleMutationSnapshot === true,
            credentials: params.activeCredentials,
            accountCurrentnessSource,
            encryption: activeEncryption,
            sessionId: params.sessionId,
            request,
            isCurrent: params.isCurrent,
            signal: params.signal,
        });
    }

    const scopedEncryption =
        getScopedSessionByIdEncryption(context.encryption);
    // A scoped read admits Sessions under the target Account's own requirement.
    const targetAccountScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
    const scopedClientEncryptionRequirement = targetAccountScope
        ? resolveUiClientEncryptionRequirementForScope({ scope: targetAccountScope, focusedSettings: currentSettings })
        : clientEncryptionRequirement;
    if (!context.credentials) {
        throw new Error(
            `Authentication credentials are required to hydrate session ${params.sessionId}`,
        );
    }
    const request = params.authority?.request
        ?? createServerRequestForResolvedServerScope({
            context,
            activeRequest: params.activeRequest,
        });
    const accountCurrentnessSource =
        params.accountCurrentnessSource ?? (ownedAccountCurrentnessSource = createOperationAccountCurrentnessSource({
            credentials: context.credentials,
            request,
            initial: params.accountCurrentness,
            serverId: context.targetServerId,
        }));
    const readParams = {
        sessionId: params.sessionId,
        prefetched: params.prefetched,
        contentDemand: params.contentDemand,
        serverId: context.targetServerId,
        credentials: context.credentials,
        accountCurrentness: accountCurrentnessSource.peek(),
        fetchAccountCurrentness: accountCurrentnessSource.read,
        ensureAccountCurrentness: accountCurrentnessSource.ensureCurrent,
        encryption: scopedEncryption,
        sessionDataKeys: params.sessionDataKeys,
        sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
        request,
        readTransport: params.authority?.readTransport ?? context.readTransport,
        signal: params.signal,
        applySessions: params.applySessions,
        applySessionListRows: params.applySessionListRows,
        getExistingSession: params.getExistingSession,
        getCurrentSessionListRenderable: params.getCurrentSessionListRenderable,
        log: params.log,
        timeoutMs: params.timeoutMs,
        includeTurnsProjection: params.includeTurnsProjection,
        includeMetadataTupleMutationSnapshot:
            params.includeMetadataTupleMutationSnapshot === true
            || ((params.contentDemand === undefined || params.contentDemand === 'session')
                && readCredentialAuthorityKind(context.credentials.token) === 'account'),
        fresh: params.includeMetadataTupleMutationSnapshot === true,
            onSessionObservation: params.onSessionObservation,
        isCurrent: () => accountCurrentnessSource.isCurrent() && params.isCurrent?.() !== false,
        accessProjectionVersion: params.prefetched ? params.prefetched.accessProjectionVersion : readSessionDetailAccessProjectionVersion(context.targetServerId),
        clientEncryptionRequirement: scopedClientEncryptionRequirement,
    } satisfies Parameters<typeof fetchAndApplySessionById>[0];
    const result = await fetchAndApplySessionById(readParams);
    return await completeAuthorizedFullRead({
        result,
        readParams,
        awaitDisplayProjectionMaintenance: params.awaitDisplayProjectionMaintenance,
        requestedTuple: params.includeMetadataTupleMutationSnapshot === true,
        credentials: context.credentials,
        accountCurrentnessSource,
        encryption: scopedEncryption,
        sessionId: params.sessionId,
        request,
        isCurrent: params.isCurrent,
        signal: params.signal,
    });
    } finally {
        ownedAccountCurrentnessSource?.dispose();
        if (ownsContext && context.scope === 'scoped') await context.release?.();
    }
}
