import type { Credentials } from '@/persistence';
import type {
    SessionEncryptionContext,
    SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    resolveSessionEncryptionContextFromCredentials,
    resolveSessionStoredContentEncryptionMode,
    tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { type ResolveSessionIdResult, resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { delay } from '@/utils/time';

export type ResolveSessionTransportContextResult =
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          ctx: SessionEncryptionContext;
          mode: SessionStoredContentEncryptionMode;
      }
    | {
          ok: false;
          code: Extract<ResolveSessionIdResult, { ok: false }>['code'];
          candidates?: string[];
          sessionId?: string;
      };

const DEFAULT_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS = 3;
const DEFAULT_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS = 100;

function resolvePositiveIntFromEnv(key: string, fallback: number): number {
    const raw = String(process.env[key] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function shouldRetryForPublishedSessionDataEncryptionKey(params: Readonly<{
    credentials: Credentials;
    rawSession: RawSessionRecord;
}>): boolean {
    if (params.credentials.encryption.type !== 'dataKey') {
        return false;
    }

    if (resolveSessionStoredContentEncryptionMode(params.rawSession) !== 'e2ee') {
        return false;
    }

    const publishedDataEncryptionKey =
        typeof params.rawSession.dataEncryptionKey === 'string'
            ? params.rawSession.dataEncryptionKey.trim()
            : '';
    if (publishedDataEncryptionKey.length > 0) {
        return false;
    }

    const encryptedMetadata =
        typeof params.rawSession.metadata === 'string'
            ? params.rawSession.metadata.trim()
            : '';
    if (encryptedMetadata.length === 0) {
        return false;
    }

    return tryDecryptSessionMetadata({
        credentials: params.credentials,
        rawSession: params.rawSession,
    }) === null;
}

async function fetchSessionTransportRecord(params: Readonly<{
    credentials: Credentials;
    sessionId: string;
}>): Promise<RawSessionRecord | null> {
    let rawSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: params.sessionId,
    });
    if (!rawSession) {
        return null;
    }

    const retryAttempts = resolvePositiveIntFromEnv(
        'HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS',
        DEFAULT_SESSION_E2EE_DEK_FETCH_RETRY_ATTEMPTS,
    );
    const retryDelayMs = resolvePositiveIntFromEnv(
        'HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS',
        DEFAULT_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS,
    );

    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
        if (!shouldRetryForPublishedSessionDataEncryptionKey({ credentials: params.credentials, rawSession })) {
            return rawSession;
        }

        await delay(Math.max(1, retryDelayMs));
        const refreshedSession = await fetchSessionById({
            token: params.credentials.token,
            sessionId: params.sessionId,
        });
        if (!refreshedSession) {
            return rawSession;
        }
        rawSession = refreshedSession;
    }

    return rawSession;
}

export async function resolveSessionTransportContext(params: Readonly<{
    credentials: Credentials;
    idOrPrefix: string;
}>): Promise<ResolveSessionTransportContextResult> {
    const resolved = await resolveSessionIdOrPrefix({
        credentials: params.credentials,
        idOrPrefix: params.idOrPrefix,
    });
    if (!resolved.ok) {
        return {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
    }

    const rawSession = await fetchSessionTransportRecord({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
    });
    if (!rawSession) {
        return {
            ok: false,
            code: 'session_not_found',
            sessionId: resolved.sessionId,
        };
    }

    return {
        ok: true,
        sessionId: resolved.sessionId,
        rawSession,
        ctx: resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession),
        mode: resolveSessionStoredContentEncryptionMode(rawSession),
    };
}
