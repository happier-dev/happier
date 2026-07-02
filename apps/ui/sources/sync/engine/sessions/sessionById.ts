import {
  SessionTurnsProjectionV1Schema,
  type SessionTurnsProjectionV1,
  type V2SessionByIdResponse,
} from '@happier-dev/protocol';

import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
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
type SessionByIdRequest = (path: string, init: RequestInit) => Promise<Response>;
type SessionByIdHttpRead = Readonly<{
  ok: boolean;
  status: number;
  body: unknown;
}>;

const sessionByIdHttpReadsByRequest = new WeakMap<SessionByIdRequest, Map<string, Promise<SessionByIdHttpRead>>>();
const scopedSessionByIdHttpReads = new Map<string, Promise<SessionByIdHttpRead>>();

function buildSessionByIdHttpReadKey(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
}>): string {
  return [
    String(params.serverId ?? '').trim(),
    params.token,
    params.sessionId,
  ].join('\u0000');
}

async function readSessionByIdHttp(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
  request: SessionByIdRequest;
  timeoutMs: number;
}>): Promise<SessionByIdHttpRead> {
  const key = buildSessionByIdHttpReadKey(params);
  const scopedServerId = String(params.serverId ?? '').trim();
  let readsForRequest: Map<string, Promise<SessionByIdHttpRead>>;
  if (scopedServerId) {
    readsForRequest = scopedSessionByIdHttpReads;
  } else {
    const existingReadsForRequest = sessionByIdHttpReadsByRequest.get(params.request);
    if (existingReadsForRequest) {
      readsForRequest = existingReadsForRequest;
    } else {
      readsForRequest = new Map<string, Promise<SessionByIdHttpRead>>();
      sessionByIdHttpReadsByRequest.set(params.request, readsForRequest);
    }
  }

  const existing = readsForRequest.get(key);
  if (existing) {
    syncPerformanceTelemetry.count('sync.sessionById.http.coalesced', { hit: 1 });
    return await existing;
  }

  const promise = (async () => {
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;
    try {
      const response = await params.request(`/v2/sessions/${encodeURIComponent(params.sessionId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        ...(controller ? { signal: controller.signal } : null),
      });
      const body = await response.json().catch(() => null);
      syncPerformanceTelemetry.count('sync.sessionById.http.coalesced', { miss: 1 });
      return {
        ok: response.ok,
        status: response.status,
        body,
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  readsForRequest.set(key, promise);
  try {
    return await promise;
  } finally {
    if (readsForRequest.get(key) === promise) {
      readsForRequest.delete(key);
    }
  }
}

function listRollbackEligibleTurnStarts(projection: SessionTurnsProjectionV1): number[] {
  const starts: number[] = [];
  for (const turn of projection.turns) {
    if (turn.status !== 'completed') continue;
    if (turn.rollback?.state !== 'eligible') continue;
    const seq = turn.transcriptAnchors?.startUserMessageSeq;
    if (typeof seq !== 'number' || starts.includes(seq)) continue;
    starts.push(seq);
  }
  return starts;
}

async function fetchSessionTurnsProjection(params: Readonly<{
  sessionId: string;
  credentials: AuthCredentials;
  request: (path: string, init: RequestInit) => Promise<Response>;
  log: { log: (message: string) => void };
}>): Promise<SessionTurnsProjectionV1 | null> {
  let response: Response;
  try {
    response = await params.request(`/v1/sessions/${encodeURIComponent(params.sessionId)}/turns`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    if (isTerminalAuthError(err)) {
      throw err;
    }
    params.log.log(`[sessionById] Failed to fetch session turns ${params.sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return null;
  }

  if (!response.ok) {
    if (isAuthenticationResponseStatus(response.status)) {
      throw createNotAuthenticatedError(response.status);
    }
    return null;
  }

  const body = await response.json().catch(() => null);
  const parsed = SessionTurnsProjectionV1Schema.safeParse(body);
  if (!parsed.success || parsed.data.sessionId !== params.sessionId) {
    params.log.log(`[sessionById] Ignoring invalid session turns projection for ${params.sessionId}`);
    return null;
  }
  return parsed.data;
}

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
  includeTurnsProjection?: boolean;
}>): Promise<{
  ok: boolean;
  session: (V2SessionByIdResponse['session'] & { metadata: Metadata | null }) | null;
  errorCode?: string;
  httpStatus?: number;
}> {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, session: null, errorCode: 'invalid_session_id' };

  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  let responseOk = false;
  let responseStatus = 0;
  let body: unknown = null;
  try {
    const response = await readSessionByIdHttp({
      sessionId,
      serverId: params.serverId,
      token: params.credentials.token,
      request: params.request,
      timeoutMs,
    });
    responseOk = response.ok;
    responseStatus = response.status;
    body = response.body;
  } catch (err) {
    if (isTerminalAuthError(err)) {
      throw err;
    }
    params.log.log(`[sessionById] Failed to fetch session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { ok: false, session: null, errorCode: 'network_error' };
  }

  if (!responseOk) {
    if (isAuthenticationResponseStatus(responseStatus)) {
      throw createNotAuthenticatedError(responseStatus);
    }
    if (responseStatus === 404) {
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
      const status = responseStatus;
      const errorCode =
        status === 404 ? 'not_found'
          : status === 401 ? 'unauthorized'
              : status === 403 ? 'forbidden'
                  : 'http_error';
      return { ok: false, session: null, errorCode, httpStatus: status };
    }
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
    const status = responseStatus;
    return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: responseOk ? undefined : status };
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
  const sessionTurns = params.includeTurnsProjection === false
    ? null
    : await fetchSessionTurnsProjection({
      sessionId,
      credentials: params.credentials,
      request: params.request,
      log: params.log,
    });
  const rollbackEligibleTurnStarts = sessionTurns
    ? listRollbackEligibleTurnStarts(sessionTurns)
    : undefined;

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
    ...(sessionTurns
      ? {
        sessionTurns,
        rollbackEligibleTurnStarts,
      }
      : {}),
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
      ...(sessionTurns
        ? {
          sessionTurns,
          rollbackEligibleTurnStarts,
        }
        : {}),
    },
  };
}
