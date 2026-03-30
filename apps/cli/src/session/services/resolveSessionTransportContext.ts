import type { Credentials } from '@/persistence';
import type {
    SessionEncryptionContext,
    SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    resolveSessionEncryptionContextFromCredentials,
    resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { type ResolveSessionIdResult, resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';

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

    const rawSession = await fetchSessionById({
        token: params.credentials.token,
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
