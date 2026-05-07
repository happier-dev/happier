import type { V2SessionByIdResponse } from '@happier-dev/protocol';

import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import {
  createNotAuthenticatedError,
  isAuthenticationResponseStatus,
  isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';
import {
  looksLikeCurrentV2SessionNotFound404,
  looksLikeMissingV2SessionRoute404,
  parseCompatSessionByIdResponse,
  scanSessionByIdFromCompatList,
} from './sessionHttpCompat';

type SessionEncryption = {
  decryptAgentState: (version: number, value: string | null) => Promise<any>;
  decryptMetadata: (version: number, value: string) => Promise<any>;
};

export type SessionByIdEncryption = {
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
  getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

type SessionDataKeyEnvelopeCache = Map<string, string>;

export async function fetchAndApplySessionById(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  credentials: AuthCredentials;
  encryption: SessionByIdEncryption;
  sessionDataKeys: Map<string, Uint8Array>;
  sessionDataKeyEnvelopes?: SessionDataKeyEnvelopeCache;
  request: (path: string, init: RequestInit) => Promise<Response>;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  log: { log: (message: string) => void };
  timeoutMs?: number;
}>): Promise<{
  ok: boolean;
  session: (V2SessionByIdResponse['session'] & { metadata: Metadata | null }) | null;
  errorCode?: string;
  httpStatus?: number;
}> {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, session: null, errorCode: 'invalid_session_id' };

  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;

  let response: Response;
  let body: unknown = null;
  try {
    response = await params.request(`/v2/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      ...(controller ? { signal: controller.signal } : null),
    });
  } catch (err) {
    if (isTerminalAuthError(err)) {
      throw err;
    }
    params.log.log(`[sessionById] Failed to fetch session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { ok: false, session: null, errorCode: 'network_error' };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (isAuthenticationResponseStatus(response.status)) {
      throw createNotAuthenticatedError();
    }
    if (response.status === 404) {
      body = await response.json().catch(() => null);
      if (looksLikeCurrentV2SessionNotFound404(body)) {
        return { ok: false, session: null, errorCode: 'not_found', httpStatus: 404 };
      }
      if (looksLikeMissingV2SessionRoute404(body, sessionId)) {
        const fallbackRow = await scanSessionByIdFromCompatList({
          request: params.request,
          token: params.credentials.token,
          sessionId,
        });
        if (!fallbackRow) {
          return { ok: false, session: null, errorCode: 'not_found', httpStatus: 404 };
        }
        body = { session: fallbackRow };
      }
    }

    if (body === null) {
      const status = response.status;
      const errorCode =
        status === 404 ? 'not_found'
          : status === 401 ? 'unauthorized'
              : status === 403 ? 'forbidden'
                  : 'http_error';
      return { ok: false, session: null, errorCode, httpStatus: status };
    }
  }

  if (body === null) {
    body = (await response.json().catch(() => null)) as unknown;
  }

  const parsed = parseCompatSessionByIdResponse(body);
  if (!parsed?.session) {
    const fallbackRow = await scanSessionByIdFromCompatList({
      request: params.request,
      token: params.credentials.token,
      sessionId,
    });
    if (!fallbackRow) {
      return { ok: false, session: null, errorCode: 'invalid_response' };
    }
    body = { session: fallbackRow };
  }

  const reparsed = parseCompatSessionByIdResponse(body);
  if (!reparsed?.session) {
    const status = response.status;
    return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: response.ok ? undefined : status };
  }

  const row = reparsed.session;
  if (String(row.id ?? '').trim() !== sessionId) {
    return { ok: false, session: null, errorCode: 'invalid_response' };
  }

  const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';

  if (encryptionMode === 'plain') {
    params.sessionDataKeys.delete(sessionId);
    params.sessionDataKeyEnvelopes?.delete(sessionId);
  } else {
    const sessionKeys = new Map<string, Uint8Array | null>();
    if (typeof row.dataEncryptionKey === 'string' && row.dataEncryptionKey.length > 0) {
      const cachedKey = params.sessionDataKeys.get(sessionId);
      const decrypted = cachedKey && params.sessionDataKeyEnvelopes?.get(sessionId) === row.dataEncryptionKey
        ? cachedKey
        : await params.encryption.decryptEncryptionKey(row.dataEncryptionKey);
      if (decrypted) {
        sessionKeys.set(sessionId, decrypted);
        params.sessionDataKeys.set(sessionId, decrypted);
        params.sessionDataKeyEnvelopes?.set(sessionId, row.dataEncryptionKey);
      } else {
        sessionKeys.set(sessionId, null);
        params.sessionDataKeys.delete(sessionId);
        params.sessionDataKeyEnvelopes?.delete(sessionId);
      }
    } else {
      sessionKeys.set(sessionId, null);
      params.sessionDataKeys.delete(sessionId);
      params.sessionDataKeyEnvelopes?.delete(sessionId);
    }

    await params.encryption.initializeSessions(sessionKeys);
  }

  const sessionEncryption = encryptionMode === 'plain' ? null : params.encryption.getSessionEncryption(sessionId);
  if (encryptionMode === 'e2ee' && !sessionEncryption) {
    params.log.log(`[sessionById] Session encryption not found for ${sessionId}`);
    return { ok: false, session: null, errorCode: 'session_encryption_not_found' };
  }

  const [metadata, agentState] = encryptionMode === 'plain'
    ? [
      parsePlainSessionMetadata(row.metadata),
      parsePlainSessionAgentState(row.agentState),
    ] as const
    : await Promise.all([
      sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata),
      sessionEncryption!.decryptAgentState(row.agentStateVersion, row.agentState),
    ]);

  const accessLevel = row.share?.accessLevel;
  const normalizedAccessLevel = accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;

  const nextSession = {
    ...row,
    serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
    encryptionMode,
    thinking: false,
    thinkingAt: 0,
    metadata,
    agentState,
    accessLevel: normalizedAccessLevel,
    canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
  };

  const previousSession = params.getExistingSession?.(sessionId);
  params.applySessions([nextSession]);
  reportNewAgentRequestsFromSessionTransition(previousSession, nextSession);

  return {
    ok: true,
    session: {
      ...row,
      serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
      metadata,
    },
  };
}
