import axios, { type AxiosResponse } from 'axios';
import {
  agentEventLocalIdAttentionImpact,
  type SessionMessageAttentionImpact,
  type SessionStoredMessageContent,
  type V2SessionByIdResponse,
  type V2SessionListResponse,
  type SessionLookupByTagsResponseV2,
  SessionLookupByTagsRequestV2Schema,
  SessionLookupByTagsResponseV2Schema,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
  V2SessionMessageResponseSchema,
  SessionTurnsProjectionV1Schema,
  SessionMetadataActiveConflictV1Schema,
  SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
  SessionMetadataInactiveModelIntentVersionConflictV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  SessionMetadataVersionConflictV1Schema,
  type SessionMetadataInactiveModelIntentExpectationV1,
  type SessionMetadataInactiveModelIntentOwnerPatchV1,
  type SessionMetadataInactiveModelIntentPatchV1,
  type SessionMetadataTuplePatchV1,
  type SessionTurnsProjectionV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionEncryptionContext } from '@/api/client/encryptionKey';
import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { encodeBase64 } from '@/api/encryption';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import {
  resolveSessionSnapshotRequestPurpose,
  type SessionSnapshotRefreshReason,
} from '@/api/session/sessionSnapshotRefreshReason';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

export type RawSessionRecord = V2SessionByIdResponse['session'];
export type RawSessionListRow = V2SessionListResponse['sessions'][number];
export type SessionLookupByTagsHttpResult =
  | Readonly<{
      state: 'available';
      tags: readonly string[];
      sessions: SessionLookupByTagsResponseV2['sessions'];
    }>
  | Readonly<{ state: 'unavailable' }>;

export async function fetchSessionTurnsProjection(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<SessionTurnsProjectionV1 | null> {
  const path = `/v1/sessions/${encodeSessionIdPathSegment(params.sessionId)}/turns`;
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });
  if (response.status === 404) return null;
  if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
  if (response.status < 200 || response.status >= 300) {
    throwUnexpectedStatusError(path, response.status);
  }
  const parsed = SessionTurnsProjectionV1Schema.safeParse(response.data);
  return parsed.success && parsed.data.sessionId === params.sessionId ? parsed.data : null;
}

function parseOrThrow<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, payload: unknown, message: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success || !parsed.data) {
    throw new Error(message);
  }
  return parsed.data;
}

function encodeSessionIdPathSegment(sessionId: string): string {
  return encodeURIComponent(String(sessionId ?? ''));
}

function throwAuthenticationStatusError(status: number, message = `Unauthorized (${status})`): never {
  throw createHttpStatusError(status, message, 'not_authenticated');
}

function throwUnexpectedStatusError(path: string, status: number): never {
  throw createHttpStatusError(status, `Unexpected status from ${path}: ${status}`);
}

type SessionByIdHttpResponse = AxiosResponse<unknown>;

const sessionByIdInFlightRequests = new Map<string, Promise<SessionByIdHttpResponse>>();

function buildSessionByIdInFlightKey(params: Readonly<{
  serverUrl: string;
  token: string;
  encodedSessionId: string;
  requestPurpose: string;
}>): string {
  return [params.serverUrl, params.token, params.encodedSessionId, params.requestPurpose].join('\u0000');
}

async function getSessionByIdResponse(params: Readonly<{
  token: string;
  sessionId: string;
  reason?: SessionSnapshotRefreshReason;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<SessionByIdHttpResponse> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const requestPurpose = resolveSessionSnapshotRequestPurpose(params.reason);
  const deadlineRemainingMs = params.deadlineAtMs === undefined
    ? null
    : Math.floor(params.deadlineAtMs - Date.now());
  if (params.signal?.aborted || (deadlineRemainingMs !== null && deadlineRemainingMs <= 0)) {
    const error = new Error('Session lookup was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  if (params.signal || deadlineRemainingMs !== null) {
    return await axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
        'X-Happier-Request-Purpose': requestPurpose,
      },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: deadlineRemainingMs
        ?? configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    });
  }
  const key = buildSessionByIdInFlightKey({
    serverUrl,
    token: params.token,
    encodedSessionId,
    requestPurpose,
  });
  const existing = sessionByIdInFlightRequests.get(key);
  if (existing) return await existing;

  const promise = axios.get(`${serverUrl}/v2/sessions/${encodedSessionId}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'X-Happier-Request-Purpose': requestPurpose,
    },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });
  sessionByIdInFlightRequests.set(key, promise);
  try {
    return await promise;
  } finally {
    if (sessionByIdInFlightRequests.get(key) === promise) {
      sessionByIdInFlightRequests.delete(key);
    }
  }
}

export async function fetchSessionById(params: Readonly<{
  token: string;
  sessionId: string;
  reason?: SessionSnapshotRefreshReason;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<RawSessionRecord | null> {
  const response = await getSessionByIdResponse(params);

  if (response.status === 404) return null;
  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, response.status);
  }

  return parseOrThrow<V2SessionByIdResponse>(V2SessionByIdResponseSchema, response.data, 'Unexpected /v2/sessions response shape').session;
}

export async function lookupSessionsByTags(params: Readonly<{
  token: string;
  tags: readonly string[];
  signal?: AbortSignal;
  deadlineAtMs?: number;
}>): Promise<SessionLookupByTagsHttpResult> {
  const request = parseOrThrow(
    SessionLookupByTagsRequestV2Schema,
    { tags: [...params.tags] },
    'Invalid /v2/sessions/lookup-by-tags request',
  );
  const remainingMs = params.deadlineAtMs === undefined
    ? configuration.sessionControlHttpTimeoutMs
    : Math.floor(params.deadlineAtMs - Date.now());
  if (params.signal?.aborted || remainingMs <= 0) {
    const error = new Error('Session lookup by tags was cancelled');
    error.name = 'AbortError';
    throw error;
  }

  const path = '/v2/sessions/lookup-by-tags';
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${path}`,
    request,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: remainingMs,
      validateStatus: () => true,
    },
  );
  if (
    response.status === 404
    && looksLikeMissingSessionLookupByTagsRoute404(response.data)
  ) {
    return { state: 'unavailable' };
  }
  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(path, response.status);
  }
  const parsed = parseOrThrow(
    SessionLookupByTagsResponseV2Schema,
    response.data,
    'Unexpected /v2/sessions/lookup-by-tags response shape',
  );
  return {
    state: 'available',
    tags: request.tags,
    sessions: parsed.sessions,
  };
}

function looksLikeMissingSessionLookupByTagsRoute404(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const statusCode = record.statusCode;
  const error = record.error;
  const message = typeof record.message === 'string' ? record.message : '';
  return statusCode === 404
    && error === 'Not Found'
    && message === 'Route POST:/v2/sessions/lookup-by-tags not found';
}

function looksLikeMissingV2SessionRoute404(data: unknown, sessionId: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const anyData = data as any;
  const error = typeof anyData.error === 'string' ? anyData.error : '';
  const path = typeof anyData.path === 'string' ? anyData.path : '';
  const message = typeof anyData.message === 'string' ? anyData.message : '';
  if (error !== 'Not found') return false;
  const rawNeedle = `/v2/sessions/${sessionId}`;
  const encodedNeedle = `/v2/sessions/${encodeSessionIdPathSegment(sessionId)}`;
  return (
    (path && (path.includes(rawNeedle) || path.includes(encodedNeedle)))
    || (message && (message.includes(rawNeedle) || message.includes(encodedNeedle)))
  );
}

export async function fetchSessionByIdCompat(params: Readonly<{ token: string; sessionId: string; reason?: SessionSnapshotRefreshReason }>): Promise<RawSessionRecord | null> {
  const response = await getSessionByIdResponse(params);

  if (response.status === 404) {
    if (!looksLikeMissingV2SessionRoute404(response.data, params.sessionId)) return null;

    let cursor: string | undefined = undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const res = await fetchSessionsPage({ token: params.token, cursor, limit: 200 });
      const match = res.sessions.find((row) => (row as any) && String((row as any).id ?? '') === params.sessionId);
      if (match) return match as unknown as RawSessionRecord;
      if (!res.hasNext || !res.nextCursor) return null;
      if (seenCursors.has(res.nextCursor)) return null;
      seenCursors.add(res.nextCursor);
      cursor = res.nextCursor;
    }
  }
  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, response.status);
  }

  return parseOrThrow<V2SessionByIdResponse>(V2SessionByIdResponseSchema, response.data, 'Unexpected /v2/sessions response shape').session;
}

export async function patchSessionMetadata(params: Readonly<{
  token: string;
  sessionId: string;
  ciphertext: string;
  expectedVersion: number;
  sessionExpectation?: SessionMetadataInactiveModelIntentExpectationV1;
}>): Promise<
  | Readonly<{ success: true; version: number }>
  | Readonly<{ success: false; error: 'session_active' }>
  | Readonly<{ success: false; error: 'version-mismatch'; current: { version: number; value: string | null } }>
> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const metadata = {
    ciphertext: params.ciphertext,
    expectedVersion: params.expectedVersion,
  };
  const requestBody = params.sessionExpectation
    ? {
        inactiveModelIntent: {
          metadata,
          sessionExpectation: params.sessionExpectation,
        },
      } satisfies SessionMetadataInactiveModelIntentPatchV1
    : { metadata };
  const response = await axios.patch(
    `${serverUrl}/v2/sessions/${encodedSessionId}`,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 404) {
    const error = new Error('Session not found');
    (error as { code?: string }).code = 'session_not_found';
    throw error;
  }
  if (response.status === 400 && params.sessionExpectation) {
    throw Object.assign(
      new Error(
        'Inactive Session model intent requires a compatible server',
      ),
      {
        code: 'metadata_privacy_upgrade_required' as const,
        retryable: false as const,
      },
    );
  }
  if (response.status === 409) {
    const activeConflict =
      SessionMetadataActiveConflictV1Schema.safeParse(response.data);
    if (activeConflict.success) {
      return {
        success: false,
        error: 'session_active',
      };
    }
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, 409);
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, response.status);
  }

  const data = response.data;
  if (params.sessionExpectation) {
    const success =
      SessionMetadataInactiveModelIntentPatchSuccessV1Schema.safeParse(data);
    if (success.success) {
      return {
        success: true,
        version: success.data.metadata.version,
      };
    }
    const conflict =
      SessionMetadataInactiveModelIntentVersionConflictV1Schema.safeParse(
        data,
      );
    if (conflict.success) {
      return {
        success: false,
        error: 'version-mismatch',
        current: conflict.data.metadata,
      };
    }
    throw new Error(
      `Unexpected /v2/sessions/${params.sessionId} conditioned patch response shape`,
    );
  }
  if (data && typeof data === 'object') {
    const body = data as {
      success?: unknown;
      error?: unknown;
      metadata?: { version?: unknown; value?: unknown };
    };
    if (body.success === true && typeof body.metadata?.version === 'number' && Number.isFinite(body.metadata.version)) {
      return { success: true, version: body.metadata.version };
    }
    if (
      body.success === false
      && body.error === 'version-mismatch'
      && typeof body.metadata?.version === 'number'
      && Number.isFinite(body.metadata.version)
      && (typeof body.metadata.value === 'string' || body.metadata.value === null)
    ) {
      return {
        success: false,
        error: 'version-mismatch',
        current: {
          version: body.metadata.version,
          value: body.metadata.value,
        },
      };
    }
  }

  throw new Error(`Unexpected /v2/sessions/${params.sessionId} patch response shape`);
}

export type PatchSessionMetadataEnvelopeTupleResult =
  | Readonly<{
      success: true;
      metadataLayoutVersion: 1;
      sharedMetadata: Readonly<{ version: number }>;
      agentState?: Readonly<{ version: number }>;
    }>
  | Readonly<{
      success: false;
      error: 'session_active';
    }>
  | Readonly<{
      success: false;
      error: 'session_metadata_version_conflict';
      metadataLayoutVersion: 1;
      sharedMetadata: Readonly<{ version: number }>;
      agentState?: Readonly<{ version: number }>;
    }>;

/**
 * The single HTTP transport adapter for layout-v1 owner tuple mutations.
 *
 * It deliberately does not retry and does not translate transport ambiguity
 * into a legacy metadata/socket write. The mutation owner decides whether an
 * explicit 409 can be retried after an authoritative owner by-id refetch.
 */
export async function patchSessionMetadataEnvelopeTuple(params: Readonly<{
  token: string;
  sessionId: string;
  patch:
    | SessionMetadataTuplePatchV1
    | SessionMetadataInactiveModelIntentOwnerPatchV1;
}>): Promise<PatchSessionMetadataEnvelopeTupleResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const response = await axios.patch(
    `${serverUrl}/v2/sessions/${encodedSessionId}`,
    params.patch,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 404) {
    const error = Object.assign(new Error('Session not found'), {
      code: 'session_not_found' as const,
    });
    throw error;
  }
  if (response.status === 400) {
    // Exact released v0.2.1 behavior: its legacy PATCH schema strips the
    // layout-v1 tuple fields, then rejects the empty body with 400. At this
    // tuple-only boundary that response is an unsupported-peer result, never
    // authority to retry through the layout-0 socket/metadata path.
    throw Object.assign(
      new Error('Session metadata requires a privacy-compatible server'),
      {
        code: 'metadata_privacy_upgrade_required' as const,
        retryable: false as const,
      },
    );
  }

  const body = response.data && typeof response.data === 'object'
    && !Array.isArray(response.data)
      ? response.data as Record<string, unknown>
      : null;
  if (params.patch.mode === 'owner_migration') {
    if (
      response.status === 409
      && body
      && Object.keys(body).length === 2
      && body.error === 'Session metadata privacy upgrade required'
      && body?.code === 'metadata_privacy_upgrade_required'
    ) {
      throw Object.assign(
        new Error('Session metadata requires a privacy-compatible client'),
        {
          code: 'metadata_privacy_upgrade_required' as const,
          retryable: false as const,
        },
      );
    }
    throw new Error(
      `Unexpected /v2/sessions/${params.sessionId} owner-migration refusal response shape`,
    );
  }
  if (response.status === 409) {
    const activeConflict =
      SessionMetadataActiveConflictV1Schema.safeParse(body);
    if (activeConflict.success) {
      return {
        success: false,
        error: 'session_active',
      };
    }
    if (body?.code === 'metadata_privacy_upgrade_required') {
      throw Object.assign(
        new Error('Session metadata requires a privacy-compatible client'),
        {
          code: 'metadata_privacy_upgrade_required' as const,
          retryable: false as const,
        },
      );
    }
    if (body?.code !== 'session_metadata_version_conflict') {
      throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, 409);
    }
    const current =
      SessionMetadataVersionConflictV1Schema.safeParse(body);
    if (!current.success) {
      throw new Error(
        `Unexpected /v2/sessions/${params.sessionId} tuple conflict response shape`,
      );
    }
    return {
      success: false,
      error: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1,
      sharedMetadata: current.data.sharedMetadata,
      ...(current.data.agentState
        ? { agentState: current.data.agentState }
        : {}),
    };
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, response.status);
  }

  const success = SessionMetadataTuplePatchSuccessV1Schema.safeParse(body);
  if (!success.success) {
    throw new Error(
      `Unexpected /v2/sessions/${params.sessionId} tuple patch response shape`,
    );
  }
  return {
    ...success.data,
  };
}

export async function fetchSessionsPage(params: Readonly<{
  token: string;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
  archivedOnly?: boolean;
}>): Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}> {
  const serverUrl = resolveServerHttpBaseUrl();
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;

  if (params.activeOnly && params.archivedOnly) {
    throw new Error('Cannot combine activeOnly and archivedOnly');
  }

  const path = params.activeOnly ? '/v2/sessions/active' : params.archivedOnly ? '/v2/sessions/archived' : '/v2/sessions';
  const response = await axios.get(`${serverUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: params.activeOnly
      ? { ...(limit ? { limit } : {}) }
      : { ...(params.cursor ? { cursor: params.cursor } : {}), ...(limit ? { limit } : {}) },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(path, response.status);
  }

  const parsed = parseOrThrow<V2SessionListResponse>(
    V2SessionListResponseSchema,
    response.data,
    `Unexpected ${path} response shape`,
  );

  if (!Array.isArray(parsed.sessions)) {
    throw new Error(`Unexpected ${path} response shape`);
  }

  return {
    sessions: parsed.sessions,
    nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
    hasNext: Boolean(parsed.hasNext),
  };
}

export async function commitSessionEncryptedMessage(params: Readonly<{
  token: string;
  sessionId: string;
  ciphertext: string;
  localId: string;
}>): Promise<{ didWrite: boolean; messageId: string; seq: number; createdAt: number }> {
  return await commitSessionStoredMessage({
    token: params.token,
    sessionId: params.sessionId,
    content: { t: 'encrypted', c: params.ciphertext },
    localId: params.localId,
  });
}

export async function commitSessionStoredMessage(params: Readonly<{
  token: string;
  sessionId: string;
  content: SessionStoredMessageContent;
  localId: string;
  messageRole?: 'user' | 'agent' | 'event' | 'unknown';
  attentionImpact?: SessionMessageAttentionImpact;
}>): Promise<{ didWrite: boolean; messageId: string; seq: number; createdAt: number }> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const attentionImpact = params.attentionImpact ?? agentEventLocalIdAttentionImpact(params.localId);
  const response = await axios.post(`${serverUrl}/v2/sessions/${encodedSessionId}/messages`, {
    content: params.content,
    localId: params.localId,
    ...(params.messageRole ? { messageRole: params.messageRole } : {}),
    ...(attentionImpact ? { attentionImpact } : {}),
  }, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': params.localId,
    },
    timeout: 20_000,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 404) {
    const err = new Error('Session not found');
    (err as any).code = 'session_not_found';
    throw err;
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}/messages: ${response.status}`);
  }

  const parsed = parseOrThrow(
    V2SessionMessageResponseSchema,
    response.data,
    `Unexpected /v2/sessions/${params.sessionId}/messages response shape`,
  );

  return {
    didWrite: parsed.didWrite,
    messageId: String(parsed.message?.id ?? ''),
    seq: Number(parsed.message?.seq ?? 0),
    createdAt: Number(parsed.message?.createdAt ?? 0),
  };
}

export async function getOrCreateSessionByTag(params: Readonly<{
  credentials: Credentials;
  tag: string;
  metadata: Record<string, unknown>;
  agentState: Record<string, unknown> | null;
  currentStorageState?: 'machine_only';
  shouldCommit?: () => boolean;
}>): Promise<{ session: RawSessionRecord; created: boolean }> {
  const serverUrl = resolveServerHttpBaseUrl();

  const { desiredSessionEncryptionMode, serverSupportsFeatureSnapshot } = await resolveSessionCreateEncryptionMode({
    token: params.credentials.token,
    serverBaseUrl: serverUrl,
  });

  const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveSessionEncryptionContext(params.credentials);

  const metadataEnvelopeFields = buildSessionMetadataEnvelopeCreateFields({
    credentials: params.credentials,
    metadata: params.metadata,
    agentState: params.agentState,
    storedContentMode: desiredSessionEncryptionMode,
    encryptionKey,
    encryptionVariant,
  });

  const dataEncryptionKeyPayload =
    desiredSessionEncryptionMode === 'plain'
      ? null
      : dataEncryptionKey
        ? encodeBase64(dataEncryptionKey)
        : null;

  if (params.shouldCommit && !params.shouldCommit()) {
    throw new Error('Session creation commit precondition failed');
  }
  const response = await axios.post(`${serverUrl}/v1/sessions`, {
    tag: params.tag,
    ...metadataEnvelopeFields,
    dataEncryptionKey: dataEncryptionKeyPayload,
    ...(params.currentStorageState ? { currentStorageState: params.currentStorageState } : {}),
    ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
  }, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 60_000,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions: ${response.status}`);
  }

  const parsed = parseOrThrow<V2SessionByIdResponse>(
    V2SessionByIdResponseSchema,
    response.data,
    'Unexpected /v1/sessions response shape',
  );
  if (!parsed || !parsed.session || typeof parsed.session !== 'object') {
    throw new Error('Unexpected /v1/sessions response shape');
  }
  // Released and predecessor servers omit `created`; preserve their historical
  // create-or-load behavior while current servers report the exact race result.
  return { session: parsed.session, created: parsed.created !== false };
}

async function postArchiveMutation(params: Readonly<{
  token: string;
  sessionId: string;
  op: 'archive' | 'unarchive';
}>): Promise<{ archivedAt: number | null }> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(
    `${serverUrl}/v2/sessions/${params.sessionId}/${params.op}`,
    {},
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 404) {
    const err = new Error('Session not found');
    (err as any).code = 'session_not_found';
    throw err;
  }
  if (response.status === 409 && params.op === 'archive') {
    const err = new Error('Cannot archive an active session');
    (err as any).code = 'session_active';
    throw err;
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/${params.sessionId}/${params.op}: ${response.status}`);
  }

  const ok = response.data && typeof response.data === 'object' && (response.data as any).success === true;
  if (!ok) {
    throw new Error(`Unexpected /v2/sessions/${params.sessionId}/${params.op} response shape`);
  }

  const archivedAt = (response.data as any).archivedAt;
  if (archivedAt === null) return { archivedAt: null };
  if (typeof archivedAt === 'number' && Number.isFinite(archivedAt) && archivedAt >= 0) return { archivedAt };
  throw new Error(`Unexpected /v2/sessions/${params.sessionId}/${params.op} response shape`);
}

export async function archiveSession(params: Readonly<{ token: string; sessionId: string }>): Promise<{ archivedAt: number }> {
  const res = await postArchiveMutation({ token: params.token, sessionId: params.sessionId, op: 'archive' });
  if (typeof res.archivedAt !== 'number') {
    throw new Error('Unexpected archive response (archivedAt is null)');
  }
  return { archivedAt: res.archivedAt };
}

export async function unarchiveSession(params: Readonly<{ token: string; sessionId: string }>): Promise<{ archivedAt: null }> {
  const res = await postArchiveMutation({ token: params.token, sessionId: params.sessionId, op: 'unarchive' });
  if (res.archivedAt !== null) {
    throw new Error('Unexpected unarchive response (archivedAt is not null)');
  }
  return { archivedAt: null };
}
