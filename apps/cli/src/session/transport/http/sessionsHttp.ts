import axios, { type AxiosResponse } from 'axios';
import { readActionCredentialScopeDeniedHttpFailureV1, type ActionCredentialScopeDeniedFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { classifyHomeDomainHttpMutationFailureV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { readSessionCreationInitialTriggerError } from '@/api/session/sessionCreationInitialTriggerError';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { z } from 'zod/mini';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { agentEventLocalIdAttentionImpact } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import type { SessionMessageAttentionImpact, SessionStoredMessageContent, V2SessionByIdResponse, V2SessionListResponse, SessionLookupByTagsResponseV2, SessionMetadataInactiveModelIntentExpectationV1, SessionMetadataInactiveModelIntentOwnerPatchV1, SessionMetadataInactiveModelIntentPatchV1, SessionMetadataTuplePatchV1, SessionOrganizationPlacementV1, SessionTurnsProjectionV1, AccountEncryptionCurrentnessResponse, SessionListQueryV1, SessionListQueryResponseV1, SessionListUnavailableQueryV1, SessionInitialAccessDraftV1, SessionAttentionSetResultV1, SessionManagerSetActionInputV1, SessionManagerSetResultV1, SessionManagerV1 } from '@happier-dev/protocol';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS, SessionTranscriptSurfaceItemReferenceInputV1Schema, type SessionTranscriptSurfaceItemReferenceInputV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { SessionLookupByTagsRequestV2Schema, SessionLookupByTagsResponseV2Schema, V2SessionByIdResponseSchema, V2SessionListResponseSchema, V2SessionMessageResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SessionMetadataActiveConflictV1Schema, SessionMetadataInactiveModelIntentPatchSuccessV1Schema, SessionMetadataInactiveModelIntentVersionConflictV1Schema, SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { buildSessionOrganizationAssignmentSnapshotHttpRequestV1, SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } from '@happier-dev/protocol/sessions/organization/constants';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionListQueryResponseV1Schema, SessionCurrentProjectionRecordV1Schema,
  SessionRuntimeManagedSubtreeListResponseV1Schema, SessionRuntimeManagedSubtreeSnapshotRecordV1Schema,
  type SessionRuntimeManagedSubtreeListResponseV1 } from '@happier-dev/protocol/sessions/listing/response';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema,
  type SessionReadBatchResponseV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { buildSessionListServerQueryV1, SessionListUnavailableQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { SessionAttentionSetResultV1Schema, buildSessionAttentionStandingHttpPath } from '@happier-dev/protocol/sessions/organization/attentionAction';
import { SetSessionPinRequestSchema, SetSessionPinResponseSchema, type SetSessionPinRequest, type SetSessionPinResponse } from '@happier-dev/protocol/sessions/organization/mutations';
import { buildSessionOrganizationPinHttpPathV1 } from '@happier-dev/protocol/sessions/organization/pins';
import { SessionManagerSetActionInputV1Schema, SessionManagerSetResultV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { SessionTeamCredentialBindingMutationRejectionV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import type { SessionTeamCredentialBindingIntentV1, SessionTeamCredentialBindingIntentListV1, SessionTeamCredentialBindingMetadataPatchV1, SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams';

import type { StoredCredentials } from '@/persistence';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveSessionEncryptionContext } from '@/api/client/encryptionKey';
import { createHttpStatusError, HttpStatusError, isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { encodeBase64 } from '@/api/encryption';
import {
  buildCurrentAccountStoredContentCompatibilityHttpHeaders,
  readCliClientUpgradeRequired,
} from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { resolveSessionStoredContentEncryptionMode, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';
import {
  resolveSessionSnapshotRequestPurpose,
  type SessionSnapshotRefreshReason,
} from '@/api/session/sessionSnapshotRefreshReason';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import {
  addSessionInitialAccessTeamShareStatement,
  buildSessionInitialAccessCreateFields,
  materializeSessionInitialAccessCreateFields,
  prepareSessionInitialAccessDataKeyEnvelopes,
  readSessionTeamCredentialBindingUpdateRequiredError,
  readSessionInitialAccessServerError,
} from '@/api/session/sessionCreationInitialAccess';

export type RawSessionRecord = V2SessionByIdResponse['session'];

/** Personal pin writes use the Account HTTP owner, without waking a Session host. */
export async function setSessionOrganizationPin(params: Readonly<{
  token: string;
  sessionId: string;
  request: SetSessionPinRequest;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'PUT'; path: string; body: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SetSessionPinResponse | ActionCredentialScopeDeniedFailureV1 | Readonly<{
  ok: false; errorCode: 'session_not_found' | 'session_pin_limit_exceeded' | 'unsupported_action'; error: string;
}>> {
  const path = buildSessionOrganizationPinHttpPathV1(params.sessionId);
  const body = SetSessionPinRequestSchema.parse(params.request);
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'PUT', path, body })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.put(`${resolveServerHttpBaseUrl()}${path}`, body, {
    headers: { ...authorizationHeaders, 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });
  const payload: unknown = response.data;
  const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, payload);
  if (scopeDenial) return scopeDenial;
  const error = payload !== null && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
  if (response.status === 404) {
    const errorCode = error === 'Session not found' ? 'session_not_found' : 'unsupported_action';
    return { ok: false, errorCode, error: errorCode };
  }
  if (response.status === 409 && error === 'session-pin-limit-exceeded') {
    return { ok: false, errorCode: 'session_pin_limit_exceeded', error: 'session_pin_limit_exceeded' };
  }
  if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
  if (response.status !== 200) throwUnexpectedStatusError(path, response.status);
  const result = SetSessionPinResponseSchema.safeParse(response.data);
  if (!result.success) throw new Error('Unexpected Session pin response shape');
  return result.data;
}

export async function setSessionManager(params: SessionManagerSetActionInputV1 & Readonly<{
  token: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'POST'; path: string; body: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SessionManagerSetResultV1 | ActionCredentialScopeDeniedFailureV1> {
  const request = SessionManagerSetActionInputV1Schema.parse({
    sessionId: params.sessionId, managerSessionId: params.managerSessionId, expectedManagerSessionId: params.expectedManagerSessionId,
  });
  const path = `/v1/sessions/${encodeSessionIdPathSegment(request.sessionId)}/manager`;
  const body = { managerSessionId: request.managerSessionId, expectedManagerSessionId: request.expectedManagerSessionId };
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'POST', path, body })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
    headers: { ...authorizationHeaders, 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });
  const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, response.data);
  if (scopeDenial) return scopeDenial;
  const result = SessionManagerSetResultV1Schema.safeParse(response.data);
  if (result.success) {
    const expectedStatus = result.data.ok ? 200 : result.data.error === 'manager_cycle' ? 400
      : result.data.error === 'manager_cas_conflict' ? 409 : 403;
    if (response.status !== expectedStatus) throwUnexpectedStatusError(path, response.status);
    if (result.data.ok && (result.data.sessionId !== request.sessionId || result.data.managerSessionId !== request.managerSessionId)) {
      throw new Error('Unexpected manager attachment response');
    }
    return result.data;
  }
  if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
  if (response.status !== 200) throwUnexpectedStatusError(path, response.status);
  throw new Error('Unexpected manager response shape');
}
/**
 * `session.attention.set` (ORC R-10) over the existing attention-standing route. The server route is
 * the only writer; a 404 is the route's own "session not found", anything else unexpected throws.
 */
export async function setSessionAttentionStanding(params: Readonly<{
  token: string;
  sessionId: string;
  request: Readonly<{ standing?: boolean | null; remindAt?: number | null }>;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'PUT'; path: string; body: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SessionAttentionSetResultV1 | ActionCredentialScopeDeniedFailureV1 | Readonly<{ ok: false; errorCode: 'session_not_found'; error: 'session_not_found' }>> {
  const path = buildSessionAttentionStandingHttpPath(params.sessionId);
  const body = params.request;
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'PUT', path, body })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.put(`${resolveServerHttpBaseUrl()}${path}`, body, {
    headers: { ...authorizationHeaders, 'Content-Type': 'application/json' },
    ...(params.signal ? { signal: params.signal } : {}),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });
  const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, response.data);
  if (scopeDenial) return scopeDenial;
  if (response.status === 404) return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
  if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
  if (response.status !== 200) throwUnexpectedStatusError(path, response.status);
  const result = SessionAttentionSetResultV1Schema.safeParse(response.data);
  if (!result.success) throw new Error('Unexpected attention standing response shape');
  return result.data;
}
/** Opened-list consumers require full snapshots; compact wire rows have a separate type. */
export type RawSessionListRow = RawSessionRecord;
export type RawCompactSessionListRow = V2SessionListResponse['sessions'][number];
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
  projection?: 'externalShareableV1';
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET'; path: string }>) => Readonly<Record<string, string>> | null;
}>): Promise<SessionTurnsProjectionV1 | null> {
  const path = `/v1/sessions/${encodeSessionIdPathSegment(params.sessionId)}/turns`;
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...authorizationHeaders,
      'Content-Type': 'application/json',
    },
    ...(params.projection ? { params: { projection: params.projection } } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
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

class SessionListQueryHttpError extends HttpStatusError {
  readonly retryable = false;

  constructor(
    readonly code: SessionListUnavailableQueryV1['code'],
    readonly details: SessionListUnavailableQueryV1,
  ) {
    super(404, code);
    this.name = 'SessionListQueryHttpError';
  }
}

type SessionByIdHttpResponse = AxiosResponse<unknown>;

function parseSessionDetailSchema<T>(schema: z.ZodMiniType<T>, payload: unknown, schemaName: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Keep only structural diagnostics. Zod messages/inputs can contain private values.
    const issues = parsed.error.issues.map(({ path, code }) => ({ path, code }));
    throw Object.assign(
      new Error(`Unexpected /v2/sessions response shape (${schemaName}: ${issues.map(({ path, code }) => `${path.join('.') || '<root>'}: ${code}`).join(', ')})`),
      { code: 'session_detail_invalid_response', schema: schemaName, issues },
    );
  }
  return parsed.data;
}

function throwSessionDetailProjectionUnavailable(): never {
  throw createHttpStatusError(
    404,
    'The server does not provide the requested /v2/sessions current detail projection',
    'session_detail_projection_unavailable',
  );
}

function parseSessionByIdResponse(
  payload: unknown,
  accessProjectionVersion: 1 | undefined,
): RawSessionRecord {
  const session = parseSessionDetailSchema(
    V2SessionByIdResponseSchema,
    payload,
    'v2_session_detail',
  ).session;
  if (accessProjectionVersion === 1) {
    return parseSessionDetailSchema(
      SessionCurrentProjectionRecordV1Schema,
      session,
      'current_access_projection_v1',
    );
  }
  return session;
}

/**
 * Selects the current detail projection only from the feature snapshot already bound to the
 * request's exact Home. Missing, malformed and unsupported snapshots retain the released bare
 * owner/direct request; this helper never probes or consults ambient active-Home state.
 */
export function resolveSessionDetailAccessProjectionVersion(params: Readonly<{
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  env?: NodeJS.ProcessEnv;
}>): 1 | undefined {
  if (!params.serverFeaturesSnapshot) return undefined;
  return resolveCliFeatureDecision({
    featureId: 'sharing.session',
    env: params.env ?? process.env,
    serverSnapshot: params.serverFeaturesSnapshot,
  }).state === 'enabled'
    ? 1
    : undefined;
}

function resolveRequestedSessionDetailAccessProjectionVersion(params: Readonly<{
  accessProjectionVersion?: 1;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): 1 | undefined {
  return params.accessProjectionVersion
    ?? resolveSessionDetailAccessProjectionVersion({
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
}

const sessionByIdInFlightRequests = new Map<string, Promise<SessionByIdHttpResponse>>();

function buildSessionByIdInFlightKey(params: Readonly<{
  serverUrl: string;
  token: string;
  encodedSessionId: string;
  requestPurpose: string;
  accessProjectionVersion?: 1;
}>): string {
  return [
    params.serverUrl,
    params.token,
    params.encodedSessionId,
    params.requestPurpose,
    String(params.accessProjectionVersion ?? ''),
  ].join('\u0000');
}

async function getSessionByIdResponse(params: Readonly<{
  token: string;
  authorizationHeaders?: Readonly<Record<string, string>>;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET'; path: string;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  serverUrl?: string;
  reason?: SessionSnapshotRefreshReason;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  accessProjectionVersion?: 1;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<SessionByIdHttpResponse> {
  const serverUrl = params.serverUrl ?? resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const accessProjectionVersion = resolveRequestedSessionDetailAccessProjectionVersion(params);
  const sessionDetailUrl = `${serverUrl}/v2/sessions/${encodedSessionId}${accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`;
  const requestPath = `/v2/sessions/${encodedSessionId}${accessProjectionVersion === 1 ? '?accessProjectionVersion=1' : ''}`;
  const resolvedAuthorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath })
    ?? (params.resolveAuthorizationHeaders ? null : params.authorizationHeaders);
  if (params.resolveAuthorizationHeaders && !resolvedAuthorizationHeaders) {
    throw new Error('External Action authorization unavailable');
  }
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
    return await axios.get(sessionDetailUrl, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...(resolvedAuthorizationHeaders ?? { Authorization: `Bearer ${params.token}` }),
        'Content-Type': 'application/json',
        'X-Happier-Request-Purpose': requestPurpose,
      },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: deadlineRemainingMs
        ?? configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    });
  }
  if (resolvedAuthorizationHeaders) {
    return await axios.get(sessionDetailUrl, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...resolvedAuthorizationHeaders,
        'Content-Type': 'application/json',
        'X-Happier-Request-Purpose': requestPurpose,
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    });
  }
  const key = buildSessionByIdInFlightKey({
    serverUrl,
    token: params.token,
    encodedSessionId,
    requestPurpose,
    accessProjectionVersion,
  });
  const existing = sessionByIdInFlightRequests.get(key);
  if (existing) return await existing;

  const promise = axios.get(sessionDetailUrl, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
  authorizationHeaders?: Readonly<Record<string, string>>;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET'; path: string;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  serverUrl?: string;
  reason?: SessionSnapshotRefreshReason;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  /** Require the complete current projection; unsupported Homes fail rather than falling back. */
  accessProjectionVersion?: 1;
  /** Exact Home snapshot already owned by the caller's runtime/connection; never fetched here. */
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<RawSessionRecord | null> {
  const accessProjectionVersion = resolveRequestedSessionDetailAccessProjectionVersion(params);
  const response = await getSessionByIdResponse({ ...params, accessProjectionVersion });

  if (response.status === 404) {
    if (
      accessProjectionVersion === 1
      && looksLikeMissingV2SessionRoute404(response.data, params.sessionId)
    ) {
      throwSessionDetailProjectionUnavailable();
    }
    return null;
  }
  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 426) {
    const upgradeRequired = readCliClientUpgradeRequired(response.data);
    if (
      upgradeRequired?.requirement
      && 'kind' in upgradeRequired.requirement
      && upgradeRequired.requirement.kind === 'account-stored-content'
    ) {
      throw Object.assign(
        new Error('Session access requires a stored-content-compatible server'),
        {
          code: 'client-upgrade-required' as const,
          retryable: false as const,
          requirement: upgradeRequired.requirement,
        },
      );
    }
  }
  if (response.status !== 200) {
    throwUnexpectedStatusError(`/v2/sessions/${params.sessionId}`, response.status);
  }

  return parseSessionByIdResponse(response.data, accessProjectionVersion);
}

export async function lookupSessionsByTags(params: Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'POST'; path: string; body: unknown;
  }>) => Readonly<Record<string, string>> | null;
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
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({
    method: 'POST', path, body: request,
  }) ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${path}`,
    request,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...authorizationHeaders,
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

/**
 * Reads the mutable presentation placement for an already-created Session.
 * Immutable creation correspondence is deliberately not consulted here:
 * organization edits remain valid after a create-or-rejoin winner is chosen.
 */
export async function fetchSessionOrganizationPlacement(params: Readonly<{
  token: string;
  sessionId: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  resolveAuthorizationHeaders?: SessionOrganizationPlacementsHttpParams['resolveAuthorizationHeaders'];
}>): Promise<SessionOrganizationPlacementV1> {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    throw new Error('Session organization placement requires a Session id');
  }
  const placements = await fetchSessionOrganizationPlacements({ ...params, sessionIds: [sessionId] });
  return placements.get(sessionId)!;
}

type SessionOrganizationPlacementsHttpParams = Readonly<{
  token: string;
  sessionIds: readonly string[];
  signal?: AbortSignal;
  deadlineAtMs?: number;
  serverHttpBaseUrl?: string;
  resolveAuthorizationHeaders?: (request: ReturnType<typeof buildSessionOrganizationAssignmentSnapshotHttpRequestV1>) => Readonly<Record<string, string>> | null;
}>;

type SessionOrganizationPlacementBatch =
  | Readonly<{ ok: true; placements: ReadonlyMap<string, SessionOrganizationPlacementV1> }>
  | Readonly<{ ok: false; error: unknown }>;

/** One assignment transport; optional list facts retain successful batches when another is unavailable. */
export async function* fetchSessionOrganizationPlacementBatches(
  params: SessionOrganizationPlacementsHttpParams,
): AsyncGenerator<SessionOrganizationPlacementBatch> {
  const sessionIds = [...new Set(params.sessionIds.map(id => id.trim()).filter(Boolean))];
  for (let offset = 0; offset < sessionIds.length; offset += SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS) {
    const remainingMs = params.deadlineAtMs === undefined
      ? configuration.sessionControlHttpTimeoutMs
      : Math.floor(params.deadlineAtMs - Date.now());
    if (params.signal?.aborted || remainingMs <= 0) {
      const error = new Error('Session organization placement lookup was cancelled');
      error.name = 'AbortError';
      throw error;
    }
    try {
      const ids = sessionIds.slice(offset, offset + SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS);
      const request = buildSessionOrganizationAssignmentSnapshotHttpRequestV1(ids);
      const authorizationHeaders = params.resolveAuthorizationHeaders
        ? params.resolveAuthorizationHeaders(request) : { Authorization: `Bearer ${params.token}` };
      if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
      const response = await axios.get(`${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${request.path}`, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          ...authorizationHeaders,
          'Content-Type': 'application/json',
        },
        ...(params.signal ? { signal: params.signal } : {}),
        timeout: remainingMs,
        validateStatus: () => true,
      });
      if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
      if (response.status !== 200) throwUnexpectedStatusError(request.path, response.status);
      const snapshot = parseOrThrow(SessionOrganizationSnapshotResponseSchema, response.data,
        'Unexpected /v2/session-organization response shape').snapshot;
      const folders = new Map<string, string>();
      for (const assignment of snapshot.folderAssignments) {
        if (folders.has(assignment.sessionId)) throw new Error('Unexpected duplicate Session organization placement assignments');
        folders.set(assignment.sessionId, assignment.folderId);
      }
      const tags = new Map<string, string[]>();
      for (const assignment of snapshot.tagAssignments) {
        if (tags.has(assignment.sessionId)) throw new Error('Unexpected duplicate Session organization placement assignments');
        tags.set(assignment.sessionId, assignment.tagIds);
      }
      yield { ok: true, placements: new Map(ids.map(sessionId => [sessionId, normalizeSessionCreationOrganizationPlacementV1({
        folderId: folders.get(sessionId) ?? null, tagIds: tags.get(sessionId) ?? [],
      })])) };
    } catch (error) {
      params.signal?.throwIfAborted();
      yield { ok: false, error };
    }
  }
}

/** Strict reads require every requested assignment batch to be available. */
export async function fetchSessionOrganizationPlacements(
  params: SessionOrganizationPlacementsHttpParams,
): Promise<ReadonlyMap<string, SessionOrganizationPlacementV1>> {
  const placements = new Map<string, SessionOrganizationPlacementV1>();
  for await (const batch of fetchSessionOrganizationPlacementBatches(params)) {
    if (!batch.ok) throw batch.error;
    for (const [sessionId, placement] of batch.placements) placements.set(sessionId, placement);
  }
  return placements;
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

export { fetchSessionById as fetchSessionByIdCompat };

export async function patchSessionMetadata(params: Readonly<{
  token: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'PATCH'; path: string; body: unknown;
  }>) => Readonly<Record<string, string>> | null;
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
  const path = `/v2/sessions/${encodedSessionId}`;
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({
    method: 'PATCH', path, body: requestBody,
  }) ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.patch(
    `${serverUrl}${path}`,
    requestBody,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...authorizationHeaders,
        'Content-Type': 'application/json',
      },
      // The metadata mutation/currentness owner governs this operation, including
      // Stop intent and retirement. A transport cutoff cannot shorten its lifetime.
      timeout: 0,
      ...(params.signal ? { signal: params.signal } : {}),
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
      error: 'session_publisher_authority_lost';
    }>
  | Readonly<{
      success: false;
      error: 'session_team_credential_binding_rejected';
      reason: SessionTeamCredentialBindingRejectionV1;
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
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'PATCH'; path: string; body: unknown;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  patch:
    | SessionMetadataTuplePatchV1
    | SessionMetadataInactiveModelIntentOwnerPatchV1
    | SessionTeamCredentialBindingMetadataPatchV1;
}>): Promise<PatchSessionMetadataEnvelopeTupleResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const path = `/v2/sessions/${encodedSessionId}`;
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({
    method: 'PATCH', path, body: params.patch,
  }) ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.patch(
    `${serverUrl}${path}`,
    params.patch,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...authorizationHeaders,
        'Content-Type': 'application/json',
      },
      timeout: 0,
      ...(params.signal ? { signal: params.signal } : {}),
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
    if (
      response.status === 409
      && body?.code === 'metadata_privacy_upgrade_required'
    ) {
      throw new Error(
        `Unexpected /v2/sessions/${params.sessionId} owner-migration refusal response shape`,
      );
    }
  }
  if (response.status === 409) {
    const bindingRejection =
      SessionTeamCredentialBindingMutationRejectionV1Schema.safeParse(body);
    if (bindingRejection.success) {
      return {
        success: false,
        error: 'session_team_credential_binding_rejected',
        reason: bindingRejection.data.reason,
      };
    }
    if (body?.code === 'session_publisher_authority_lost') {
      return {
        success: false,
        error: 'session_publisher_authority_lost',
      };
    }
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

/**
 * The sealed target current view committed by the Agent-transition cutover.
 *
 * Layout 0 carries the legacy metadata CAS tuple; layout 1 reuses the shipped
 * `owner_inactive_model_intent` owner patch, which already requires and
 * re-checks `active = false` inside the server transaction.
 */
export type SessionAgentTransitionCurrentViewWriteV1 =
  | Readonly<{
      kind: 'legacy_v0';
      expectedMetadataVersion: number;
      metadataCiphertext: string;
      expectedAgentStateVersion: number;
      agentStateCiphertext: null;
    }>
  | Readonly<{
      kind: 'envelope_tuple_v1';
      ownerPatch: SessionMetadataInactiveModelIntentOwnerPatchV1;
    }>;

/**
 * The partial-effect discriminator is load-bearing: a caller that cannot tell a
 * no-effect rejection from a committed-but-incomplete cutover will offer an
 * unsafe recovery action. `effect: 'unknown'` is reserved for transport
 * ambiguity, where the daemon cannot establish whether the write landed.
 */
export type ApplySessionAgentTransitionCutoverHttpResult =
  | Readonly<{ ok: true; dividerSeq: number }>
  | Readonly<{
      ok: false;
      effect: 'none';
      error:
        | 'invalid-params'
        | 'forbidden'
        | 'session-not-found'
        | 'archived'
        | 'session-active'
        | 'version-mismatch'
        | 'internal';
    }>
  | Readonly<{
      ok: false;
      effect: 'current_view_committed';
      error: 'divider-conflict' | 'divider-rejected' | 'internal';
    }>
  | Readonly<{ ok: false; effect: 'unknown'; error: 'transport' }>;

const SessionAgentTransitionCutoverSuccessSchema = z.strictObject({
  success: z.literal(true),
  dividerSeq: z.number().check(z.int(), z.minimum(0)),
});

const SessionAgentTransitionCutoverNoEffectErrorSchema = z.enum([
  'invalid-params',
  'forbidden',
  'session-not-found',
  'archived',
  'session-active',
  'version-mismatch',
  'internal',
]);

const SessionAgentTransitionCutoverCommittedErrorSchema = z.enum([
  'divider-conflict',
  'divider-rejected',
  'internal',
]);

const SessionAgentTransitionCutoverConflictSchema = z.discriminatedUnion('effect', [
  z.looseObject({
    effect: z.literal('none'),
    error: SessionAgentTransitionCutoverNoEffectErrorSchema,
  }),
  z.looseObject({
    effect: z.literal('current_view_committed'),
    error: SessionAgentTransitionCutoverCommittedErrorSchema,
  }),
]);

/**
 * The single daemon-facing transport for the ordered current-view-then-divider
 * cutover. It never retries: an ambiguous transport outcome is reported as
 * `effect: 'unknown'` so the coordinator returns `outcome_unknown` instead of
 * fabricating a definite state it cannot establish.
 */
export async function applySessionAgentTransitionCutover(params: Readonly<{
  token: string;
  sessionId: string;
  currentView: SessionAgentTransitionCurrentViewWriteV1;
  /** Sealed or plaintext `SessionStoredMessageContent` divider envelope. */
  divider: Readonly<{ localId: string; content: unknown }>;
  /**
   * The target Agent's Team slot bindings, written by the Home in the same
   * transaction as the target current view (lane 10 child 01 principle 3).
   */
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  externalAction?: Parameters<typeof callMachineRpc>[0]['externalAction'];
}>): Promise<ApplySessionAgentTransitionCutoverHttpResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  const path = `/v2/sessions/${encodedSessionId}/agent-transition/cutover`;
  const body = {
    v: 1,
    currentView: params.currentView,
    divider: params.divider,
    ...(params.teamCredentialBindings && params.teamCredentialBindings.length > 0
      ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
  };
  const externalAction = params.externalAction;
  const authorization = externalAction?.context.externalActionExecutionAuthorization;
  const target = externalAction?.context.externalActionTarget;
  if (externalAction && (!authorization || !target)) {
    return { ok: false, effect: 'none', error: 'forbidden' };
  }
  let response: AxiosResponse<unknown>;
  try {
    response = await axios.post(
      `${serverUrl}${path}`,
      body,
      {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          ...(externalAction && authorization && target
            ? createExternalActionAuthorizedRequestHeaders({
                ...externalAction, authorization, target, method: 'POST', path, body,
              })
            : { Authorization: `Bearer ${params.token}` }),
          'Content-Type': 'application/json',
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
      },
    );
  } catch {
    return { ok: false, effect: 'unknown', error: 'transport' };
  }

  if (response.status === 200) {
    const success = SessionAgentTransitionCutoverSuccessSchema.safeParse(response.data);
    return success.success
      ? {
          ok: true,
          dividerSeq: success.data.dividerSeq,
        }
      : { ok: false, effect: 'unknown', error: 'transport' };
  }
  // 409 carries the explicit partial-effect discriminator; a 500 may also carry
  // it when the failure is attributable to a known depth. An unparseable body
  // is ambiguous and must not be collapsed into a definite effect.
  if (response.status === 409 || response.status >= 500) {
    const conflict = SessionAgentTransitionCutoverConflictSchema.safeParse(response.data);
    return conflict.success
      ? conflict.data.effect === 'none'
        ? { ok: false, effect: 'none', error: conflict.data.error }
        : { ok: false, effect: 'current_view_committed', error: conflict.data.error }
      : { ok: false, effect: 'unknown', error: 'transport' };
  }
  if (response.status === 400) {
    return { ok: false, effect: 'none', error: 'invalid-params' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, effect: 'none', error: 'forbidden' };
  }
  if (response.status === 404) {
    return { ok: false, effect: 'none', error: 'session-not-found' };
  }
  return { ok: false, effect: 'unknown', error: 'transport' };
}

/** Scalar-only inventory read. Omitted documents are never full-snapshot replacements. */
export async function fetchSessionListPage(params: Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET'; path: string;
  }>) => Readonly<Record<string, string>> | null;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
  archivedOnly?: boolean;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  sessions: RawCompactSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
  metadataUpgradeRequiredCount?: number;
}> & (
  | SessionListAttentionContinuationV1
  | Readonly<{ attentionNextCursor?: never; attentionHasNext?: never }>
)> {
  if (params.signal?.aborted) {
    const error = new Error('Session list was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  const serverUrl = resolveServerHttpBaseUrl();
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : undefined;

  if (params.activeOnly && params.archivedOnly) {
    throw new Error('Cannot combine activeOnly and archivedOnly');
  }

  const path = params.activeOnly ? '/v2/sessions/active' : params.archivedOnly ? '/v2/sessions/archived' : '/v2/sessions';
  const query = new URLSearchParams();
  if (params.activeOnly) {
    if (limit) query.set('limit', String(limit));
  } else {
    if (params.cursor) query.set('cursor', params.cursor);
    if (limit) query.set('limit', String(limit));
  }
  const queryString = query.toString();
  const requestPath = queryString ? `${path}?${queryString}` : path;
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${serverUrl}${requestPath}`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...authorizationHeaders,
      'Content-Type': 'application/json',
    },
    ...(params.signal ? { signal: params.signal } : {}),
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

  const attentionContinuation = readSessionListAttentionContinuation(parsed);

  const page = {
    sessions: parsed.sessions,
    nextCursor: typeof parsed.nextCursor === 'string' ? parsed.nextCursor : null,
    hasNext: Boolean(parsed.hasNext),
    ...(parsed.metadataUpgradeRequiredCount === undefined
      ? {}
      : { metadataUpgradeRequiredCount: parsed.metadataUpgradeRequiredCount }),
  };
  return attentionContinuation === null
    ? page
    : { ...page, ...attentionContinuation };
}

export type CompactSessionListPageV1 = Awaited<ReturnType<typeof fetchSessionListPage>>;

type SessionListDocumentAuthorization = (request: Readonly<{
  method: 'GET' | 'POST'; path: string; body?: unknown;
}>) => Readonly<Record<string, string>> | null;

type SessionSnapshotBatchParams = Readonly<{
  token: string;
  serverUrl?: string;
  sessionIds: readonly string[];
  underSessionId?: string;
  accessProjectionVersion?: 1;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: SessionListDocumentAuthorization;
}>;

type SessionReadBatchPart = SessionReadBatchResponseV1['results'][number];

function invalidSessionReadBatchResponse(): Error & { code: string } {
  return Object.assign(new Error('Invalid Session batch response'), { code: 'session_read_batch_invalid_response' });
}

/** Existing read-batch transport; one request per real HTTP-body-budget chunk. */
export async function fetchSessionSnapshotsBatch(params: SessionSnapshotBatchParams): Promise<ReadonlyMap<string, SessionReadBatchPart>> {
  params.signal?.throwIfAborted();
  const serverUrl = params.serverUrl ?? resolveServerHttpBaseUrl();
  const emptyBody = SessionReadBatchRequestV1Schema.parse({ sessionIds: [], includeSnapshot: true,
    includeTurns: false, includeMessages: false, accessProjectionVersion: params.accessProjectionVersion,
    ...(params.underSessionId === undefined ? {} : { underSessionId: params.underSessionId }) });
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
  for (const id of new Set(params.sessionIds)) {
    if (!budget.tryAdmit(id)) {
      if (!chunk.length) throw new Error('Session id exceeds the HTTP request body limit');
      chunks.push(chunk);
      chunk = [];
      budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
      if (!budget.tryAdmit(id)) throw new Error('Session id exceeds the HTTP request body limit');
    }
    chunk.push(id);
  }
  if (chunk.length) chunks.push(chunk);
  const parts = new Map<string, SessionReadBatchPart>();
  const path = '/v2/sessions/read-batch';
  for (const sessionIds of chunks) {
    params.signal?.throwIfAborted();
    const body = SessionReadBatchRequestV1Schema.parse({ ...emptyBody, sessionIds });
    const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'POST', path, body })
      ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
    if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
    const response = await axios.post(`${serverUrl}${path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorizationHeaders,
        'Content-Type': 'application/json' },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    });
    params.signal?.throwIfAborted();
    if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
    if (response.status !== 200) throwUnexpectedStatusError(path, response.status);
    const parsed = SessionReadBatchResponseV1Schema.safeParse(response.data);
    if (!parsed.success) throw invalidSessionReadBatchResponse();
    const expected = new Set(sessionIds);
    for (const part of parsed.data.results) {
      if (!expected.delete(part.sessionId) || !part.detail
        || (part.detail.status === 200 && part.detail.body.session.id !== part.sessionId)) {
        throw invalidSessionReadBatchResponse();
      }
      parts.set(part.sessionId, part);
    }
    if (expected.size) throw invalidSessionReadBatchResponse();
  }
  return parts;
}

async function readSessionListDocuments(params: Omit<SessionSnapshotBatchParams, 'sessionIds'> & Readonly<{
  rows: readonly RawCompactSessionListRow[];
}>): Promise<RawSessionRecord[]> {
  const parts = await fetchSessionSnapshotsBatch({ ...params, sessionIds: params.rows.map(row => row.id) });
  return params.rows.map(row => {
    const detail = parts.get(row.id)?.detail;
    if (!detail) throw invalidSessionReadBatchResponse();
    if (detail.status !== 200) {
      const code = 'code' in detail.body && typeof detail.body.code === 'string' ? detail.body.code
        : 'error' in detail.body ? detail.body.error : detail.body.kind;
      throw Object.assign(createHttpStatusError(detail.status, 'Session document read unavailable', code),
        { sessionId: row.id, part: 'detail', failure: detail.body });
    }
    return detail.body.session;
  });
}

/**
 * Full-document list facade for CLI display, attach, private locality and daemon recovery.
 * These consumers have no admitted display document yet, so gather their genuine demand once.
 * Scalar-only readers use fetchSessionListPage instead.
 */
export async function fetchSessionsPage(params: Omit<Parameters<typeof fetchSessionListPage>[0], 'resolveAuthorizationHeaders'> & Readonly<{
  resolveAuthorizationHeaders?: SessionListDocumentAuthorization;
}>) {
  const serverUrl = resolveServerHttpBaseUrl();
  const page = await fetchSessionListPage(params);
  const sessions = await readSessionListDocuments({ ...params, serverUrl, rows: page.sessions });
  return { ...page, sessions };
}

export type SessionListPageV1 = Awaited<ReturnType<typeof fetchSessionsPage>>;

/**
 * The filtered listing's second continuation frontier, kept separate from the ordinary cursor.
 *
 * Current ordinary GET and strict query responses may produce it, while predecessor GET responses
 * omit it. Callers that accept either page shape read it through
 * `readSessionListAttentionContinuation`: the two fields travel together, and a caller must not
 * end up carrying a cursor without its flag.
 */
export type SessionListAttentionContinuationV1 = Readonly<{
  attentionNextCursor: string | null;
  attentionHasNext: boolean;
}>;

/** Strict filtered-listing transport. Query failures never broaden into legacy GET semantics. */
type SessionListQueryHttpParams = Readonly<{
  token: string;
  query: SessionListQueryV1;
  resolveAuthorizationHeaders?: SessionListDocumentAuthorization;
  signal?: AbortSignal;
}>;

async function fetchSessionsQueryPagePayload(params: SessionListQueryHttpParams): Promise<unknown> {
  if (params.signal?.aborted) {
    const error = new Error('Session list was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  const path = '/v2/sessions/query';
  const query = buildSessionListServerQueryV1(params.query);
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({
    method: 'POST', path, body: query,
  }) ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${path}`,
    query,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...authorizationHeaders,
        'Content-Type': 'application/json',
      },
      ...(params.signal ? { signal: params.signal } : {}),
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    },
  );
  if (isAuthenticationStatus(response.status)) throwAuthenticationStatusError(response.status);
  if (response.status === 404) {
    const unavailable = SessionListUnavailableQueryV1Schema.safeParse(response.data);
    if (unavailable.success) {
      throw new SessionListQueryHttpError(unavailable.data.code, unavailable.data);
    }
    throwUnexpectedStatusError(path, response.status);
  }
  if (response.status !== 200) throwUnexpectedStatusError(path, response.status);

  return response.data;
}

export async function fetchSessionListQueryPage(params: SessionListQueryHttpParams): Promise<SessionListQueryResponseV1> {
  return parseOrThrow(SessionListQueryResponseV1Schema, await fetchSessionsQueryPagePayload(params),
    'Unexpected /v2/sessions/query response shape');
}

export type FullSessionListQueryPageV1 = Omit<SessionListQueryResponseV1, 'sessions'> & Readonly<{ sessions: RawSessionRecord[] }>;

/** Full-document query facade; preserve both independent continuation frontiers. */
export async function fetchSessionsQueryPage(params: Omit<SessionListQueryHttpParams, 'resolveAuthorizationHeaders'> & Readonly<{
  resolveAuthorizationHeaders?: SessionListDocumentAuthorization;
}>): Promise<FullSessionListQueryPageV1> {
  const serverUrl = resolveServerHttpBaseUrl();
  const page = await fetchSessionListQueryPage(params);
  const sessions = await readSessionListDocuments({ ...params, serverUrl, rows: page.sessions, accessProjectionVersion: 1,
    ...(params.query.underSessionId === undefined ? {} : { underSessionId: params.query.underSessionId }) });
  return { ...page, sessions };
}

/** Restricted runtimes cannot substitute their hosting Account's required viewer projection. */
export async function fetchSessionRuntimeManagedSubtreeQueryPage(params: SessionListQueryHttpParams): Promise<
  Omit<SessionRuntimeManagedSubtreeListResponseV1, 'sessions'> & Readonly<{ sessions: RawSessionRecord[] }>
> {
  const serverUrl = resolveServerHttpBaseUrl();
  const page = parseOrThrow(SessionRuntimeManagedSubtreeListResponseV1Schema, await fetchSessionsQueryPagePayload(params),
    'Unexpected restricted /v2/sessions/query response shape');
  const fullSessions = await readSessionListDocuments({ ...params, serverUrl, rows: page.sessions, accessProjectionVersion: 1,
    ...(params.query.underSessionId === undefined ? {} : { underSessionId: params.query.underSessionId }) });
  const sessions = fullSessions.map(session => {
    const parsed = SessionRuntimeManagedSubtreeSnapshotRecordV1Schema.safeParse(session);
    if (!parsed.success) throw invalidSessionReadBatchResponse();
    return parsed.data;
  });
  return { ...page, sessions };
}

export type SessionListQueryPageV1 = Awaited<ReturnType<typeof fetchSessionsQueryPage>>;

/** Returns the attention continuation frontier, or `null` for a page shape that has none. */
export function readSessionListAttentionContinuation(
  page: Readonly<{
    attentionNextCursor?: string | null;
    attentionHasNext?: boolean;
  }>,
): SessionListAttentionContinuationV1 | null {
  const attentionNextCursor = page.attentionNextCursor;
  const attentionHasNext = page.attentionHasNext;
  const hasAttentionNextCursor = attentionNextCursor !== undefined;
  const hasAttentionHasNext = attentionHasNext !== undefined;
  if (hasAttentionNextCursor !== hasAttentionHasNext) {
    throw new Error('Session list response included a partial attention continuation');
  }
  if (attentionNextCursor === undefined || attentionHasNext === undefined) return null;
  return { attentionNextCursor, attentionHasNext };
}

export async function commitSessionEncryptedMessage(params: Readonly<{
  token: string;
  sessionId: string;
  ciphertext: string;
  localId: string;
}>): Promise<{ didWrite: boolean; messageId: string; localId: string | null; seq: number; createdAt: number }> {
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
}>): Promise<{ didWrite: boolean; messageId: string; localId: string | null; seq: number; createdAt: number }> {
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
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
    throw createHttpStatusError(404, 'Session not found', 'session_not_found');
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
    localId: parsed.message.localId,
    seq: Number(parsed.message?.seq ?? 0),
    createdAt: Number(parsed.message?.createdAt ?? 0),
  };
}

const V2HistoricalTranscriptImportResponseSchema = z.strictObject({
  imported: z.number().check(z.int(), z.minimum(0)),
  cursor: z.nullable(z.number().check(z.int(), z.minimum(0))),
});

/**
 * Single HTTP adapter for transcript.import. Validate all rows before writing, then preserve their
 * order within the server's existing per-request batch boundary. Each server batch is atomic;
 * a later failure leaves earlier admitted rows intact for the canonical stable-localId retry.
 */
export async function importHistoricalSessionTranscript(params: Readonly<{
  token: string;
  sessionId: string;
  items: readonly Readonly<{
    id: string;
    content?: unknown;
    surfaceItemReference?: SessionTranscriptSurfaceItemReferenceInputV1;
  }>[];
}>): Promise<{ imported: number; cursor: string | null }> {
  const items = params.items.map((item) => {
    const localId = item.id.trim();
    const content = SessionStoredMessageContentSchema.safeParse(item.content);
    if (!localId || !content.success) {
      throw new Error('Invalid transcript import item');
    }
    const surfaceItemReference = item.surfaceItemReference === undefined ? undefined
      : SessionTranscriptSurfaceItemReferenceInputV1Schema.parse(item.surfaceItemReference);
    return { localId, content: content.data, ...(surfaceItemReference ? { surfaceItemReference } : {}) };
  });
  if (items.length === 0) {
    return { imported: 0, cursor: null };
  }

  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeSessionIdPathSegment(params.sessionId);
  let path = `/v${items.some((item) => item.surfaceItemReference) ? 3 : 2}/sessions/${encodedSessionId}/transcript/import`;
  const config = {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
    validateStatus: () => true,
  };
  let imported = 0;
  let cursor: number | null = null;
  for (let offset = 0; offset < items.length; offset += SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS) {
    const batch = items.slice(offset, offset + SESSION_HISTORICAL_TRANSCRIPT_IMPORT_MAX_ITEMS);
    const withoutReferences = () => batch.map(({ surfaceItemReference: _reference, ...item }) => item);
    let response = await axios.post(`${serverUrl}${path}`, {
      items: path.startsWith('/v3/') ? batch : withoutReferences(),
    }, config);
    if (path.startsWith('/v3/') && response.status === 404
      && !(response.data && typeof response.data === 'object' && response.data.error === 'Session not found')) {
      // Supported older Homes preserve the transcript, never a false association. Keep the
      // negotiated fallback for the remaining batches in this one import operation.
      path = `/v2/sessions/${encodedSessionId}/transcript/import`;
      response = await axios.post(`${serverUrl}${path}`, { items: withoutReferences() }, config);
    }

    if (isAuthenticationStatus(response.status)) {
      throwAuthenticationStatusError(response.status);
    }
    if (response.status === 404) {
      const currentServerSessionMiss = response.data !== null
        && typeof response.data === 'object'
        && !Array.isArray(response.data)
        && (response.data as { error?: unknown }).error === 'Session not found';
      if (currentServerSessionMiss) {
        throw createHttpStatusError(404, 'Session not found', 'session_not_found');
      }
      throw createHttpStatusError(
        404,
        'Server upgrade required before transcript import.',
        'upgrade_required',
      );
    }
    if (response.status !== 200) {
      throw new Error(`Unexpected status from ${path}: ${response.status}`);
    }

    const parsed = parseOrThrow(
      V2HistoricalTranscriptImportResponseSchema,
      response.data,
      `Unexpected ${path} response shape`,
    );
    imported += parsed.imported;
    if (parsed.cursor !== null) cursor = Math.max(cursor ?? 0, parsed.cursor);
  }
  return {
    imported,
    cursor: cursor === null ? null : String(cursor),
  };
}

/** One HTTP boundary for the API client's and seeded creator's Session birth. */
export async function postSessionCreationRequest<T>(params: Readonly<{
  serverUrl: string;
  token: string;
  body: unknown;
  creationAuthorizationToken?: string;
  signal?: AbortSignal;
  validateStatus?: (status: number) => boolean;
}>): Promise<AxiosResponse<T>> {
  params.signal?.throwIfAborted();
  const refuseConfirmedRollback = (status: number, data: unknown): void => {
    const rollback = readHomeDomainConfirmedRollbackV1(status, data);
    if (rollback) throw createHttpStatusError(status, 'Session creation transaction rolled back', rollback.code);
  };
  const response = await axios.post<T>(`${params.serverUrl}/v1/sessions`, params.body, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...(params.creationAuthorizationToken ? { [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: params.creationAuthorizationToken } : {}),
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    // An admitted creation operation owns its lifetime through native open.
    // Standalone callers without that lifetime retain the existing timeout.
    timeout: params.signal ? 0 : 60_000,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.validateStatus ? { validateStatus: params.validateStatus } : {}),
  }).catch((cause: unknown) => {
    // A response is handled by the existing refusal/rollback readers. Losing
    // the response after dispatch cannot prove that Session birth rolled back.
    if (axios.isAxiosError(cause) && cause.response) {
      refuseConfirmedRollback(cause.response.status, cause.response.data);
    }
    if (readHttpStatus(cause) !== null || classifyHomeDomainHttpMutationFailureV1({
      error: cause, issued: true, aborted: params.signal?.aborted === true,
    }) !== 'outcome_unknown') throw cause;
    throw Object.assign(new Error('Session creation outcome is unknown; reconcile the original creation key before retrying'), {
      code: 'outcome_unknown' as const,
      cause: { ...serializeAxiosErrorForLog(cause), code: readNormalizedConnectionErrorCode(cause) },
    });
  });
  refuseConfirmedRollback(response.status, response.data);
  // Cancellation cannot undo a remote commit, but it cannot report success to
  // an invocation that has already retired either.
  params.signal?.throwIfAborted();
  return response;
}

export async function getOrCreateSessionByTag(params: Readonly<import('@happier-dev/protocol').SessionCreateOriginFieldsV1 & {
  credentials: StoredCredentials;
  tag: string;
  metadata: Record<string, unknown>;
  agentState: Record<string, unknown> | null;
  currentStorageState?: 'machine_only';
  organizationPlacement?: SessionOrganizationPlacementV1;
  shouldCommit?: () => boolean;
  initialAccess?: SessionInitialAccessDraftV1;
  initialTriggers?: readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[];
  manager?: SessionManagerV1;
  primaryTeamId?: string | null;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  creationAuthorizationToken?: string;
  prepareCreationAuthorizationProof?: import('@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1').SessionCreationAuthorizationV1['prepareRequestProof'];
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  signal?: AbortSignal;
}>): Promise<{
  session: RawSessionRecord;
  created: boolean;
  organizationPlacement?: SessionOrganizationPlacementV1;
}> {
  const serverUrl = resolveServerHttpBaseUrl();

  const encryptionModeResolution = await resolveSessionCreateEncryptionMode({
    token: params.credentials.token,
    serverBaseUrl: serverUrl,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.accountEncryptionCurrentness
      ? { accountEncryptionCurrentness: params.accountEncryptionCurrentness }
      : {}),
  });
  if (encryptionModeResolution.status === 'currentness_unavailable') {
    // Same contract as ApiClient.getOrCreateSession (api.ts): the preflight read
    // failed before any Session request, so its wrapped transport failure is what
    // callers classify (offline, stable auth status). An unavailable currentness
    // is never reinterpreted as a Plain Account.
    const { error } = encryptionModeResolution;
    throw error.cause ?? error;
  }
  const {
    desiredSessionEncryptionMode,
    accountEncryptionCurrentness,
    serverSupportsFeatureSnapshot,
    serverFeaturesSnapshot,
  } = encryptionModeResolution;

  const initialAccessFields = buildSessionInitialAccessCreateFields(params, serverFeaturesSnapshot);
  const creationMetadata = addSessionInitialAccessTeamShareStatement(params.metadata, initialAccessFields, desiredSessionEncryptionMode);
  const sessionEncryptionContext =
    desiredSessionEncryptionMode === 'e2ee'
      ? resolveSessionEncryptionContext(params.credentials)
      : null;
  const metadataEnvelopeFields =
    desiredSessionEncryptionMode === 'plain'
      ? buildSessionMetadataEnvelopeCreateFields({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          metadata: creationMetadata,
          agentState: params.agentState,
          storedContentMode: 'plain',
        })
      : (() => {
          if (!sessionEncryptionContext) {
            throw new Error('Session encryption context is unavailable');
          }
          return buildSessionMetadataEnvelopeCreateFields({
            credentials: params.credentials,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
            metadata: creationMetadata,
            agentState: params.agentState,
            storedContentMode: 'e2ee',
            encryptionKey: sessionEncryptionContext.encryptionKey,
            encryptionVariant: sessionEncryptionContext.encryptionVariant,
          });
        })();
  const dataEncryptionKeyPayload =
    sessionEncryptionContext?.dataEncryptionKey
      ? encodeBase64(sessionEncryptionContext.dataEncryptionKey)
      : null;
  const materializedInitialAccessFields = await materializeSessionInitialAccessCreateFields({
    fields: initialAccessFields,
    sessionEncryptionMode: desiredSessionEncryptionMode,
    sessionDataKey: sessionEncryptionContext?.encryptionVariant === 'dataKey'
      ? sessionEncryptionContext.encryptionKey
      : null,
    token: params.credentials.token,
    serverHttpBaseUrl: serverUrl,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (params.shouldCommit && !params.shouldCommit()) {
    throw new Error('Session creation commit precondition failed');
  }
  const body = {
    ...pickSessionCreateOriginFields(params),
    ...(params.manager !== undefined ? { manager: params.manager } : {}),
    tag: params.tag,
    ...metadataEnvelopeFields,
    dataEncryptionKey: dataEncryptionKeyPayload,
    ...(params.currentStorageState ? { currentStorageState: params.currentStorageState } : {}),
      ...(params.organizationPlacement ? { organizationPlacement: params.organizationPlacement } : {}),
      ...(params.teamCredentialBindings !== undefined ? { teamCredentialBindings: params.teamCredentialBindings } : {}),
    ...materializedInitialAccessFields,
    ...(params.initialTriggers !== undefined ? { initialTriggers: params.initialTriggers } : {}),
    ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
  };
  const creationAuthorizationProof = await params.prepareCreationAuthorizationProof?.(body);
  const response = await postSessionCreationRequest<unknown>({
    serverUrl,
    token: params.credentials.token,
    body: { ...body, ...(creationAuthorizationProof ? { creationAuthorizationProof } : {}) },
    ...(params.creationAuthorizationToken ? { creationAuthorizationToken: params.creationAuthorizationToken } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  const initialTriggerError = readSessionCreationInitialTriggerError(response.data, response.status);
  if (initialTriggerError) throw initialTriggerError;
  const initialAccessServerError = response.status === 200
    ? null
    : readSessionInitialAccessServerError(response.data, response.status);
  if (initialAccessServerError) throw initialAccessServerError;
  if (isAuthenticationStatus(response.status)) {
    throwAuthenticationStatusError(response.status);
  }
  if (response.status === 426) {
    const upgradeRequired = readCliClientUpgradeRequired(response.data);
    if (
      upgradeRequired?.requirement
      && 'kind' in upgradeRequired.requirement
      && upgradeRequired.requirement.kind === 'account-stored-content'
    ) {
      throw Object.assign(
        new Error('Session creation requires a stored-content-compatible server'),
        {
          code: 'client-upgrade-required' as const,
          retryable: false as const,
          requirement: upgradeRequired.requirement,
        },
      );
    }
  }
  if (response.status !== 200) {
    const teamCredentialUpdateRequired = readSessionTeamCredentialBindingUpdateRequiredError(response.data);
    if (teamCredentialUpdateRequired) throw teamCredentialUpdateRequired;
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
  const returnedMode = resolveSessionStoredContentEncryptionMode(parsed.session);
  assertSessionEncryptionModeAllowedByEffectiveClientRequirement(returnedMode);
  await prepareSessionInitialAccessDataKeyEnvelopes({
    fields: initialAccessFields,
    sessionId: parsed.session.id,
    sessionEncryptionMode: returnedMode,
    credentials: params.credentials,
    session: parsed.session,
    token: params.credentials.token,
    serverHttpBaseUrl: serverUrl,
    ...(params.shouldCommit ? { isScopeCurrent: params.shouldCommit } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.signal?.throwIfAborted();
  // Released and predecessor servers omit `created`; preserve their historical
  // create-or-load behavior while current servers report the exact race result.
  return {
    session: parsed.session,
    created: parsed.created !== false,
    ...(parsed.organizationPlacement
      ? { organizationPlacement: parsed.organizationPlacement }
      : {}),
  };
}

async function postArchiveMutation(params: Readonly<{
  token: string;
  sessionId: string;
  op: 'archive' | 'unarchive';
  originRunId?: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: 'POST'; path: string; body: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<{ archivedAt: number | null }> {
  params.signal?.throwIfAborted();
  const serverUrl = resolveServerHttpBaseUrl();
  const path = `/v2/sessions/${encodeSessionIdPathSegment(params.sessionId)}/${params.op}`;
  const body = params.op === 'archive' && params.originRunId !== undefined ? { originRunId: params.originRunId } : {};
  const publisherHeader = params.op === 'archive' && params.originRunId !== undefined
    ? await createDefaultPluginInstallationPublisherHeader({ method: 'POST', path, body }) : null;
  if (params.op === 'archive' && params.originRunId !== undefined && !publisherHeader) {
    throw new Error('Session archive origin publisher unavailable');
  }
  params.signal?.throwIfAborted();
  const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'POST', path, body })
    ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.post(
    `${serverUrl}${path}`,
    body,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        ...authorizationHeaders,
        ...(publisherHeader ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader } : {}),
        'Content-Type': 'application/json',
      },
      // Archive can wait on the Home's transaction. The containing invocation
      // owns cancellation; the generic read/control cutoff cannot settle it.
      timeout: 0,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    },
  ).catch((cause: unknown) => {
    const disposition = classifyHomeDomainHttpMutationFailureV1({ error: cause, issued: true, aborted: params.signal?.aborted === true });
    throw Object.assign(new Error('Session archive mutation transport failed'), {
      code: disposition === 'not_dispatched' ? 'server_unreachable' : 'outcome_unknown', cause,
    });
  });

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
  if (response.status >= 500) {
    throw Object.assign(new Error('Session archive mutation outcome is unknown'), { code: 'outcome_unknown' });
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

export async function archiveSession(params: Readonly<{
  token: string; sessionId: string;
  originRunId?: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof postArchiveMutation>[0]['resolveAuthorizationHeaders'];
}>): Promise<{ archivedAt: number }> {
  const res = await postArchiveMutation({ ...params, op: 'archive' });
  if (typeof res.archivedAt !== 'number') {
    throw new Error('Unexpected archive response (archivedAt is null)');
  }
  return { archivedAt: res.archivedAt };
}

export async function unarchiveSession(params: Readonly<{
  token: string; sessionId: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof postArchiveMutation>[0]['resolveAuthorizationHeaders'];
}>): Promise<{ archivedAt: null }> {
  const res = await postArchiveMutation({ ...params, op: 'unarchive' });
  if (res.archivedAt !== null) {
    throw new Error('Unexpected unarchive response (archivedAt is not null)');
  }
  return { archivedAt: null };
}
