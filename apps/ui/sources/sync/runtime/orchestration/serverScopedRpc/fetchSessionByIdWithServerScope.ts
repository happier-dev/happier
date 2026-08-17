import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    sealSessionOwnerMetadataEnvelopeV1,
    type AccountEncryptionCurrentnessResponse,
    type SessionOwnerMetadataEnvelopeV1,
    type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import type {
    SessionMetadataOwnerMigrationCurrentnessV1,
} from '@happier-dev/cli-common/sessionMetadata';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { Session } from '@/sync/domains/state/storageTypes';
import { fetchAndApplySessionById, type SessionByIdEncryption } from '@/sync/engine/sessions/sessionById';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';

import {
    createSessionRequestForExplicitServerScope,
    type ServerAccountSessionRequestAuthority,
} from './createSessionRequestWithServerScope';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

export type SessionMetadataTupleWriterContext = Readonly<{
    encryptPayload: (payload: unknown) => Promise<string>;
    encodeOwnerMetadata: (
        ownerMetadata: SessionOwnerMetadataV1,
    ) => SessionOwnerMetadataEnvelopeV1;
    ownerMigrationCurrentness?:
        SessionMetadataOwnerMigrationCurrentnessV1;
}>;

function createOperationAccountCurrentnessSource(params: Readonly<{
    credentials: AuthCredentials;
    request: (path: string, init: RequestInit) => Promise<Response>;
    initial?: AccountEncryptionCurrentnessResponse;
}>) {
    let currentness = params.initial;
    let inFlight: Promise<AccountEncryptionCurrentnessResponse> | null = null;
    return {
        peek: () => currentness,
        read: async (): Promise<AccountEncryptionCurrentnessResponse> => {
            if (currentness) return currentness;
            if (!inFlight) {
                inFlight = fetchAccountEncryptionCurrentness(
                    params.credentials,
                    { request: params.request },
                );
            }
            currentness = await inFlight;
            return currentness;
        },
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
    const material = resolveAccountScopedCryptoMaterialFromCredentials(
        params.credentials,
    );
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee',
        material,
        ...(isDataKeyAuthCredentials(params.credentials)
            ? {
                dataKeyPublicKey: decodeBase64(
                    params.credentials.encryption.publicKey,
                    'base64',
                ),
            }
            : {}),
    });
    if (
        !params.accountCurrentness.contentKeyFingerprint
        || convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        )
            !== params.accountCurrentness.contentKeyFingerprint
    ) {
        throw new Error(
            'Account encryption material does not match current Account state',
        );
    }
    return snapshot;
}

function getScopedSessionByIdEncryption(context: Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (
        keys: Map<string, Uint8Array | null>,
        options?: Readonly<{ shouldContinue?: () => boolean }>,
    ) => Promise<void>;
    getSessionEncryption: (sessionId: string) => unknown;
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
        getSessionEncryption: (sessionId) => {
            const candidate = context.getSessionEncryption(sessionId);
            if (!candidate || typeof candidate !== 'object') {
                return null;
            }

            const maybeEncryption = candidate as Partial<{
                encryptRaw: (payload: unknown) => Promise<string>;
                decryptAgentState: (version: number, value: string | null) => Promise<unknown>;
                decryptMetadata: (version: number, value: string) => Promise<unknown>;
                decryptMetadataPayload: (version: number, value: string) => Promise<unknown | null>;
            }>;
            if (typeof maybeEncryption.decryptAgentState !== 'function' || typeof maybeEncryption.decryptMetadata !== 'function') {
                return null;
            }

            return {
                ...(typeof maybeEncryption.encryptRaw === 'function'
                    ? {
                        encryptRaw: (payload: unknown) =>
                            maybeEncryption.encryptRaw!(payload),
                    }
                    : {}),
                decryptAgentState: (version, value) =>
                    maybeEncryption.decryptAgentState!(version, value),
                decryptMetadata: (version, value) =>
                    maybeEncryption.decryptMetadata!(version, value),
                ...(typeof maybeEncryption.decryptMetadataPayload === 'function'
                    ? {
                        decryptMetadataPayload: (version: number, value: string) =>
                            maybeEncryption.decryptMetadataPayload!(version, value),
                    }
                    : {}),
            };
        },
    };
}

function withMetadataTupleWriterContext<T extends Awaited<
    ReturnType<typeof fetchAndApplySessionById>
>>(params: Readonly<{
    result: T;
    includeMetadataTupleMutationSnapshot?: boolean;
    credentials: AuthCredentials;
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    encryption: SessionByIdEncryption;
    sessionId: string;
}>): T & Readonly<{
    metadataTupleWriterContext?: SessionMetadataTupleWriterContext;
}> {
    if (
        params.includeMetadataTupleMutationSnapshot !== true
        || !params.result.ok
        || !params.result.metadataTupleMutationSnapshot
    ) {
        return params.result;
    }
    const mutationSnapshot =
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
    const encryptPayload = async (payload: unknown) =>
        params.result.session?.encryptionMode === 'plain'
            ? JSON.stringify(payload)
            : await sessionEncryption!.encryptRaw!(payload);
    if (mutationSnapshot.mode === 'shared_editor') {
        return {
            ...params.result,
            metadataTupleWriterContext: {
                encryptPayload,
                encodeOwnerMetadata: () => {
                    throw new Error(
                        `Shared Session metadata cannot encode owner metadata for ${params.sessionId}`,
                    );
                },
            },
        };
    }
    if (!params.accountCurrentness) {
        throw new Error(
            `Account currentness is required to mutate metadata for ${params.sessionId}`,
        );
    }
    const accountCurrentness = params.accountCurrentness;
    return {
        ...params.result,
        metadataTupleWriterContext: {
            ...(mutationSnapshot.mode === 'legacy_owner'
                ? {
                    ownerMigrationCurrentness:
                        resolveOwnerMigrationCurrentness({
                            credentials: params.credentials,
                            accountCurrentness,
                        }),
                }
                : {}),
            encryptPayload,
            encodeOwnerMetadata: (ownerMetadata) =>
                accountCurrentness.mode === 'plain'
                    ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
                    : sealSessionOwnerMetadataEnvelopeV1({
                        material:
                            resolveCurrentAccountOwnerMetadataMaterialSnapshot({
                                credentials: params.credentials,
                                accountCurrentness,
                            }).material,
                        ownerMetadata,
                        randomBytes: getRandomBytes,
                    }),
        },
    };
}

export async function fetchSessionByIdWithServerScope(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    activeCredentials: AuthCredentials;
    activeEncryption?: SessionByIdEncryption | null;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
    activeRequest: (path: string, init: RequestInit) => Promise<Response>;
    applySessions: (sessions: AppliedSession[]) => void;
    getExistingSession?: (sessionId: string) => Session | null | undefined;
    log: { log: (message: string) => void };
    timeoutMs?: number;
    includeTurnsProjection?: boolean;
    includeMetadataTupleMutationSnapshot?: boolean;
    authority?: ServerAccountSessionRequestAuthority;
    accountCurrentness?: AccountEncryptionCurrentnessResponse;
    isCurrent?: () => boolean;
}>): Promise<
    Awaited<ReturnType<typeof fetchAndApplySessionById>>
    & Readonly<{
        metadataTupleWriterContext?: SessionMetadataTupleWriterContext;
    }>
> {
    const context = params.authority?.context ?? await resolveServerScopedSessionContext({
        serverId: params.serverId ?? null,
        timeoutMs: params.timeoutMs,
    });

    if (context.scope === 'active') {
        const request = params.activeRequest;
        const accountCurrentnessSource =
            createOperationAccountCurrentnessSource({
                credentials: params.activeCredentials,
                request,
                initial: params.accountCurrentness,
            });
        const activeEncryption = getScopedSessionByIdEncryption(params.activeEncryption ?? null);
        const result = await fetchAndApplySessionById({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
            credentials: params.activeCredentials,
            accountCurrentness: accountCurrentnessSource.peek(),
            fetchAccountCurrentness: accountCurrentnessSource.read,
            encryption: activeEncryption,
            sessionDataKeys: params.sessionDataKeys,
            sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            request: params.activeRequest,
            requestAuthority: params.authority ?? request,
            applySessions: params.applySessions,
            getExistingSession: params.getExistingSession,
            log: params.log,
            timeoutMs: params.timeoutMs,
            includeTurnsProjection: params.includeTurnsProjection,
            includeMetadataTupleMutationSnapshot:
                params.includeMetadataTupleMutationSnapshot,
            isCurrent: params.isCurrent,
        });
        if (
            params.includeMetadataTupleMutationSnapshot === true
            && result.ok
            && result.metadataTupleMutationSnapshot
            && result.metadataTupleMutationSnapshot.mode !== 'shared_editor'
        ) {
            await accountCurrentnessSource.read();
        }
        return withMetadataTupleWriterContext({
            result,
            includeMetadataTupleMutationSnapshot:
                params.includeMetadataTupleMutationSnapshot,
            credentials: params.activeCredentials,
            accountCurrentness: accountCurrentnessSource.peek(),
            encryption: activeEncryption,
            sessionId: params.sessionId,
        });
    }

    const scopedEncryption =
        getScopedSessionByIdEncryption(context.encryption);
    if (!context.credentials) {
        throw new Error(
            `Authentication credentials are required to hydrate session ${params.sessionId}`,
        );
    }
    const request = params.authority?.request
        ?? createSessionRequestForExplicitServerScope({
            serverUrl: context.targetServerUrl,
            token: context.token,
        });
    const accountCurrentnessSource =
        createOperationAccountCurrentnessSource({
            credentials: context.credentials,
            request,
            initial: params.accountCurrentness,
        });
    const result = await fetchAndApplySessionById({
        sessionId: params.sessionId,
        serverId: context.targetServerId,
        credentials: context.credentials,
        accountCurrentness: accountCurrentnessSource.peek(),
        fetchAccountCurrentness: accountCurrentnessSource.read,
        encryption: scopedEncryption,
        sessionDataKeys: params.sessionDataKeys,
        sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
        request,
        requestAuthority: params.authority ?? request,
        applySessions: params.applySessions,
        getExistingSession: params.getExistingSession,
        log: params.log,
        timeoutMs: params.timeoutMs,
        includeTurnsProjection: params.includeTurnsProjection,
        includeMetadataTupleMutationSnapshot:
            params.includeMetadataTupleMutationSnapshot,
        isCurrent: params.isCurrent,
    });
    if (
        params.includeMetadataTupleMutationSnapshot === true
        && result.ok
        && result.metadataTupleMutationSnapshot
        && result.metadataTupleMutationSnapshot.mode !== 'shared_editor'
    ) {
        await accountCurrentnessSource.read();
    }
    return withMetadataTupleWriterContext({
        result,
        includeMetadataTupleMutationSnapshot:
            params.includeMetadataTupleMutationSnapshot,
        credentials: context.credentials,
        accountCurrentness: accountCurrentnessSource.peek(),
        encryption: scopedEncryption,
        sessionId: params.sessionId,
    });
}
