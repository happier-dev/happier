import axios from 'axios';
import { z } from 'zod';

import {
  AccountEncryptionModeResponseSchema,
  ConnectedServiceAuthGroupErrorResponseV1Schema,
  ConnectedServiceAuthGroupListResponseV1Schema,
  ConnectedServiceAuthGroupResponseV1Schema,
  ConnectedServiceCredentialRecordV1Schema,
  SealedConnectedServiceCredentialV1Schema,
  StoredJsonContentEnvelopeSchema,
  assertConnectedServiceCredentialRecordBinding,
  readConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

import { createHttpStatusError } from '../client/httpStatusError';
import { logServerEndpointFailure } from '../client/serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { resolveConnectedServicesServerApiTimeoutMs } from './serverApiTimeout';

export class ConnectedServiceAuthGroupGenerationConflictError extends Error {
  constructor(public readonly generation: number) {
    super('connected_service_auth_group_generation_conflict');
  }
}

export class ConnectedServiceAuthGroupRuntimeStateRevisionConflictError extends Error {
  constructor(public readonly runtimeStateRevision: number) {
    super('connected_service_auth_group_runtime_state_revision_conflict');
  }
}

export const connectedServiceAuthGroupUnavailableCode = 'connected_service_auth_group_unavailable';

export function isConnectedServiceAuthGroupUnavailableError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === connectedServiceAuthGroupUnavailableCode,
  );
}

export class ConnectedServiceCredentialUnsupportedFormatError extends Error {
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(serviceId: ConnectedServiceId, profileId: string) {
    super(`Connected service credential is in an unsupported legacy format (${serviceId}/${profileId}). Reconnect it in Happier.`);
    this.name = 'ConnectedServiceCredentialUnsupportedFormatError';
    this.serviceId = serviceId;
    this.profileId = profileId;
  }
}

/**
 * The compatible credential responses below adapt exact server-v0.2.1 at
 * 4913c1e533c872a0712ba1c25b3104fd470aacc2, which omitted credential revisions.
 * Remove the legacy response branch when exact 0.2.1 leaves the supported
 * predecessor window.
 */
export type ConnectedServiceCredentialSealedResponse = Readonly<{
  sealed: SealedConnectedServiceCredentialV1;
  metadata: {
    kind: 'oauth' | 'token';
    providerEmail?: string | null;
    providerAccountId?: string | null;
    expiresAt?: number | null;
  };
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export type ConnectedServiceCredentialPlainResponse = Readonly<{
  content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export type ConnectedServiceCredentialApi = Readonly<{
  getAccountEncryptionMode?: (options?: Readonly<{
    refresh?: boolean;
    signal?: AbortSignal;
  }>) => Promise<'e2ee' | 'plain' | 'unknown'>;
  getConnectedServiceCredentialSealed: (params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }) => Promise<ConnectedServiceCredentialSealedResponse | null>;
  getConnectedServiceCredentialPlain?: (params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }) => Promise<ConnectedServiceCredentialPlainResponse | null>;
}>;

export type ConnectedServiceAuthGroupApi = Readonly<{
  listConnectedServiceAuthGroups: (params: {
    serviceId: ConnectedServiceId;
  }) => Promise<readonly ConnectedServiceAuthGroupV1[]>;
  getConnectedServiceAuthGroup: (params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    signal?: AbortSignal;
  }) => Promise<ConnectedServiceAuthGroupV1 | null>;
}>;

function authHeaders(token: string): Readonly<Record<string, string>> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function readAxiosStatus(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

function readAxiosErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  return typeof rec.error === 'string' ? rec.error : undefined;
}

function throwConnectedServiceGroupGenerationConflictIfPresent(error: unknown): void {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return;
  const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
  if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
    throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
  }
}

function createCausePreservingError(message: string, cause: unknown): Error {
  const wrapped = new Error(message, { cause }) as Error & { code?: string };
  const causeRecord = typeof cause === 'object' && cause !== null ? cause as Record<string, unknown> : null;
  const code = causeRecord?.code;
  if (typeof code === 'string' && code.length > 0) {
    wrapped.code = code;
  }
  return wrapped;
}

export function createConnectedServiceCredentialApi(
  credentials: Credentials,
): ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi {
  const token = credentials.token;

  return {
    getAccountEncryptionMode: async (options) => getAccountEncryptionMode({
      token,
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    getConnectedServiceCredentialSealed: async (params) => getConnectedServiceCredentialSealed({ token, ...params }),
    getConnectedServiceCredentialPlain: async (params) => getConnectedServiceCredentialPlain({ token, ...params }),
    listConnectedServiceAuthGroups: async (params) => listConnectedServiceAuthGroups({ token, ...params }),
    getConnectedServiceAuthGroup: async (params) => getConnectedServiceAuthGroup({ token, ...params }),
  };
}

export async function getAccountEncryptionMode(params: Readonly<{
  token: string;
  signal?: AbortSignal;
}>): Promise<'e2ee' | 'plain' | 'unknown'> {
  const serverUrl = resolveServerHttpBaseUrl();
  try {
    const response = await axios.get(
      `${serverUrl}/v1/account/encryption`,
      {
        headers: authHeaders(params.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
        signal: params.signal,
      },
    );
    if (response.status === 404) return 'e2ee';
    if (response.status !== 200) return 'unknown';
    const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
    if (!parsed.success) return 'unknown';
    return parsed.data.mode === 'plain' ? 'plain' : 'e2ee';
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    if (status === 404) return 'e2ee';
    logServerEndpointFailure({
      logger,
      operation: 'Failed to get account encryption mode',
      error,
    });
    return 'unknown';
  }
}

export async function getConnectedServiceCredentialSealed(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceCredentialSealedResponse | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const profileId = encodeURIComponent(params.profileId);

  try {
    const response = await axios.get(
      `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
      {
        headers: authHeaders(params.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
        signal: params.signal,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }

    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service credential response');
    }

    const sealedParsed = SealedConnectedServiceCredentialV1Schema.safeParse((raw as Record<string, unknown>).sealed);
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(raw as Record<string, unknown>);
    if (!sealedParsed.success || !revision) {
      throw new Error('Invalid connected service credential response');
    }

    const metadataParsed = z.object({
      kind: z.enum(['oauth', 'token']),
      providerEmail: z.string().nullable().optional(),
      providerAccountId: z.string().nullable().optional(),
      expiresAt: z.number().nullable().optional(),
    }).safeParse((raw as Record<string, unknown>).metadata);

    if (!metadataParsed.success) {
      throw new Error('Invalid connected service credential response');
    }

    return { ...revision, sealed: sealedParsed.data, metadata: metadataParsed.data };
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    const code = readAxiosErrorCode(error);
    if (status === 404) {
      return null;
    }
    if (status === 409 && code === 'connect_credential_unsupported_format') {
      throw new ConnectedServiceCredentialUnsupportedFormatError(params.serviceId, params.profileId);
    }
    logServerEndpointFailure({
      logger,
      operation: 'Failed to get connected service credential',
      error,
    });
    throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function getConnectedServiceCredentialPlain(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceCredentialPlainResponse | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const profileId = encodeURIComponent(params.profileId);

  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
      {
        headers: authHeaders(params.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
        signal: params.signal,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service credential response');
    }

    const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as Record<string, unknown>).content);
    const revision = readConnectedServiceCredentialRevisionBoundaryV1(raw as Record<string, unknown>);
    if (!contentParsed.success || contentParsed.data.t !== 'plain' || !revision) {
      throw new Error('Invalid connected service credential response');
    }

    const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(contentParsed.data.v);
    if (!recordParsed.success) {
      throw new Error('Invalid connected service credential response');
    }
    try {
      assertConnectedServiceCredentialRecordBinding({
        binding: { serviceId: params.serviceId, profileId: params.profileId },
        record: recordParsed.data,
      });
    } catch {
      throw new Error('Invalid connected service credential response');
    }

    return { ...revision, content: { t: 'plain', v: recordParsed.data } };
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    const code = readAxiosErrorCode(error);
    if (status === 404) {
      return null;
    }
    if (status === 409 && code === 'connect_credential_unsupported_format') {
      return null;
    }
    logServerEndpointFailure({
      logger,
      operation: 'Failed to get connected service credential (v3)',
      error,
    });
    throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function listConnectedServiceAuthGroups(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
}>): Promise<readonly ConnectedServiceAuthGroupV1[]> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/groups`,
      {
        headers: authHeaders(params.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
      },
    );
    if (response.status !== 200) throw new Error(`Server returned status ${response.status}`);
    const parsed = ConnectedServiceAuthGroupListResponseV1Schema.safeParse(response.data);
    if (!parsed.success) throw new Error('Invalid connected service auth group list response');
    return parsed.data.groups;
  } catch (error: unknown) {
    const status = readAxiosStatus(error);
    logServerEndpointFailure({
      logger,
      operation: 'Failed to list connected service auth groups',
      error,
    });
    if (typeof status === 'number' && Number.isFinite(status)) {
      throw createHttpStatusError(status, `Failed to list connected service auth groups (${status})`);
    }
    throw createCausePreservingError(
      `Failed to list connected service auth groups: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error,
    );
  }
}

export async function getConnectedServiceAuthGroup(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  signal?: AbortSignal;
}>): Promise<ConnectedServiceAuthGroupV1 | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const groupId = encodeURIComponent(params.groupId);

  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}`,
      {
        headers: authHeaders(params.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
        signal: params.signal,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service auth group response');
    }
    return parsed.data.group;
  } catch (error: unknown) {
    throwConnectedServiceGroupGenerationConflictIfPresent(error);
    const status = readAxiosStatus(error);
    const code = readAxiosErrorCode(error);
    if (status === 404 && code === 'connect_group_not_found') return null;
    if (status === 404) {
      throw createHttpStatusError(
        404,
        'Connected service auth group unavailable',
        connectedServiceAuthGroupUnavailableCode,
      );
    }
    logServerEndpointFailure({
      logger,
      operation: 'Failed to get connected service auth group',
      error,
    });
    if (typeof status === 'number' && Number.isFinite(status)) {
      throw createHttpStatusError(
        status,
        `Failed to get connected service auth group (${status})`,
      );
    }
    throw createCausePreservingError(
      `Failed to get connected service auth group: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error,
    );
  }
}
