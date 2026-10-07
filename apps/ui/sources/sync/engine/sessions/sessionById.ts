import { isSessionAccessOwner, normalizeSessionAccessProjection } from './normalizeSessionAccessProjection';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionTurnsProjectionV1Schema, type SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { isSessionEncryptionModeAllowedByClientRequirement, type ClientEncryptionRequirement } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import type {
  SessionMetadataTupleMutationSnapshotV1,
} from '@happier-dev/cli-common/sessionMetadata';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { AgentState, Metadata } from '@happier-dev/session-core/state';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import {
  createNotAuthenticatedError,
  isAuthenticationResponseStatus,
  isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

import {
  parseDecryptedSessionMetadata,
  parsePlainSessionAgentState,
  parsePlainSessionMetadata,
  readSessionMetadataLayoutVersion,
  tryParsePlainSessionAgentState,
} from './parsePlainSessionPayload';
import { classifySessionTupleApplyCurrentness } from '@/sync/store/domains/sessionTupleApplyCurrentness';
import {
  hasExplicitCurrentOrResponsibilitySessionProjection,
  looksLikeCurrentV2SessionNotFound404,
  looksLikeMissingV2SessionRoute404,
  parseCompatSessionByIdResponse,
  scanSessionByIdFromCompatList,
} from './sessionHttpCompat';
import {
  buildSessionOwnerMetadataUnavailableShell,
  projectSessionLayout1LockedOwnerVisibility,
  projectSessionLayout1OwnerMetadata,
  readSessionLayout1OwnerMetadata,
} from './readSessionLayout1OwnerProjection';
import {
  createSessionDataKeyHydrationPlan,
  hydrateSessionDataKeys,
  readSessionDataKeyCredentialKind,
  type SessionDataKeyViewerRole,
  type SessionDataKeyHydrationResult,
} from '@/sync/encryption/sessionDataKeyHydration';
import type {
  EncryptionGenerationScope,
  EncryptionGenerationScopeAuthority,
} from '@/sync/encryption/encryption';
import {
  deriveSessionContentAvailability,
  isSessionContentReadable,
  type SessionContentAvailability,
} from '@/sync/domains/session/encryptedContentAvailability';
import {
  AccountEncryptionCurrentnessReadinessError,
  fetchAccountEncryptionCurrentness,
} from '@/sync/api/account/apiAccountEncryptionMode';

type SessionEncryption = {
  encryptRaw?: (payload: unknown) => Promise<string>;
  decryptAgentState: (version: number, value: string | null) => Promise<any>;
  decryptMetadata: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<any>;
  decryptMetadataPayload?: (version: number, value: string, options?: import('@/sync/encryption/encryptor').DecryptOptions) => Promise<unknown | null>;
};

export type SessionByIdEncryption = {
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  initializeSessions: (
    sessionKeys: Map<string, Uint8Array | null>,
    options?: import('@/sync/encryption/encryption').EncryptionScopeInput,
  ) => Promise<EncryptionGenerationScope | null | void>;
  getSessionEncryption: (sessionId: string) => SessionEncryption | null;
  removeSessionEncryption?: (sessionId: string) => EncryptionGenerationScope | null | void;
} & Partial<EncryptionGenerationScopeAuthority>;

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
  metadataProjection?: Session['metadataProjection'];
  ownerMetadataView?: Session['ownerMetadataView'];
  composerOptionsInput?: Session['composerOptionsInput'];
};

export type HydratedSessionMetadataTupleMutationSnapshot =
  SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState>;

const sessionByIdHttpReadsByAuthority = new WeakMap<object, Map<string, Promise<SessionByIdHttpRead>>>();

function buildSessionByIdHttpReadKey(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
  accessProjectionVersion?: 1;
}>): string {
  return JSON.stringify([
    String(params.serverId ?? '').trim(),
    params.token,
    params.sessionId,
    params.accessProjectionVersion ?? null,
  ]);
}

async function readSessionByIdHttp(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  token: string;
  request: SessionByIdRequest;
  requestAuthority?: object;
  timeoutMs: number;
  accessProjectionVersion?: 1;
}>): Promise<SessionByIdHttpRead> {
  const key = buildSessionByIdHttpReadKey(params);
  const requestAuthority = params.requestAuthority ?? params.request;
  const existingReadsForAuthority = sessionByIdHttpReadsByAuthority.get(
    requestAuthority,
  );
  let readsForRequest: Map<string, Promise<SessionByIdHttpRead>>;
  if (existingReadsForAuthority) {
    readsForRequest = existingReadsForAuthority;
  } else {
    readsForRequest = new Map<string, Promise<SessionByIdHttpRead>>();
    sessionByIdHttpReadsByAuthority.set(requestAuthority, readsForRequest);
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
      const response = await params.request(
        `/v2/sessions/${encodeURIComponent(params.sessionId)}${params.accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
          },
          ...(controller ? { signal: controller.signal } : null),
        },
      );
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

function isStoredSessionInResponseScope(previous: Session | null | undefined, incoming: Pick<Session, 'serverId' | 'encryptionMode'>): boolean {
  if (!previous) return true;
  const previousServerId = previous.serverId ?? null;
  const incomingServerId = incoming.serverId ?? null;
  return previous.encryptionMode === incoming.encryptionMode
    && (previousServerId === incomingServerId
      || (previousServerId !== null && incomingServerId !== null
        && areServerProfileIdentifiersEquivalent(previousServerId, incomingServerId)));
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

/**
 * A Session the viewer is authorized to see but cannot decrypt is still a real Session. Applying a
 * safe shell keeps the row and its Collaboration access reachable with a truthful settled state,
 * instead of retiring it behind a retryable-looking `session_encryption_not_found`.
 *
 * Metadata, owner projection and agent state stay null so no component can render undecrypted
 * bytes. This content state does not establish whether the Session belongs in a visible list;
 * that remains a separate visibility decision.
 */
function applyLockedSessionShell(params: Readonly<{
  row: V2SessionByIdResponse['session'];
  sessionId: string;
  serverId?: string | null;
  encryptionMode: 'e2ee' | 'plain';
  contentAvailability: SessionContentAvailability;
  sessionDataKeyHydration: SessionDataKeyHydrationResult;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  includeMetadataTupleMutationSnapshot: boolean;
  ownerMetadataView?: Session['ownerMetadataView'];
  // The owner's metadata could not be opened: install the same locked shell the
  // list path installs (one executor for this outcome, see cp-c2).
  ownerMetadataUnavailable?: boolean;
}>): {
  ok: boolean;
  session: HydratedSessionById | Session | null;
  sessionDataKeyHydration?: SessionDataKeyHydrationResult;
  metadataTupleMutationSnapshot?: HydratedSessionMetadataTupleMutationSnapshot | null;
  errorCode?: string;
} {
  const {
    ownerMetadata: _ownerMetadataEnvelope,
    ...rowWithoutOwnerMetadata
  } = params.row;
  const serverId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
    ? params.serverId.trim()
    : undefined;
  const access = normalizeSessionAccessProjection(params.row, { allowLegacy: true });
  const lockedSession = {
    ...rowWithoutOwnerMetadata,
    serverId,
    encryptionMode: params.encryptionMode,
    thinking: false,
    thinkingAt: 0,
    metadata: null,
    ownerMetadataView: params.ownerMetadataView ?? null,
    composerOptionsInput: null,
    agentState: null,
    agentStateVersion: params.row.agentStateVersion ?? 0,
    access,
    accessLevel: access?.level === 'owner' ? undefined : access?.level,
    canApprovePermissions: access?.capabilities.approveRuntimePermissions,
    encryptedContentAvailability: params.contentAvailability,
  };
  const previousSession = params.getExistingSession?.(params.sessionId);
  if (!isStoredSessionInResponseScope(previousSession, lockedSession)) {
    return { ok: false, session: null, errorCode: 'stale_response' };
  }
  const sessionToApply = params.ownerMetadataUnavailable
    ? buildSessionOwnerMetadataUnavailableShell(lockedSession)
    : lockedSession;
  params.applySessions([sessionToApply as unknown as Omit<Session, 'presence'> & { presence?: 'online' | number }]);
  return {
    ok: true,
    session: (params.getExistingSession?.(params.sessionId) ?? sessionToApply) as HydratedSessionById,
    sessionDataKeyHydration: params.sessionDataKeyHydration,
    ...(params.includeMetadataTupleMutationSnapshot ? { metadataTupleMutationSnapshot: null } : {}),
  };
}

export async function fetchAndApplySessionById(params: Readonly<{
  sessionId: string;
  serverId?: string | null;
  credentials: AuthCredentials;
  /** Explicit bridge envelope: presence binds this read to a Session recipient. */
  sessionKey?: string | null;
  accountCurrentness?: AccountEncryptionCurrentnessResponse;
  accountMode?: AccountEncryptionCurrentnessResponse['mode'];
  composerOptionsInput?: import('@happier-dev/protocol/embed').ComposerOptionsInputV1 | null;
  fetchAccountCurrentness?: () => Promise<AccountEncryptionCurrentnessResponse>;
  encryption: SessionByIdEncryption;
  sessionDataKeys: Map<string, Uint8Array>;
  sessionDataKeyEnvelopes?: SessionDataKeyEnvelopeCache;
  request: (path: string, init: RequestInit) => Promise<Response>;
  requestAuthority?: object;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  log: { log: (message: string) => void };
  timeoutMs?: number;
  includeTurnsProjection?: boolean;
  includeMetadataTupleMutationSnapshot?: boolean;
  isCurrent?: () => boolean;
  accessProjectionVersion?: 1;
  clientEncryptionRequirement?: ClientEncryptionRequirement;
}>): Promise<{
  ok: boolean;
  session: HydratedSessionById | Session | null;
  sessionDataKeyHydration?: SessionDataKeyHydrationResult;
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
      requestAuthority: params.requestAuthority,
      timeoutMs,
      accessProjectionVersion: params.accessProjectionVersion,
    });
    responseOk = response.ok;
    responseStatus = response.status;
    body = response.body;
  } catch (err) {
    if (isTerminalAuthError(err)) {
      throw err;
    }
    params.log.log(`[sessionById] Failed to fetch session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { ok: false, session: null, errorCode: isTransientConnectivityError(err) ? 'network_error' : 'request_failed' };
  }
  if (!isCurrent()) return staleResult();

  if (!responseOk) {
    // An explicit frame envelope denotes a restricted Session credential, not
    // an Account login. A denied Session must not trigger Account auth recovery.
    if (params.sessionKey !== undefined && responseStatus === 403) {
      return { ok: false, session: null, errorCode: 'forbidden', httpStatus: 403 };
    }
    if (isAuthenticationResponseStatus(responseStatus)) {
      throw createNotAuthenticatedError(responseStatus);
    }
    if (responseStatus === 404) {
      if (looksLikeCurrentV2SessionNotFound404(body)) {
        return { ok: false, session: null, errorCode: 'not_found', httpStatus: 404 };
      }
      if (looksLikeMissingV2SessionRoute404(body, sessionId)) {
        if (params.accessProjectionVersion === 1 || params.sessionKey !== undefined) {
          return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: 404 };
        }
        const fallbackRow = await scanSessionByIdFromCompatList({
          request: params.request,
          token: params.credentials.token,
          sessionId,
        });
        if (!fallbackRow) {
          // A legacy route fallback cannot prove absence from the current
          // single-session contract. Keep the existing local carrier until
          // current-route evidence arrives.
          return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: 404 };
        }
        body = { session: fallbackRow };
      }
    }

    if (body === null) {
      const status = responseStatus;
      const errorCode =
        // Only the current v2 body above is authoritative absence evidence.
        // Empty, plain-text, or otherwise unparseable 404s can be a route or
        // version mismatch and must not retire local state.
        status === 404 ? 'invalid_response'
          : status === 401 ? 'unauthorized'
              : status === 403 ? 'forbidden'
                  : 'http_error';
      return { ok: false, session: null, errorCode, httpStatus: status };
    }
  }

  const parsed = parseCompatSessionByIdResponse(body);
  if (!parsed?.session) {
    if (params.sessionKey !== undefined) return { ok: false, session: null, errorCode: 'invalid_response' };
    if (hasExplicitCurrentOrResponsibilitySessionProjection(body)) {
      return { ok: false, session: null, errorCode: 'invalid_response' };
    }
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

  const currentProjection = params.accessProjectionVersion === 1
    ? SessionCurrentProjectionRecordV1Schema.safeParse(reparsed.session)
    : null;
  if (currentProjection && !currentProjection.success) {
    return { ok: false, session: null, errorCode: 'invalid_response' };
  }

  const row = currentProjection?.success ? currentProjection.data : reparsed.session;
  const access = normalizeSessionAccessProjection(row, { allowLegacy: true });
  if (String(row.id ?? '').trim() !== sessionId) {
    return { ok: false, session: null, errorCode: 'invalid_response' };
  }

  const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
  if (!isSessionEncryptionModeAllowedByClientRequirement(
    params.clientEncryptionRequirement ?? 'follow_account',
    encryptionMode,
  )) {
    return { ok: false, session: null, errorCode: 'client_e2ee_required' };
  }

  // ── Lane 06 canonical Session data-key hydration block ────────────────────────
  // Owns ONLY: envelope normalization, opening, cache writes and the derived content
  // availability. The viewer role is an input produced above this block; this block never
  // infers ownership from `share`. Everything below `── end` belongs to other owners.
  // Lane 04's strict admission above is the role authority. An unavailable projection fails
  // closed to `recipient`: owner-only Account material is never reached without a proven owner
  // role, and this block never re-infers ownership from `share`.
  const viewerRole: SessionDataKeyViewerRole = params.sessionKey !== undefined
    ? 'recipient' : access?.role === 'owner' ? 'owner' : 'recipient';
  const hydrationPlan = createSessionDataKeyHydrationPlan({
    sessions: [{
      id: sessionId,
      encryptionMode,
      dataEncryptionKey: params.sessionKey !== undefined ? params.sessionKey : row.dataEncryptionKey,
      viewerRole,
    }],
    credentialKind: readSessionDataKeyCredentialKind(params.credentials),
    sessionDataKeys: params.sessionDataKeys,
    ...(params.sessionDataKeyEnvelopes ? { sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes } : {}),
  });
  // Keep this request's cache mutations private until both the crypto owner and
  // the request authority are still current after initialization. A superseded
  // by-ID request must neither publish its opened key nor delete a newer
  // request's cache entry while unwinding.
  const requestSessionDataKeys = new Map(params.sessionDataKeys);
  const requestSessionDataKeyEnvelopes = params.sessionDataKeyEnvelopes
    ? new Map(params.sessionDataKeyEnvelopes)
    : undefined;
  const hydrationScope = typeof params.serverId === 'string' && params.serverId.trim().length > 0
    ? { serverId: params.serverId.trim() }
    : {};
  let capturedEncryptionGeneration = params.encryption.getCurrentEncryptionGenerationScope?.(
    hydrationScope,
  ) ?? null;
  const isHydrationCurrent = () => (
    isCurrent()
    && (!capturedEncryptionGeneration
      || params.encryption.isCurrentEncryptionGenerationScope?.(capturedEncryptionGeneration) !== false)
  );
  const hydration = await hydrateSessionDataKeys({
    plan: hydrationPlan,
    // By-ID resolves exactly one Session, so the batch the shared owner expects is this one
    // envelope. Reusing the existing singular opener keeps one decision owner without
    // duplicating the crypto routing this call site never needed.
    encryption: {
      decryptEncryptionKeys: async (values) => {
        const opened: Array<Uint8Array | null> = [];
        for (const value of values) {
          opened.push(await params.encryption.decryptEncryptionKey(value));
        }
        return opened;
      },
      ...(params.encryption.getCurrentEncryptionGenerationScope ? {
        getCurrentEncryptionGenerationScope: (scope) =>
          params.encryption.getCurrentEncryptionGenerationScope!(scope),
      } : {}),
      ...(params.encryption.isCurrentEncryptionGenerationScope ? {
        isCurrentEncryptionGenerationScope: (scope) =>
          params.encryption.isCurrentEncryptionGenerationScope!(scope),
      } : {}),
    },
    sessionDataKeys: requestSessionDataKeys,
    ...(requestSessionDataKeyEnvelopes ? { sessionDataKeyEnvelopes: requestSessionDataKeyEnvelopes } : {}),
    scope: hydrationScope,
    shouldContinue: isHydrationCurrent,
  });
  if (hydration.stale || !isHydrationCurrent()) return staleResult();

  if (hydration.sessionKeys.size > 0) {
    const initializedScope = await params.encryption.initializeSessions(hydration.sessionKeys, {
      ...hydrationScope,
      shouldContinue: isHydrationCurrent,
    });
    if (initializedScope) capturedEncryptionGeneration = initializedScope;
    if (!isHydrationCurrent()) return staleResult();
  }
  if (hydration.sessionEncryptionClears.includes(sessionId)) {
    params.sessionDataKeys.delete(sessionId);
    params.sessionDataKeyEnvelopes?.delete(sessionId);
    // Clearing a reader this request just found unopenable advances the owning
    // generation exactly like installing one does, so the post-commit scope is
    // adopted here too. Without it the request rejects its own truthful
    // ready→locked result and the route keeps spinning on a retryable error.
    const clearedScope = params.encryption.removeSessionEncryption?.(sessionId);
    if (clearedScope) capturedEncryptionGeneration = clearedScope;
  } else {
    const hydratedKey = requestSessionDataKeys.get(sessionId);
    if (hydratedKey) params.sessionDataKeys.set(sessionId, hydratedKey);
    else params.sessionDataKeys.delete(sessionId);
    const hydratedEnvelope = requestSessionDataKeyEnvelopes?.get(sessionId);
    if (params.sessionDataKeyEnvelopes) {
      if (hydratedEnvelope) params.sessionDataKeyEnvelopes.set(sessionId, hydratedEnvelope);
      else params.sessionDataKeyEnvelopes.delete(sessionId);
    }
  }

  const hydrationState = hydration.states.get(sessionId) ?? 'missing_envelope';
  let accountCurrentness = params.accountCurrentness;
  let recipientReadiness = accountCurrentness?.recipientEnvelopeReadiness;
  if (params.sessionKey === undefined && hydrationState === 'missing_envelope' && !recipientReadiness) {
    try {
      accountCurrentness = params.fetchAccountCurrentness
        ? await params.fetchAccountCurrentness()
        : await fetchAccountEncryptionCurrentness(params.credentials, { request: params.request });
      recipientReadiness = accountCurrentness.recipientEnvelopeReadiness;
    } catch (error) {
      if (error instanceof AccountEncryptionCurrentnessReadinessError) {
        recipientReadiness = error.recipientEnvelopeReadiness;
      } else {
        if (isTerminalAuthError(error)) throw error;
        return { ok: false, session: null, errorCode: 'account_currentness_unavailable' };
      }
    }
    if (!isHydrationCurrent()) return staleResult();
  }
  const contentAvailability = deriveSessionContentAvailability({
    hydrationState,
    recipientReadiness,
  });

  const metadataLayoutVersion = readSessionMetadataLayoutVersion(row.metadataLayoutVersion);
  const recipientAuthority = metadataLayoutVersion === 1
    && !isSessionAccessOwner(access, undefined);
  if (
    metadataLayoutVersion === 1
    && !recipientAuthority
    && row.ownerMetadata != null
    && !accountCurrentness
    && params.composerOptionsInput === undefined
    && params.fetchAccountCurrentness
  ) {
    accountCurrentness = await params.fetchAccountCurrentness();
    if (!isHydrationCurrent()) return staleResult();
  }
  const accountMode = params.accountMode ?? accountCurrentness?.mode;
  const ownerMetadataRead = metadataLayoutVersion === 1
    ? readSessionLayout1OwnerMetadata({
        access,
        accountMode,
        ownerMetadataEnvelope: row.ownerMetadata,
        credentials: params.credentials,
        composerOptionsInput: params.composerOptionsInput,
      })
    : null;
  const lockedOwnerVisibility = projectSessionLayout1LockedOwnerVisibility(
    ownerMetadataRead,
  );

  const sessionEncryption = encryptionMode === 'plain' ? null : params.encryption.getSessionEncryption(sessionId);
  if (!isSessionContentReadable(contentAvailability)) {
    // A frame's explicitly supplied key cannot be repaired with Account material.
    // Keep the shared hydration decision, but return its typed admission failure
    // instead of publishing the main app's Account-repair shell in the frame.
    if (params.sessionKey !== undefined) {
      return { ok: false, session: null,
        errorCode: hydrationState === 'missing_envelope' ? 'session_key_unavailable' : 'session_key_invalid',
        sessionDataKeyHydration: hydration };
    }
    // Settled: no reader exists and retrying cannot change that. Apply a safe Session shell so
    // the route shows a truthful locked state instead of spinning on a retryable-looking error.
    if (!isHydrationCurrent()) return staleResult();
    return applyLockedSessionShell({
      row,
      sessionId,
      serverId: params.serverId,
      encryptionMode,
      contentAvailability,
      sessionDataKeyHydration: hydration,
      applySessions: params.applySessions,
      getExistingSession: params.getExistingSession,
      includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
      ownerMetadataView: lockedOwnerVisibility,
    });
  }
  if (encryptionMode === 'e2ee' && !sessionEncryption) {
    params.log.log(`[sessionById] Session encryption not found for ${sessionId}`);
    return { ok: false, session: null, errorCode: 'session_encryption_not_found' };
  }
  // ── end Lane 06 canonical Session data-key hydration block ────────────────────

  const agentStateVersion = row.agentStateVersion ?? 0;
  const applyUnavailableOwnerShell = () => applyLockedSessionShell({
    row, sessionId, serverId: params.serverId, encryptionMode, contentAvailability,
    sessionDataKeyHydration: hydration, applySessions: params.applySessions,
    getExistingSession: params.getExistingSession,
    includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
    ownerMetadataUnavailable: true,
  });
  if (
    metadataLayoutVersion === 1
    && !recipientAuthority
    && row.ownerMetadata != null
    && !accountMode
    && params.composerOptionsInput === undefined
  ) {
    params.log.log(`[sessionById] Account currentness unavailable for ${sessionId}`);
    return {
      ok: false,
      session: null,
      errorCode: 'account_currentness_unavailable',
    };
  }
  if (ownerMetadataRead?.kind === 'unavailable') {
    params.log.log(`[sessionById] Owner metadata unavailable for ${sessionId}`);
    if (!isHydrationCurrent()) return staleResult();
    return applyUnavailableOwnerShell();
  }
  let metadataAuthenticationFailed = false;
  const metadataDecryptOptions = { onAuthenticationFailure: () => { metadataAuthenticationFailed = true; } };
  const decryptedMetadataPromise = encryptionMode === 'plain'
    ? Promise.resolve(parsePlainSessionMetadata(row.metadata, row.metadataLayoutVersion))
    : metadataLayoutVersion === 1
      ? (
          sessionEncryption!.decryptMetadataPayload?.(row.metadataVersion, row.metadata, metadataDecryptOptions)
          ?? Promise.resolve(null)
        )
      : sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata, metadataDecryptOptions);
  const agentStatePromise = metadataLayoutVersion === 1
    && ownerMetadataRead?.kind !== 'owner'
      ? Promise.resolve(null)
      : encryptionMode === 'plain'
        ? Promise.resolve(parsePlainSessionAgentState(row.agentState ?? null))
        : sessionEncryption!.decryptAgentState(
            agentStateVersion,
            row.agentState ?? null,
          );
  const [decryptedMetadata, agentState] = await Promise.all([
    decryptedMetadataPromise,
    agentStatePromise,
  ]);
  if (!isHydrationCurrent()) return staleResult();
  const metadata = encryptionMode === 'plain'
    ? decryptedMetadata
    : parseDecryptedSessionMetadata(decryptedMetadata, row.metadataLayoutVersion);
  if (encryptionMode === 'e2ee' && metadataAuthenticationFailed) {
    return applyLockedSessionShell({
      row,
      sessionId,
      serverId: params.serverId,
      encryptionMode,
      contentAvailability: deriveSessionContentAvailability({
        hydrationState,
        contentAuthenticationFailed: true,
      }),
      sessionDataKeyHydration: hydration,
      applySessions: params.applySessions,
      getExistingSession: params.getExistingSession,
      includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
      ownerMetadataView: lockedOwnerVisibility,
    });
  }
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
  const ownerProjection = metadataLayoutVersion === 1 && layout1SharedMetadata
    ? projectSessionLayout1OwnerMetadata({
        sharedMetadata: layout1SharedMetadata,
        ownerMetadataRead: ownerMetadataRead!,
      })
    : null;
  if (ownerProjection?.kind === 'unavailable') {
    params.log.log(`[sessionById] Owner metadata unavailable for ${sessionId}`);
    if (!isHydrationCurrent()) return staleResult();
    return applyUnavailableOwnerShell();
  }
  const ownerMetadata = ownerProjection?.kind === 'owner'
    ? ownerProjection.ownerMetadata
    : null;
  const ownerMetadataView = params.composerOptionsInput !== undefined ? null : metadataLayoutVersion === 0
    ? metadata
    : ownerProjection?.kind === 'owner'
      ? ownerProjection.ownerMetadataView
      : null;
  const composerOptionsInput = ownerProjection?.kind === 'owner' || ownerProjection?.kind === 'composer'
    ? ownerProjection.composerOptionsInput
    : params.composerOptionsInput !== undefined && params.composerOptionsInput !== null
      ? params.composerOptionsInput
      : metadataLayoutVersion === 0 && (params.composerOptionsInput === undefined || accountMode === 'plain')
        ? projectComposerOptionsInputV1(metadata)
        : null;
  if (!isHydrationCurrent()) return staleResult();

  const accessLevel = access?.level;
  const normalizedAccessLevel = accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;
  const sessionTurns = params.includeTurnsProjection === false
    ? null
    : await fetchSessionTurnsProjection({
      sessionId,
      credentials: params.credentials,
      request: params.request,
      log: params.log,
    });
  if (!isHydrationCurrent()) return staleResult();
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
        ownerProjection?.kind === 'owner'
        && ownerMetadata
        && ownerMetadataView
        && typeof row.agentStateVersion === 'number'
        && Object.prototype.hasOwnProperty.call(row, 'agentState')
          ? {
            mode: 'owner',
            metadataLayoutVersion: 1,
            metadataVersion: row.metadataVersion,
            sharedMetadataCiphertext: row.metadata,
            ownerMetadataEnvelope: ownerProjection.ownerMetadataEnvelope,
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
    ownerMetadata: _ownerMetadataEnvelope,
    ...rowWithoutOwnerMetadata
  } = row;

  const previousSession = params.getExistingSession?.(sessionId);
  const nextSession = {
    ...rowWithoutOwnerMetadata,
    serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
    encryptionMode,
    thinking: false,
    thinkingAt: 0,
    metadata,
    ownerMetadataView,
    composerOptionsInput,
    metadataProjection: params.composerOptionsInput !== undefined ? 'sessionOnly' as const : undefined,
    agentState,
    agentStateVersion,
    access,
    accessLevel: normalizedAccessLevel,
    canApprovePermissions: access?.capabilities.approveRuntimePermissions,
    encryptedContentAvailability: contentAvailability,
    ...(sessionTurns
      ? {
        sessionTurns,
        rollbackEligibleTurnStarts,
      }
      : params.includeTurnsProjection === false && previousSession?.encryptionMode === encryptionMode
        ? {
          sessionTurns: previousSession.sessionTurns,
          rollbackEligibleTurnStarts: previousSession.rollbackEligibleTurnStarts,
        }
        : {}),
  };

  if (!isStoredSessionInResponseScope(previousSession, nextSession)) return staleResult();
  if (!isHydrationCurrent()) return staleResult();
  params.applySessions([nextSession]);
  const appliedSession = params.getExistingSession?.(sessionId) ?? nextSession;
  reportNewAgentRequestsFromSessionTransition(previousSession, appliedSession);

  return {
    ok: true,
    sessionDataKeyHydration: hydration,
    session: appliedSession,
    ...(params.includeMetadataTupleMutationSnapshot === true
      ? { metadataTupleMutationSnapshot: classifySessionTupleApplyCurrentness(previousSession, nextSession).fullyCurrent
          ? metadataTupleMutationSnapshot : null }
      : {}),
  };
}
