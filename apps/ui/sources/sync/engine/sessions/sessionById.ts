import { isSessionAccessOwner, normalizeSessionAccessProjection } from './normalizeSessionAccessProjection';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionTurnsProjectionV1Schema, type SessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { isSessionEncryptionModeAllowedByClientRequirement, type ClientEncryptionRequirement } from '@happier-dev/protocol/encryption/clientEncryptionRequirement';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { V2SessionByIdResponse } from '@happier-dev/protocol/sessions/control/contract';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionReadObservation } from './snapshotMembership';
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
import { isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';

import {
  parseDecryptedSessionMetadata,
  parsePlainSessionMetadata,
  readSessionMetadataLayoutVersion,
  tryParsePlainSessionAgentState,
} from './parsePlainSessionPayload';
import { classifySessionTupleApplyCurrentness } from '@/sync/domains/session/sessionTupleApplyCurrentness';
import {
  looksLikeCurrentV2SessionNotFound404,
  parseCompatSessionByIdResponse,
} from './sessionHttpCompat';
import {
  buildSessionOwnerMetadataUnavailableShell,
  isSessionAgentStateVisible,
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
import { SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { SESSION_LIST_DOCUMENT_ADMISSION, buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildRenderableFromRowAndCache, createSessionListDocumentAdmission } from './sessionSnapshot';
import { admitOpenedSessionListDisplayMetadata, admitOpenedSessionListAgentState, mergeSessionListDocumentObservations,
  areSessionListDocumentAdmissionsEqual, type SessionListDocumentAdmission } from '@/sync/domains/session/sessionDocumentAdmission';
import type { AgentStateOpenResult } from '@/sync/encryption/sessionEncryption';
import { parsePlainSessionAgentStateResult } from './parsePlainSessionPayload';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { SessionDisplayProjectionV1Schema } from '@happier-dev/protocol';
import { readSessionByIdHttp } from './sessionByIdHttp';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import type { ScopedBatchResolutionContext } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';

type SessionEncryption = {
  decryptAgentStateResult?: (version: number, value: string | null | undefined) => Promise<AgentStateOpenResult>;
  encryptRaw?: (payload: unknown) => Promise<string>;
  decryptRaw?: (ciphertext: string) => Promise<unknown>;
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

export type SessionByIdContentDemand = 'session' | 'encryption-context' | 'list-projection' | 'list-display';

type SessionDataKeyEnvelopeCache = Map<string, string>;

type SessionPublication = Omit<Session, 'presence'> & { presence?: 'online' | number };
type ApplySessions = (sessions: SessionPublication[]) => void;
export type SessionListRowPublication = Readonly<{ serverId: string; row: SessionListRenderableSession }>;
type ApplySessionListRows = (rows: readonly SessionListRowPublication[]) => void;
type PendingSessionPublication = {
  isCurrent: () => boolean;
  ensureCurrent: () => Promise<void>;
  resolve: (applied: boolean) => void;
  reject: (error: unknown) => void;
} & ({
  kind: 'session'; session: SessionPublication; applySessions: ApplySessions;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
} | { kind: 'list'; projection: SessionListRowPublication; applyRows: ApplySessionListRows });

async function applySessionPublications(batch: readonly PendingSessionPublication[]): Promise<void> {
  const current = await Promise.allSettled(batch.map(async entry => {
    await entry.ensureCurrent();
    return entry;
  }));
  const admitted: PendingSessionPublication[] = [];
  const staged = new Map<string, Extract<PendingSessionPublication, { kind: 'session' }>>();
  const previous = new Map<string, Session | null | undefined>();
  for (let index = 0; index < current.length; index++) {
    const result = current[index]!;
    if (result.status === 'rejected') { batch[index]!.reject(result.reason); continue; }
    const entry = result.value;
    try {
      if (!entry.isCurrent() || (entry.kind === 'session'
        && !isStoredSessionInResponseScope(staged.get(entry.session.id)?.session, entry.session))) {
        entry.resolve(false);
        continue;
      }
      if (entry.kind === 'session') {
        if (!previous.has(entry.session.id)) previous.set(entry.session.id, entry.getExistingSession?.(entry.session.id));
        staged.set(entry.session.id, entry);
      }
      admitted.push(entry);
    } catch (error) { entry.reject(error); }
  }
  try {
    const first = admitted[0];
    if (first?.kind === 'session') {
      first.applySessions(admitted.flatMap(entry => entry.kind === 'session' ? [entry.session] : []));
      for (const entry of staged.values()) reportNewAgentRequestsFromSessionTransition(
        previous.get(entry.session.id), entry.getExistingSession?.(entry.session.id) ?? entry.session,
      );
    } else if (first?.kind === 'list') {
      first.applyRows(admitted.flatMap(entry => entry.kind === 'list' ? [entry.projection] : []));
    }
    for (const entry of admitted) entry.resolve(true);
  } catch (error) { for (const entry of admitted) entry.reject(error); }
}

/** One slot is registered during physical delivery, before any asynchronous opening. */
function createSessionPublication(destination: object, signal?: AbortSignal, listDisplay?: Readonly<{
  serverId: string;
  applyRows: ApplySessionListRows;
  getCurrentRow?: (sessionId: string) => SessionListRenderableSession | null | undefined;
}>) {
  let finish: ((entry: PendingSessionPublication | null) => void) | undefined;
  let publication: Promise<void> | undefined;
  let publishedListRow: SessionListRenderableSession | undefined;
  const cancel = () => finish?.(null);
  signal?.addEventListener('abort', cancel, { once: true });
  return {
    readListRow: () => publishedListRow,
    bind(chunk: ScopedBatchResolutionContext) {
      const prepared = new Promise<PendingSessionPublication | null>(resolve => { finish = resolve; });
      publication = chunk.publish(destination, prepared, applySessionPublications);
      // Keep custody even if an HTTP/cancellation failure ends the borrower first.
      void publication.catch(() => {});
    },
    async apply(entry: PendingSessionPublication): Promise<void> {
      if (signal?.aborted) { entry.resolve(false); return; }
      // Display demand uses the same admitted key/document opener, but the
      // existing row publication owns its output. It creates no Session carrier
      // or full-publication receipt and emits no full-Session transition effects.
      if (listDisplay && entry.kind === 'session') {
        const session = entry.session;
        publishedListRow = buildSessionListRenderableFromSession({ ...session,
          presence: session.presence ?? (session.active ? 'online' : session.activeAt),
        }, listDisplay.getCurrentRow?.(session.id) ?? undefined);
        entry = { kind: 'list', projection: { serverId: listDisplay.serverId, row: publishedListRow },
          applyRows: listDisplay.applyRows, isCurrent: entry.isCurrent, ensureCurrent: entry.ensureCurrent,
          resolve: entry.resolve, reject: entry.reject };
      }
      if (publication) { finish!(entry); await publication; }
      else await applySessionPublications([entry]);
    },
    close() { finish?.(null); signal?.removeEventListener('abort', cancel); },
  };

}
type SessionPublicationSlot = ReturnType<typeof createSessionPublication>;

async function publishHydratedSession(params: {
  session: SessionPublication;
  applySessions: ApplySessions;
  isCurrent: () => boolean;
  ensureCurrent: () => Promise<void>;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  publication: SessionPublicationSlot;
}): Promise<boolean> {
  await params.ensureCurrent();
  return await new Promise((resolve, reject) => {
    void params.publication.apply({ kind: 'session', session: params.session, applySessions: params.applySessions,
      isCurrent: params.isCurrent, ensureCurrent: params.ensureCurrent,
      getExistingSession: params.getExistingSession, resolve, reject }).catch(reject);
  });
}

/** Transport inputs only; the ordinary Session reader still admits and opens each row. */
export type SessionByIdPrefetchedRead = Readonly<{
  accessProjectionVersion?: 1;
  detail: Readonly<{ status: number; body: unknown }>;
  turns?: Readonly<{ status: number; body: unknown }>;
}>;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A retained layout-1 owner row can lack its owner envelope. The canonical wire schema rejects
 * that tuple for readable projections; exact hydration still has to settle it as unavailable
 * instead of retrying forever. Validate the complete current row with a schema-only placeholder,
 * then restore the missing envelope so the owner reader contracts it to the existing safe shell.
 */
function parseCurrentSessionProjectionForHydration(value: unknown) {
  const parsed = SessionCurrentProjectionRecordV1Schema.safeParse(value);
  if (parsed.success || !isUnknownRecord(value)) return parsed;
  const effectiveAccess = value.effectiveAccess;
  const isMissingOwnerEnvelope = value.metadataLayoutVersion === 1
    && (value.ownerMetadata === null || value.ownerMetadata === undefined)
    && value.share === null
    && isUnknownRecord(effectiveAccess)
    && effectiveAccess.level === 'owner';
  if (!isMissingOwnerEnvelope) return parsed;
  const validated = SessionCurrentProjectionRecordV1Schema.safeParse({
    ...value,
    ownerMetadata: { t: 'plain', v: { v: 1 } },
  });
  return validated.success
    ? { success: true as const, data: { ...validated.data, ownerMetadata: null } }
    : parsed;
}
type HydratedSessionById = Omit<
  V2SessionByIdResponse['session'],
  'metadata' | 'ownerMetadata'
> & Pick<Session, 'id' | 'seq' | 'updatedAt' | 'metadataLayoutVersion' | 'metadataVersion'
  | 'agentStateVersion' | 'archivedAt' | typeof SESSION_LIST_DOCUMENT_ADMISSION> & {
  metadata: Session['metadata'];
  metadataProjection?: Session['metadataProjection'];
  ownerMetadataView?: Session['ownerMetadataView'];
  composerOptionsInput?: Session['composerOptionsInput'];
};

export type HydratedSessionMetadataTupleMutationSnapshot =
  SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState>;

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
  serverId?: string | null;
  readTransport?: CapturedServerReadTransport;
  signal?: AbortSignal;
  log: { log: (message: string) => void };
  prefetched?: SessionByIdPrefetchedRead;
  required: boolean;
}>): Promise<SessionTurnsProjectionV1 | null> {
  let status: number;
  let body: unknown;
  if (params.prefetched) {
    const read = params.prefetched.turns;
    if (!read) return null;
    status = read.status;
    body = read.body;
  } else {
    let response: Awaited<ReturnType<typeof readSessionByIdHttp>>;
    try {
      response = await readSessionByIdHttp({ ...params, token: params.credentials.token, projection: 'turns' });
    } catch (err) {
      if (isTerminalAuthError(err)) throw err;
      if (params.required) throw err;
      params.log.log(`[sessionById] Failed to fetch session turns ${params.sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
      return null;
    }
    status = response.status;
    body = response.ok ? response.body : null;
  }

  if (status < 200 || status >= 300) {
    // A denied Session part is not a rejected Account credential.
    if (status === 401) throw createNotAuthenticatedError(status);
    if (params.required && status >= 500) throw new RetryableServerResponseError(status, 'Session turns unavailable');
    return null;
  }

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
async function applyLockedSessionShell(params: Readonly<{
  row: V2SessionByIdResponse['session'];
  sessionId: string;
  serverId?: string | null;
  encryptionMode: 'e2ee' | 'plain';
  contentAvailability: SessionContentAvailability;
  sessionDataKeyHydration: SessionDataKeyHydrationResult;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  isCurrent: () => boolean;
  ensureCurrent: () => Promise<void>;
  publication: SessionPublicationSlot;
  includeMetadataTupleMutationSnapshot: boolean;
  ownerMetadataView?: Session['ownerMetadataView'];
  // The owner's metadata could not be opened: install the same locked shell the
  // list path installs (one executor for this outcome, see cp-c2).
  ownerMetadataUnavailable?: boolean;
  documentAdmission?: SessionListDocumentAdmission;
}>): Promise<{
  ok: boolean;
  session: HydratedSessionById | Session | null;
  sessionPublicationUpdatedAt?: number;
  sessionDataKeyHydration?: SessionDataKeyHydrationResult;
  metadataTupleMutationSnapshot?: HydratedSessionMetadataTupleMutationSnapshot | null;
  errorCode?: string;
}> {
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
    [SESSION_LIST_DOCUMENT_ADMISSION]: params.documentAdmission
      ? mergeSessionListDocumentObservations(params.documentAdmission, params.getExistingSession?.(params.sessionId)?.[SESSION_LIST_DOCUMENT_ADMISSION])
      : undefined,
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
  const applied = await publishHydratedSession({
    session: sessionToApply as unknown as SessionPublication,
    applySessions: params.applySessions,
    getExistingSession: params.getExistingSession,
    ensureCurrent: params.ensureCurrent,
    publication: params.publication,
    isCurrent: () => params.isCurrent()
      && isStoredSessionInResponseScope(params.getExistingSession?.(params.sessionId), sessionToApply),
  });
  if (!applied) return { ok: false, session: null, errorCode: 'stale_response' };
  return {
    ok: true,
    session: (params.getExistingSession?.(params.sessionId) ?? sessionToApply) as HydratedSessionById,
    sessionPublicationUpdatedAt: params.row.updatedAt,
    sessionDataKeyHydration: params.sessionDataKeyHydration,
    ...(params.includeMetadataTupleMutationSnapshot ? { metadataTupleMutationSnapshot: null } : {}),
  };
}

export async function fetchAndApplySessionById(params: Readonly<{
  sessionId: string;
  prefetched?: SessionByIdPrefetchedRead;
  /** Exact access/list reconciliation and draft recovery can omit full Session hydration. */
  contentDemand?: SessionByIdContentDemand;
  serverId?: string | null;
  credentials: AuthCredentials;
  /** Explicit bridge envelope: presence binds this read to a Session recipient. */
  sessionKey?: string | null;
  accountCurrentness?: AccountEncryptionCurrentnessResponse;
  accountMode?: AccountEncryptionCurrentnessResponse['mode'];
  composerOptionsInput?: import('@happier-dev/protocol/embed').ComposerOptionsInputV1 | null;
  fetchAccountCurrentness?: () => Promise<AccountEncryptionCurrentnessResponse>;
  /** Re-admit a finite witness withdrawn by transport loss before publication. */
  ensureAccountCurrentness?: () => Promise<void>;
  encryption: SessionByIdEncryption;
  sessionDataKeys: Map<string, Uint8Array>;
  sessionDataKeyEnvelopes?: SessionDataKeyEnvelopeCache;
  request: (path: string, init: RequestInit) => Promise<Response>;
  readTransport?: CapturedServerReadTransport;
  signal?: AbortSignal;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  applySessionListRows?: ApplySessionListRows;
  getExistingSession?: (sessionId: string) => Session | null | undefined;
  getCurrentSessionListRenderable?: (sessionId: string) => SessionListRenderableSession | null | undefined;
  log: { log: (message: string) => void };
  timeoutMs?: number;
  includeTurnsProjection?: boolean | 'required';
  includeMetadataTupleMutationSnapshot?: boolean;
  /** Capturing a maintenance tuple must not bypass shared ordinary reads. */
  fresh?: boolean;
  onSessionObservation?: (observation: SessionReadObservation) => void;
  isCurrent?: () => boolean;
  accessProjectionVersion?: 1;
  clientEncryptionRequirement?: ClientEncryptionRequirement;
}>): Promise<{
  ok: boolean;
  session: HydratedSessionById | Session | null;
  /** This response's admitted full-publication witness, independent of retained content time. */
  sessionPublicationUpdatedAt?: number;
  sessionListRenderable?: SessionListRenderableSession;
  encryptionMode?: 'e2ee' | 'plain';
  sessionDataKeyHydration?: SessionDataKeyHydrationResult;
  metadataTupleMutationSnapshot?:
    | HydratedSessionMetadataTupleMutationSnapshot
    | null;
  errorCode?: string;
  httpStatus?: number;
}> {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, session: null, errorCode: 'invalid_session_id' };
  const listDisplay = params.contentDemand === 'list-display';
  if (listDisplay && (!params.applySessionListRows || !params.serverId?.trim())) {
    return { ok: false, session: null, errorCode: 'stale_response' };
  }
  const publication = createSessionPublication(params.applySessionListRows ?? params.applySessions, params.signal,
    listDisplay ? { serverId: params.serverId!.trim(), applyRows: params.applySessionListRows!,
      getCurrentRow: params.getCurrentSessionListRenderable } : undefined);
  try {
    const result = await hydrate();
    return listDisplay ? { ...result, session: null, sessionListRenderable: publication.readListRow() } : result;
  }
  finally { publication.close(); }

  async function hydrate(): Promise<Awaited<ReturnType<typeof fetchAndApplySessionById>>> {
  const isCurrent = () => !params.signal?.aborted && params.isCurrent?.() !== false;
  // A retired caller scope is the more specific cause, so it wins over the
  // witness' own terminal currentness failure and ends as a stale response.
  const ensureAccountCurrentness = async () => {
    if (isCurrent()) await params.ensureAccountCurrentness?.();
  };
  const staleResult = () => ({
    ok: false as const,
    session: null,
    errorCode: 'stale_response',
    ...(params.includeMetadataTupleMutationSnapshot === true
      ? { metadataTupleMutationSnapshot: null }
      : {}),
  });

  let responseOk = false;
  let responseStatus = 0;
  let body: unknown = null;
  let acquiredTurns: SessionByIdPrefetchedRead['turns'];
  try {
    const response = params.prefetched ? {
      ok: params.prefetched.detail.status === 200,
      status: params.prefetched.detail.status,
      body: params.prefetched.detail.body,
      turns: params.prefetched.turns,
    } : await readSessionByIdHttp({
      sessionId,
      serverId: params.serverId,
      token: params.credentials.token,
      request: params.request,
      readTransport: params.readTransport,
      projection: params.readTransport && (params.contentDemand === undefined || params.contentDemand === 'session')
        && params.includeTurnsProjection !== false ? 'snapshot' : 'detail',
      signal: params.signal,
      fresh: params.fresh ?? params.includeMetadataTupleMutationSnapshot === true,
      timeoutMs: params.timeoutMs,
      accessProjectionVersion: params.accessProjectionVersion,
      onBatch: params.contentDemand === 'encryption-context'
        || (params.contentDemand === 'list-projection' && !params.applySessionListRows) ? undefined : publication.bind,
    });
    responseOk = response.ok;
    responseStatus = response.status;
    body = response.body;
    acquiredTurns = response.turns;
  } catch (err) {
    if (isTerminalAuthError(err)) {
      throw err;
    }
    if (err instanceof SessionPartsInvalidResponseError) {
      return { ok: false, session: null, errorCode: 'invalid_response' };
    }
    params.log.log(`[sessionById] Failed to fetch session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { ok: false, session: null, errorCode: isTransientConnectivityError(err) ? 'network_error' : 'request_failed' };
  }
  await ensureAccountCurrentness();
  if (!isCurrent()) return staleResult();

  if (!responseOk) {
    // Detail refusals concern this Session, including parts of a successful
    // Account read-batch. They do not invalidate the Account connection.
    if (responseStatus === 403) {
      return { ok: false, session: null, errorCode: 'forbidden', httpStatus: 403 };
    }
    if (isAuthenticationResponseStatus(responseStatus)) {
      throw createNotAuthenticatedError(responseStatus);
    }
    // A transient detail refusal is not a legacy-route negotiation witness.
    // In particular, a structured batch refusal must not re-admit a retained list row.
    if (responseStatus === 503) {
      return { ok: false, session: null, errorCode: 'http_error', httpStatus: responseStatus };
    }
    if (responseStatus === 404) {
      if (looksLikeCurrentV2SessionNotFound404(body)) {
        return { ok: false, session: null, errorCode: 'not_found', httpStatus: 404 };
      }
      return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: 404 };
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

  const negotiatedCurrentProjection = params.accessProjectionVersion === 1
    && isUnknownRecord(body)
    ? parseCurrentSessionProjectionForHydration(body.session)
    : null;
  const parsed = negotiatedCurrentProjection?.success
    ? { session: negotiatedCurrentProjection.data }
    : parseCompatSessionByIdResponse(body);
  if (!parsed?.session) {
    const status = responseStatus;
    return { ok: false, session: null, errorCode: 'invalid_response', httpStatus: responseOk ? undefined : status };
  }

  const currentProjection = params.accessProjectionVersion === 1
    ? negotiatedCurrentProjection?.success
      ? negotiatedCurrentProjection
      : parseCurrentSessionProjectionForHydration(parsed.session)
    : null;
  if (currentProjection && !currentProjection.success) {
    return { ok: false, session: null, errorCode: 'invalid_response' };
  }

  const row = currentProjection?.success ? currentProjection.data : parsed.session;
  const access = normalizeSessionAccessProjection(row, { allowLegacy: true });
  if (String(row.id ?? '').trim() !== sessionId) {
    return { ok: false, session: null, errorCode: 'invalid_response' };
  }

  const observation = V2SessionByIdResponseSchema.shape.observationCursor.safeParse(
    isUnknownRecord(body) ? body.observationCursor : undefined,
  );
  if (!observation.success) return { ok: false, session: null, errorCode: 'invalid_response' };
  params.onSessionObservation?.({ session: row, observationCursor: observation.data });
  if (!isCurrent()) return staleResult();

  const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';
  if (!isSessionEncryptionModeAllowedByClientRequirement(
    params.clientEncryptionRequirement ?? 'follow_account',
    encryptionMode,
  )) {
    return { ok: false, session: null, errorCode: 'client_e2ee_required' };
  }

  if (params.contentDemand === 'list-projection') {
    let accountCurrentness = params.accountCurrentness;
    if (!accountCurrentness && readSessionMetadataLayoutVersion(row.metadataLayoutVersion) === 1 && access?.role === 'owner') {
      try {
        accountCurrentness = params.fetchAccountCurrentness
          ? await params.fetchAccountCurrentness()
          : await fetchAccountEncryptionCurrentness(params.credentials, { request: params.request });
      } catch (error) {
        if (isTerminalAuthError(error)) throw error;
        return { ok: false, session: null, errorCode: 'account_currentness_unavailable' };
      }
    }
    if (!isCurrent()) return staleResult();
    const sessionListRenderable = buildRenderableFromRowAndCache(
      row, params.credentials, accountCurrentness, undefined,
      params.getExistingSession?.(sessionId), params.getCurrentSessionListRenderable?.(sessionId),
    );
    await ensureAccountCurrentness();
    if (!isCurrent()) return staleResult();
    const applyRows = params.applySessionListRows;
    if (applyRows) {
      const serverId = params.serverId?.trim();
      if (!serverId) return staleResult();
      const applied = await new Promise<boolean>((resolve, reject) => {
        void publication.apply({ kind: 'list', projection: { serverId, row: sessionListRenderable },
          applyRows, isCurrent, ensureCurrent: ensureAccountCurrentness, resolve, reject }).catch(reject);
      });
      if (!applied) return staleResult();
    }
    return { ok: true, session: null, encryptionMode, sessionListRenderable };
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
  await ensureAccountCurrentness();
  if (!isHydrationCurrent()) return staleResult();
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

  if (params.contentDemand === 'encryption-context') {
    if (!isHydrationCurrent()) return staleResult();
    if (!isSessionContentReadable(contentAvailability)) {
      return {
        ok: false,
        session: null,
        errorCode: hydrationState === 'missing_envelope' ? 'session_key_unavailable' : 'session_key_invalid',
        sessionDataKeyHydration: hydration,
      };
    }
    if (encryptionMode === 'e2ee' && !params.encryption.getSessionEncryption(sessionId)) {
      return { ok: false, session: null, errorCode: 'session_encryption_not_found' };
    }
    return { ok: true, session: null, encryptionMode, sessionDataKeyHydration: hydration };
  }

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
        accountCurrentness,
        ownerMetadataEnvelope: row.ownerMetadata,
        credentials: params.credentials,
        composerOptionsInput: params.composerOptionsInput,
        previousProjection: params.getExistingSession?.(sessionId)?.[SESSION_OWNER_METADATA_PROJECTION],
      })
    : null;
  const lockedOwnerVisibility = projectSessionLayout1LockedOwnerVisibility(
    ownerMetadataRead,
  );

  const sessionEncryption = encryptionMode === 'plain' ? null : params.encryption.getSessionEncryption(sessionId);
  await ensureAccountCurrentness();
  const responseDocumentAdmission = params.sessionKey === undefined ? mergeSessionListDocumentObservations(createSessionListDocumentAdmission({
    row, serverId: params.serverId, credentials: params.credentials, accountCurrentness,
  }), params.getExistingSession?.(sessionId)?.[SESSION_LIST_DOCUMENT_ADMISSION]) : undefined;
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
      isCurrent: isHydrationCurrent,
      ensureCurrent: ensureAccountCurrentness,
      publication,
      includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
      ownerMetadataView: lockedOwnerVisibility,
      documentAdmission: responseDocumentAdmission,
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
    isCurrent: isHydrationCurrent,
    ensureCurrent: ensureAccountCurrentness,
    publication,
    includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
    ownerMetadataUnavailable: true,
    documentAdmission: responseDocumentAdmission,
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
  const agentStatePromise: Promise<AgentStateOpenResult> = !isSessionAgentStateVisible({
    metadataLayoutVersion, access,
    ownerMetadataAvailable: ownerMetadataRead?.kind === 'owner', contentAvailability,
  })
      ? Promise.resolve({ status: 'available', value: null })
      : encryptionMode === 'plain'
        ? Promise.resolve(parsePlainSessionAgentStateResult(row.agentState))
        : sessionEncryption!.decryptAgentStateResult?.(
            agentStateVersion,
            row.agentState,
          ) ?? Promise.resolve({ status: 'unavailable' });
  const [decryptedMetadata, agentStateOpenResult] = await Promise.all([
    decryptedMetadataPromise,
    agentStatePromise,
  ]);
  await ensureAccountCurrentness();
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
      isCurrent: isHydrationCurrent,
      ensureCurrent: ensureAccountCurrentness,
      publication,
      includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot === true,
      ownerMetadataView: lockedOwnerVisibility,
      documentAdmission: responseDocumentAdmission,
    });
  }
  if (agentStateOpenResult.status !== 'available') {
    const previous = params.getExistingSession?.(sessionId);
    const admission = previous?.[SESSION_LIST_DOCUMENT_ADMISSION];
    if (previous && admission && responseDocumentAdmission
      && areSessionListDocumentAdmissionsEqual(admission, responseDocumentAdmission)) {
      await publishHydratedSession({ session: { ...previous,
        [SESSION_LIST_DOCUMENT_ADMISSION]: mergeSessionListDocumentObservations(admission, responseDocumentAdmission) },
        applySessions: params.applySessions, getExistingSession: params.getExistingSession,
        isCurrent: isHydrationCurrent, ensureCurrent: ensureAccountCurrentness, publication });
    }
    return { ok: false, session: null, errorCode: 'agent_state_unavailable', sessionDataKeyHydration: hydration };
  }
  const agentState = agentStateOpenResult.value;
  const strictSharedMetadata = metadataLayoutVersion === 1
    ? StoredSessionSharedMetadataV1Schema.safeParse(decryptedMetadata)
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
        metadataVersion: row.metadataVersion,
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
      readTransport: params.readTransport,
      serverId: params.serverId,
      signal: params.signal,
      log: params.log,
      prefetched: params.prefetched ?? (acquiredTurns ? { detail: { status: responseStatus, body }, turns: acquiredTurns } : undefined),
      required: params.includeTurnsProjection === 'required',
    });
  if (!isHydrationCurrent()) return staleResult();
  const rollbackEligibleTurnStarts = sessionTurns
    ? listRollbackEligibleTurnStarts(sessionTurns)
    : undefined;
  // Display is optional retained data. A malformed sidecar cannot invalidate an
  // otherwise readable exact snapshot or become a purported current writer input.
  const parsedDisplayProjection = SessionDisplayProjectionV1Schema.safeParse(row.displayProjectionV1);
  const retainedDisplayProjection = parsedDisplayProjection.success
    ? { displayProjectionV1: parsedDisplayProjection.data }
    : row.displayProjectionV1 === null ? { displayProjectionV1: null } : {};
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
            ...retainedDisplayProjection,
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
              ...retainedDisplayProjection,
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
    ...(responseDocumentAdmission ? { [SESSION_LIST_DOCUMENT_ADMISSION]: responseDocumentAdmission } : {}),
    serverId: typeof params.serverId === 'string' && params.serverId.trim().length > 0 ? params.serverId.trim() : undefined,
    encryptionMode,
    thinking: false,
    thinkingAt: 0,
    metadata,
    ownerMetadataView,
    [SESSION_OWNER_METADATA_PROJECTION]: ownerProjection?.kind === 'owner' ? ownerProjection : null,
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
          ...(Object.hasOwn(previousSession, 'sessionTurns')
            ? { sessionTurns: previousSession.sessionTurns } : {}),
          ...(Object.hasOwn(previousSession, 'rollbackEligibleTurnStarts')
            ? { rollbackEligibleTurnStarts: previousSession.rollbackEligibleTurnStarts } : {}),
        }
        : {}),
  };

  const documentAdmission = nextSession[SESSION_LIST_DOCUMENT_ADMISSION];
  if (documentAdmission) {
    nextSession[SESSION_LIST_DOCUMENT_ADMISSION] = mergeSessionListDocumentObservations(admitOpenedSessionListAgentState(
      admitOpenedSessionListDisplayMetadata(documentAdmission, nextSession), agentStateVersion),
      params.getExistingSession?.(sessionId)?.[SESSION_LIST_DOCUMENT_ADMISSION]);
  }

  if (!hasAuthoritativeSessionRouteData(nextSession)) return staleResult();

  await ensureAccountCurrentness();
  if (!isStoredSessionInResponseScope(previousSession, nextSession)) return staleResult();
  if (!isHydrationCurrent()) return staleResult();
  const applied = await publishHydratedSession({
    session: nextSession,
    applySessions: params.applySessions,
    getExistingSession: params.getExistingSession,
    ensureCurrent: ensureAccountCurrentness,
    publication,
    isCurrent: () => isHydrationCurrent()
      && isStoredSessionInResponseScope(params.getExistingSession?.(sessionId), nextSession),
  });
  if (!applied) return staleResult();
  const appliedSession = params.getExistingSession?.(sessionId) ?? nextSession;

  return {
    ok: true,
    sessionDataKeyHydration: hydration,
    session: appliedSession,
    // Never borrow a later global witness: this borrower may have been in flight
    // while a newer full publication retained the same content object.
    sessionPublicationUpdatedAt: nextSession.updatedAt,
    ...(params.includeMetadataTupleMutationSnapshot === true
      ? { metadataTupleMutationSnapshot: classifySessionTupleApplyCurrentness(previousSession, nextSession).fullyCurrent
          ? metadataTupleMutationSnapshot : null }
      : {}),
  };
  }
}
