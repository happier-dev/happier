import type { StoredCredentials } from '@/persistence';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
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
import { delay, delayUnrefAbortable } from '@/utils/time';

export type ResolveSessionTransportContextResult =
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: null;
          mode: 'plain';
      }
    | {
          ok: true;
          sessionId: string;
          rawSession: RawSessionRecord;
          accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
          ctx: SessionEncryptionContext;
          mode: 'e2ee';
      }
    | {
          ok: false;
          code:
              | Extract<ResolveSessionIdResult, { ok: false }>['code']
              | 'encryption_material_unavailable';
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
    credentials: StoredCredentials;
    rawSession: RawSessionRecord;
}>): boolean {
    if (params.credentials.encryption?.type !== 'dataKey') {
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
    credentials: StoredCredentials;
    sessionId: string;
    signal?: AbortSignal;
}>): Promise<RawSessionRecord | null> {
    params.signal?.throwIfAborted();
    let rawSession = await fetchSessionById({
        token: params.credentials.token,
        sessionId: params.sessionId,
        ...(params.signal ? { signal: params.signal } : {}),
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
        params.signal?.throwIfAborted();
        if (!shouldRetryForPublishedSessionDataEncryptionKey({ credentials: params.credentials, rawSession })) {
            return rawSession;
        }

        const delayMs = Math.max(1, retryDelayMs);
        if (params.signal) {
            await delayUnrefAbortable(delayMs, params.signal);
            params.signal.throwIfAborted();
        } else {
            await delay(delayMs);
        }
        const refreshedSession = await fetchSessionById({
            token: params.credentials.token,
            sessionId: params.sessionId,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (!refreshedSession) {
            return rawSession;
        }
        rawSession = refreshedSession;
    }

    return rawSession;
}

export async function resolveSessionTransportContext(params: Readonly<{
    credentials: StoredCredentials;
    idOrPrefix: string;
    signal?: AbortSignal;
}>): Promise<ResolveSessionTransportContextResult> {
    params.signal?.throwIfAborted();
    const resolved = await resolveSessionIdOrPrefix({
        credentials: params.credentials,
        idOrPrefix: params.idOrPrefix,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!resolved.ok) {
        return {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
    }

    const rawSessionPromise = resolved.rawSession && !shouldRetryForPublishedSessionDataEncryptionKey({
        credentials: params.credentials,
        rawSession: resolved.rawSession,
    })
        ? Promise.resolve(resolved.rawSession)
        : fetchSessionTransportRecord({
            credentials: params.credentials,
            sessionId: resolved.sessionId,
            ...(params.signal ? { signal: params.signal } : {}),
        });
    const [rawSession, accountEncryptionCurrentness] = await Promise.all([
        rawSessionPromise,
        fetchAccountEncryptionCurrentness({
            token: params.credentials.token,
            ...(params.signal ? { signal: params.signal } : {}),
        }),
    ]);
    params.signal?.throwIfAborted();
    if (!rawSession) {
        return {
            ok: false,
            code: 'session_not_found',
            sessionId: resolved.sessionId,
        };
    }

    const mode = resolveSessionStoredContentEncryptionMode(rawSession);
    if (mode === 'plain') {
        return {
            ok: true,
            sessionId: resolved.sessionId,
            rawSession,
            accountEncryptionCurrentness,
            ctx: null,
            mode,
        };
    }
    const ctx = resolveSessionEncryptionContextFromCredentials(
        params.credentials,
        rawSession,
    );
    if (!ctx) {
        return {
            ok: false,
            code: 'encryption_material_unavailable',
            sessionId: resolved.sessionId,
        };
    }

    return {
        ok: true,
        sessionId: resolved.sessionId,
        rawSession,
        accountEncryptionCurrentness,
        ctx,
        mode,
    };
}
