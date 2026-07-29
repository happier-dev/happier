import {
  openSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
  SessionSharedMetadataV1Schema,
  SessionTurnsProjectionV1Schema,
  type SessionTurnsProjectionV1,
  type V2SessionByIdResponse,
} from '@happier-dev/protocol';
import type {
  SessionMetadataTupleMutationSnapshotV1,
} from '@happier-dev/cli-common/sessionMetadata';

import type {
  AgentState,
  Metadata,
  Session,
} from '@/sync/domains/state/storageTypes';
import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import {
  createNotAuthenticatedError,
  isAuthenticationResponseStatus,
  isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';

import {
  parseDecryptedSessionMetadata,
  parsePlainSessionAgentState,
  parsePlainSessionMetadata,
  readSessionMetadataLayoutVersion,
  tryParsePlainSessionAgentState,
} from './parsePlainSessionPayload';
import {
  classifySessionTupleApplyCurrentness,
} from '@/sync/store/domains/sessionTupleApplyCurrentness';
import {
  looksLikeCurrentV2SessionNotFound404,
  looksLikeMissingV2SessionRoute404,
  parseCompatSessionByIdResponse,
  scanSessionByIdFromCompatList,
} from './sessionHttpCompat';

type SessionEncryption = {
  encryptRaw?: (payload: unknown) => Promise<string>;
  decryptAgentState: (version: number, value: string | null) => Promise<any>;
  decryptMetadata: (version: number, value: string) => Promise<any>;
  decryptMetadataPayload?: (version: number, value: string) => Promise<unknown | null>;
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
type HydratedSessionById = Omit<
  V2SessionByIdResponse['session'],
  'metadata' | 'ownerMetadata'
> & {
  metadata: Session['metadata'];
  ownerMetadataView?: Session['ownerMetadataView'];
};
export type HydratedSessionMetadataTupleMutationSnapshot =
  SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState>;

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
  includeMetadataTupleMutationSnapshot?: boolean;
  isCurrent?: () => boolean;
}>): Promise<{
  ok: boolean;
  session: HydratedSessionById | null;
  metadataTupleMutationSnapshot?:
    | HydratedSessionMetadataTupleMutationSnapshot
    | null;
  errorCode?: string;
  httpStatus?: number;
}> {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, session: null, errorCode: 'invalid_session_id' };
  const isCurrent = () => params.isCurrent?.() !== false;
  const staleResult = () => ({
    ok: false as const,
    session: null,
    errorCode: 'stale_response',
    ...(params.includeMetadataTupleMutationSnapshot === true
      ? { metadataTupleMutationSnapshot: null }
      : {}),
  });

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
  if (!isCurrent()) return staleResult();

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
    if (!isCurrent()) return staleResult();
    params.sessionDataKeys.delete(sessionId);
    params.sessionDataKeyEnvelopes?.delete(sessionId);
  } else {
    const sessionKeys = new Map<string, Uint8Array | null>();
    if (typeof row.dataEncryptionKey === 'string' && row.dataEncryptionKey.length > 0) {
      const cachedKey = params.sessionDataKeys.get(sessionId);
      const decrypted = cachedKey && params.sessionDataKeyEnvelopes?.get(sessionId) === row.dataEncryptionKey
        ? cachedKey
        : await params.encryption.decryptEncryptionKey(row.dataEncryptionKey);
      if (!isCurrent()) return staleResult();
      if (decrypted) {
        sessionKeys.set(sessionId, decrypted);
      } else {
        sessionKeys.set(sessionId, null);
      }
    } else {
      sessionKeys.set(sessionId, null);
    }

    await params.encryption.initializeSessions(sessionKeys);
    if (!isCurrent()) return staleResult();
    const decrypted = sessionKeys.get(sessionId) ?? null;
    if (decrypted) {
      params.sessionDataKeys.set(sessionId, decrypted);
      params.sessionDataKeyEnvelopes?.set(sessionId, row.dataEncryptionKey!);
    } else {
      params.sessionDataKeys.delete(sessionId);
      params.sessionDataKeyEnvelopes?.delete(sessionId);
    }
  }

  const sessionEncryption = encryptionMode === 'plain' ? null : params.encryption.getSessionEncryption(sessionId);
  if (encryptionMode === 'e2ee' && !sessionEncryption) {
    params.log.log(`[sessionById] Session encryption not found for ${sessionId}`);
    return { ok: false, session: null, errorCode: 'session_encryption_not_found' };
  }

  const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
  const hasFullAgentStateProjection = metadataLayoutVersion === 0
    || (
      typeof row.ownerMetadata === 'string'
      && typeof row.agentStateVersion === 'number'
      && Object.prototype.hasOwnProperty.call(row, 'agentState')
    );
  const agentStateVersion = row.agentStateVersion ?? 0;
  const [decryptedMetadata, agentState] = encryptionMode === 'plain'
    ? [
      parsePlainSessionMetadata(row.metadata, row.metadataLayoutVersion),
      hasFullAgentStateProjection
        ? parsePlainSessionAgentState(row.agentState ?? null)
        : null,
    ] as const
    : await Promise.all([
      metadataLayoutVersion === 1
        ? sessionEncryption!.decryptMetadataPayload?.(row.metadataVersion, row.metadata)
          ?? Promise.resolve(null)
        : sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata),
      hasFullAgentStateProjection
        ? sessionEncryption!.decryptAgentState(
          agentStateVersion,
          row.agentState ?? null,
        )
        : Promise.resolve(null),
    ]);
  if (!isCurrent()) return staleResult();
  const metadata = encryptionMode === 'plain'
    ? decryptedMetadata
    : parseDecryptedSessionMetadata(decryptedMetadata, row.metadataLayoutVersion);
  const strictSharedMetadata = metadataLayoutVersion === 1
    ? SessionSharedMetadataV1Schema.safeParse(decryptedMetadata)
    : null;
  const layout1SharedMetadata = strictSharedMetadata?.success
    ? strictSharedMetadata.data
    : null;
  if (
    metadataLayoutVersion === 1
    && (metadata === null || !layout1SharedMetadata)
  ) {
    params.log.log(`[sessionById] Shared metadata unavailable for ${sessionId}`);
    return { ok: false, session: null, errorCode: 'metadata_unavailable' };
  }
  const ownerMetadata = row.metadataLayoutVersion === 1
    && typeof row.ownerMetadata === 'string'
    ? openSessionOwnerMetadataV1({
      material: resolveAccountScopedCryptoMaterialFromCredentials(params.credentials),
      ciphertext: row.ownerMetadata,
    })
    : null;
  const projectedOwnerMetadataView = metadataLayoutVersion === 1
    && layout1SharedMetadata
    && ownerMetadata
      ? MetadataSchema.safeParse(
          projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: layout1SharedMetadata,
            ownerMetadata,
          }),
        )
      : null;
  const ownerMetadataView = metadataLayoutVersion === 0
    ? metadata
    : projectedOwnerMetadataView?.success
      ? projectedOwnerMetadataView.data
      : null;

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
  if (!isCurrent()) return staleResult();
  const rollbackEligibleTurnStarts = sessionTurns
    ? listRollbackEligibleTurnStarts(sessionTurns)
    : undefined;
  const metadataTupleMutationSnapshot:
    | HydratedSessionMetadataTupleMutationSnapshot
    | null = params.includeMetadataTupleMutationSnapshot !== true
      || !metadata
      ? null
      : metadataLayoutVersion === 0
        ? (() => {
          const metadataVersion =
            Number.isSafeInteger(row.metadataVersion)
            && row.metadataVersion >= 0
            && row.metadataVersion < Number.MAX_SAFE_INTEGER
              ? row.metadataVersion
              : null;
          const exactAgentStateVersion =
            Number.isSafeInteger(row.agentStateVersion)
            && (row.agentStateVersion ?? -1) >= 0
            && (row.agentStateVersion ?? Number.MAX_SAFE_INTEGER)
                < Number.MAX_SAFE_INTEGER
              ? row.agentStateVersion!
              : null;
          const agentStateCiphertext =
            row.agentState === null
              ? null
              : typeof row.agentState === 'string'
                && row.agentState.length > 0
                ? row.agentState
                : undefined;
          const migrationAgentState = row.agentState === null
            ? null
            : encryptionMode === 'plain'
              && typeof row.agentState === 'string'
              ? tryParsePlainSessionAgentState(row.agentState)
              : agentState;
          if (
            metadataVersion === null
            || exactAgentStateVersion === null
            || typeof row.metadata !== 'string'
            || row.metadata.length === 0
            || agentStateCiphertext === undefined
            || (
              row.ownerMetadata !== null
              && row.ownerMetadata !== undefined
            )
            || migrationAgentState === undefined
            || (
              agentStateCiphertext !== null
              && migrationAgentState === null
            )
          ) {
            return null;
          }
          return {
            mode: 'legacy_owner' as const,
            metadataLayoutVersion: 0 as const,
            metadataVersion,
            metadataCiphertext: row.metadata,
            ownerMetadata: null,
            agentStateVersion: exactAgentStateVersion,
            agentStateCiphertext,
            value: {
              metadata,
              agentState: migrationAgentState,
            },
          };
        })()
        : metadataLayoutVersion === 1
          ? (
        typeof row.ownerMetadata === 'string'
        && ownerMetadata
        && ownerMetadataView
        && typeof row.agentStateVersion === 'number'
        && Object.prototype.hasOwnProperty.call(row, 'agentState')
          ? {
            mode: 'owner',
            metadataLayoutVersion: 1,
            metadataVersion: row.metadataVersion,
            sharedMetadataCiphertext: row.metadata,
            ownerMetadataCiphertext: row.ownerMetadata,
            agentStateVersion: row.agentStateVersion,
            agentStateCiphertext: row.agentState ?? null,
            value: {
              metadata: ownerMetadataView,
              sharedMetadata: layout1SharedMetadata!,
              ownerMetadata,
              agentState,
            },
          }
          : normalizedAccessLevel
            ? {
              mode: 'shared_editor',
              metadataLayoutVersion: 1,
              metadataVersion: row.metadataVersion,
              sharedMetadataCiphertext: row.metadata,
              value: {
                metadata,
                sharedMetadata: layout1SharedMetadata!,
                ownerMetadata: null,
                agentState: null,
              },
            }
            : null
          )
          : null;
  const {
    ownerMetadata: _ownerMetadataCiphertext,
    ...rowWithoutOwnerMetadata
  } = row;

  const nextSession = {
    ...rowWithoutOwnerMetadata,
    serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
    encryptionMode,
    thinking: false,
    thinkingAt: 0,
    metadata,
    ownerMetadataView,
    agentState,
    agentStateVersion,
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
  if (
    !classifySessionTupleApplyCurrentness(
      previousSession,
      nextSession,
    ).fullyCurrent
  ) {
    return staleResult();
  }
  if (!isCurrent()) return staleResult();
  params.applySessions([nextSession]);
  reportNewAgentRequestsFromSessionTransition(previousSession, nextSession);

  return {
    ok: true,
    session: {
      ...rowWithoutOwnerMetadata,
      serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
      metadata,
      ownerMetadataView,
      agentState,
      agentStateVersion,
      ...(sessionTurns
        ? {
          sessionTurns,
          rollbackEligibleTurnStarts,
        }
        : {}),
    },
    ...(params.includeMetadataTupleMutationSnapshot === true
      ? { metadataTupleMutationSnapshot }
      : {}),
  };
}
