import {
    sealSessionOwnerMetadataV1,
    type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { Session } from '@/sync/domains/state/storageTypes';
import { fetchAndApplySessionById, type SessionByIdEncryption } from '@/sync/engine/sessions/sessionById';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';

import type { ServerAccountSessionRequestAuthority } from './createSessionRequestWithServerScope';
import { resolveServerScopedSessionContext } from './resolveServerScopedSessionContext';

type AppliedSession = Omit<Session, 'presence'> & { presence?: 'online' | number };

export type SessionMetadataTupleWriterContext = Readonly<{
    encryptPayload: (payload: unknown) => Promise<string>;
    sealOwnerMetadata: (
        ownerMetadata: SessionOwnerMetadataV1,
    ) => string;
}>;

function getScopedSessionByIdEncryption(context: Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (keys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => unknown;
}>): SessionByIdEncryption {
    return {
        decryptEncryptionKey: (value) => context.decryptEncryptionKey(value),
        initializeSessions: (keys) => context.initializeSessions(keys),
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
    return {
        ...params.result,
        metadataTupleWriterContext: {
            encryptPayload: async (payload) =>
                params.result.session?.encryptionMode === 'plain'
                    ? JSON.stringify(payload)
                    : await sessionEncryption!.encryptRaw!(payload),
            sealOwnerMetadata: (ownerMetadata) =>
                sealSessionOwnerMetadataV1({
                    material:
                        resolveAccountScopedCryptoMaterialFromCredentials(
                            params.credentials,
                        ),
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
        if (!params.activeEncryption) {
            throw new Error(`Active session encryption is required to hydrate session ${params.sessionId}`);
        }
        const result = await fetchAndApplySessionById({
            sessionId: params.sessionId,
            serverId: params.serverId ?? null,
            credentials: params.activeCredentials,
            encryption: params.activeEncryption,
            sessionDataKeys: params.sessionDataKeys,
            sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            request: params.activeRequest,
            applySessions: params.applySessions,
            getExistingSession: params.getExistingSession,
            log: params.log,
            timeoutMs: params.timeoutMs,
            includeTurnsProjection: params.includeTurnsProjection,
            includeMetadataTupleMutationSnapshot:
                params.includeMetadataTupleMutationSnapshot,
            isCurrent: params.isCurrent,
        });
        return withMetadataTupleWriterContext({
            result,
            includeMetadataTupleMutationSnapshot:
                params.includeMetadataTupleMutationSnapshot,
            credentials: params.activeCredentials,
            encryption: params.activeEncryption,
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
    const result = await fetchAndApplySessionById({
        sessionId: params.sessionId,
        serverId: context.targetServerId,
        credentials: context.credentials,
        encryption: scopedEncryption,
        sessionDataKeys: params.sessionDataKeys,
        sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
        request: params.authority?.request ?? (async (path: string, init: RequestInit) => {
            return await runtimeFetchWithServerReachability({
                serverUrl: context.targetServerUrl,
                token: context.token,
                url: `${context.targetServerUrl}${path}`,
                init: {
                    ...init,
                    headers: {
                        ...(init.headers ?? {}),
                        Authorization: `Bearer ${context.token}`,
                    },
                },
            });
        }),
        applySessions: params.applySessions,
        getExistingSession: params.getExistingSession,
        log: params.log,
        timeoutMs: params.timeoutMs,
        includeTurnsProjection: params.includeTurnsProjection,
        includeMetadataTupleMutationSnapshot:
            params.includeMetadataTupleMutationSnapshot,
        isCurrent: params.isCurrent,
    });
    return withMetadataTupleWriterContext({
        result,
        includeMetadataTupleMutationSnapshot:
            params.includeMetadataTupleMutationSnapshot,
        credentials: context.credentials,
        encryption: scopedEncryption,
        sessionId: params.sessionId,
    });
}
