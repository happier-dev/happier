import axios from 'axios';

import {
  SessionPermissionMediationRecordListResponseSchema,
  SessionPermissionMediationRecordPruneResponseSchema,
  SessionPermissionMediationRecordReadResponseSchema,
  SessionPermissionMediationRecordWriteResponseSchema,
  type SessionPermissionMediationRecordIdentityV1,
  type SessionPermissionMediationRecordListQuery,
  type SessionPermissionMediationRecordPruneRequest,
  type SessionPermissionMediationRecordStored,
  type SessionPermissionMediationRecordWriteRequest,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

function parseOrThrow<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  payload: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success || !parsed.data) throw new Error(message);
  return parsed.data;
}

function buildHeaders(token: string): Record<string, string> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function throwPermissionMediationRecordStatus(status: number, data: unknown): never {
  if (isAuthenticationStatus(status)) {
    throw createHttpStatusError(status, `Unauthorized (${status})`, 'not_authenticated');
  }
  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const code = typeof payload.code === 'string'
    ? payload.code
    : 'permission_mediation_record_transport_error';
  const error = createHttpStatusError(status, 'Permission mediation record request failed', code);
  Object.assign(error, {
    code,
    ...(typeof payload.currentRevision === 'string' ? { currentRevision: payload.currentRevision } : {}),
  });
  throw error;
}

function recordRoute(identity: SessionPermissionMediationRecordIdentityV1): string {
  const encodedSessionId = encodeURIComponent(identity.sessionId);
  const base = `/v2/sessions/${encodedSessionId}/permission-mediation-records`;
  return `${base}/${encodeURIComponent(identity.turnId)}/${encodeURIComponent(identity.requestId)}`;
}

function listRoute(sessionId: string): string {
  return `/v2/sessions/${encodeURIComponent(sessionId)}/permission-mediation-records`;
}

export async function readPermissionMediationRecordHttp(params: Readonly<{
  token: string;
  identity: SessionPermissionMediationRecordIdentityV1;
  signal?: AbortSignal;
}>): Promise<SessionPermissionMediationRecordStored | null> {
  const route = recordRoute(params.identity);
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${route}`, {
    headers: buildHeaders(params.token),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwPermissionMediationRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionPermissionMediationRecordReadResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
}

export async function writePermissionMediationRecordHttp(params: Readonly<{
  token: string;
  identity: SessionPermissionMediationRecordIdentityV1;
  request: SessionPermissionMediationRecordWriteRequest;
  signal?: AbortSignal;
}>): Promise<SessionPermissionMediationRecordStored> {
  const route = recordRoute(params.identity);
  const response = await axios.put(`${resolveServerHttpBaseUrl()}${route}`, params.request, {
    headers: buildHeaders(params.token),
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwPermissionMediationRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionPermissionMediationRecordWriteResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  ).record;
}

/**
 * Internal retention operation for an already-opened inactive row. This is
 * intentionally fixed to the Permission mediation route, rather than the
 * closed generic System Records delete transport.
 */
export async function prunePermissionMediationRecordHttp(params: Readonly<{
  token: string;
  identity: SessionPermissionMediationRecordIdentityV1;
  request: SessionPermissionMediationRecordPruneRequest;
  signal?: AbortSignal;
}>): Promise<void> {
  const route = recordRoute(params.identity);
  const response = await axios.delete(`${resolveServerHttpBaseUrl()}${route}`, {
    headers: buildHeaders(params.token),
    data: params.request,
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwPermissionMediationRecordStatus(response.status, response.data);
  parseOrThrow(
    SessionPermissionMediationRecordPruneResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
}

export async function listPermissionMediationRecordsHttp(params: Readonly<{
  token: string;
  sessionId: string;
  query?: SessionPermissionMediationRecordListQuery;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  records: readonly SessionPermissionMediationRecordStored[];
  nextCursor: string | null;
  hasNext: boolean;
}>> {
  const route = listRoute(params.sessionId);
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${route}`, {
    headers: buildHeaders(params.token),
    params: params.query,
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (response.status !== 200) throwPermissionMediationRecordStatus(response.status, response.data);
  return parseOrThrow(
    SessionPermissionMediationRecordListResponseSchema,
    response.data,
    `Unexpected ${route} response shape`,
  );
}
