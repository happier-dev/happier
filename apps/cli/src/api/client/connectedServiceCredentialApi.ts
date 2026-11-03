import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import { z } from 'zod/mini';

import { assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';
import { ConnectedServiceCredentialRecordV1Schema, SealedConnectedServiceCredentialV1Schema, readConnectedServiceCredentialRevisionBoundaryV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ConnectedServiceCredentialRecordV1, ConnectedServiceCredentialRevisionV1, ConnectedServiceCredentialRevisionBoundaryV1, ConnectedServiceId, SealedConnectedServiceCredentialV1, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { logServerEndpointFailure } from './serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from './accountEncryptionMode';
import { createHttpStatusError } from './httpStatusError';
import { fetchAccountEncryptionCurrentness } from './accountEncryptionCurrentness';
export { AccountEncryptionCurrentnessUnavailableError, fetchAccountEncryptionCurrentness, fetchAccountEncryptionCurrentnessFromServer } from './accountEncryptionCurrentness';

const CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS = 10_000;

export type ConnectedServiceAccountEncryptionMode = 'e2ee' | 'plain' | 'unknown';

export type AccountEncryptionModeReadOptions = Readonly<{
  refresh?: boolean;
  usage?: 'identity' | 'fresh-authority';
  signal?: AbortSignal;
  /** Registration must preserve transport failures for its existing readiness wake owner. */
  throwOnTransportError?: boolean;
}>;

export type ConnectedServiceProfileHealthStatus =
  | 'connected'
  | 'refreshing'
  | 'needs_reauth'
  | 'refresh_failed_retryable';

export type ConnectedServiceProfileListResult = Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Array<{
    profileId: string;
    status: ConnectedServiceProfileHealthStatus;
    kind?: 'oauth' | 'token' | null;
    providerEmail?: string | null;
    providerAccountId?: string | null;
    expiresAt?: number | null;
    lastUsedAt?: number | null;
  }>;
}>;

export type ConnectedServiceCredentialPlainResponse = Readonly<{
  content: Readonly<{ t: 'plain'; v: ConnectedServiceCredentialRecordV1 }>;
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export type ConnectedServiceCredentialSealedResponse = Readonly<{
  sealed: SealedConnectedServiceCredentialV1;
  metadata: Readonly<{
    kind: 'oauth' | 'token';
    providerEmail?: string | null;
    providerAccountId?: string | null;
    expiresAt?: number | null;
  }>;
}> & ConnectedServiceCredentialRevisionBoundaryV1;

export type ConnectedServiceCredentialApi = Readonly<{
  getAccountEncryptionCurrentness(): Promise<AccountEncryptionCurrentnessResponse>;
  getAccountEncryptionMode(options?: AccountEncryptionModeReadOptions): Promise<ConnectedServiceAccountEncryptionMode>;
  getConnectedServiceCredentialPlain(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceCredentialPlainResponse | null>;
  getConnectedServiceCredentialSealed(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }>): Promise<ConnectedServiceCredentialSealedResponse | null>;
  listConnectedServiceProfiles(params: Readonly<{
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }>): Promise<ConnectedServiceProfileListResult>;
  deleteConnectedServiceCredentialRevisioned(params: Readonly<{
    storageMode: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    cleanupGroupReferences: boolean;
  }>): Promise<void>;
}>;

type ConnectedServiceProfileListCacheEntry = Readonly<
  | { kind: 'value'; expiresAtMs: number; value: ConnectedServiceProfileListResult }
  | { kind: 'in_flight'; promise: Promise<ConnectedServiceProfileListResult> }
>;

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

function readAxiosErrorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const rec = data as Record<string, unknown>;
  return typeof rec.error === 'string' ? rec.error : undefined;
}

function createHeaders(token: string): Readonly<Record<string, string>> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${token}`,
  };
}

export class ConnectedServiceCredentialHttpClient implements ConnectedServiceCredentialApi {
  private readonly token: string;
  private readonly connectedServiceProfileListCache = new Map<ConnectedServiceId, ConnectedServiceProfileListCacheEntry>();

  constructor(credential: Readonly<{ token: string }>) {
    this.token = credential.token;
  }

  invalidateConnectedServiceProfileListCache(serviceId?: ConnectedServiceId): void {
    if (serviceId) {
      this.connectedServiceProfileListCache.delete(serviceId);
      return;
    }
    this.connectedServiceProfileListCache.clear();
  }

  async getAccountEncryptionCurrentness(): Promise<AccountEncryptionCurrentnessResponse> {
    return await fetchAccountEncryptionCurrentness({ token: this.token });
  }

  async getConnectedServiceCredentialSealed(params: Readonly<{
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
          headers: createHeaders(this.token),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          ...(params.signal ? { signal: params.signal } : {}),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service credential response');
      }

      const sealedParsed = SealedConnectedServiceCredentialV1Schema.safeParse((raw as any).sealed);
      if (!sealedParsed.success) {
        throw new Error('Invalid connected service credential response');
      }

      const metadataParsed = z.object({
        kind: z.enum(['oauth', 'token']),
        providerEmail: z.optional(z.nullable(z.string())),
        providerAccountId: z.optional(z.nullable(z.string())),
        expiresAt: z.optional(z.nullable(z.number())),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw new Error('Invalid connected service credential response');
      }

      const revision = readConnectedServiceCredentialRevisionBoundaryV1(raw as Record<string, unknown>);
      if (!revision) {
        throw new Error('Invalid connected service credential response');
      }

      return {
        ...revision,
        sealed: sealedParsed.data,
        metadata: metadataParsed.data,
      };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) {
        return null;
      }
      if (status === 409 && readAxiosErrorCode(error) === 'connect_credential_unsupported_format') {
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

  async listConnectedServiceProfiles(params: Readonly<{
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }>): Promise<ConnectedServiceProfileListResult> {
    if (params.forceRefresh) {
      this.connectedServiceProfileListCache.delete(params.serviceId);
    }
    const cached = this.connectedServiceProfileListCache.get(params.serviceId);
    const nowMs = Date.now();
    if (cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
    if (cached?.kind === 'in_flight') return await cached.promise;

    const promise = this.fetchConnectedServiceProfilesFromServer(params);
    this.connectedServiceProfileListCache.set(params.serviceId, { kind: 'in_flight', promise });
    try {
      const value = await promise;
      this.connectedServiceProfileListCache.set(params.serviceId, {
        kind: 'value',
        value,
        expiresAtMs: Date.now() + CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS,
      });
      return value;
    } catch (error) {
      const latest = this.connectedServiceProfileListCache.get(params.serviceId);
      if (latest?.kind === 'in_flight' && latest.promise === promise) {
        this.connectedServiceProfileListCache.delete(params.serviceId);
      }
      throw error;
    }
  }

  async deleteConnectedServiceCredentialRevisioned(params: Readonly<{
    storageMode: 'e2ee' | 'plain';
    serviceId: ConnectedServiceId;
    profileId: string;
    expectedCredentialRevision: ConnectedServiceCredentialRevisionV1;
    cleanupGroupReferences: boolean;
  }>): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const version = params.storageMode === 'plain' ? 'v3' : 'v2';
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const query = new URLSearchParams();
    if (params.cleanupGroupReferences) {
      query.set('cleanupGroupReferences', 'true');
    }
    query.set(
      'expectedCredentialRevision',
      params.expectedCredentialRevision,
    );
    try {
      const response = await axios.delete(
        `${serverUrl}/${version}/connect/${serviceId}/profiles/${profileId}/credential?${query.toString()}`,
        {
          headers: createHeaders(this.token),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (
        response.status !== 200
        || !z.strictObject({ success: z.literal(true) })
          .safeParse(response.data).success
      ) {
        throw new Error(
          'Invalid connected service credential deletion response',
        );
      }
      this.invalidateConnectedServiceProfileListCache(params.serviceId);
    } catch (error) {
      const status =
        axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) {
        this.invalidateConnectedServiceProfileListCache(params.serviceId);
        return;
      }
      const code = readAxiosErrorCode(error);
      if (status === 409 && code) {
        throw Object.assign(
          new Error(code),
          { code, controlStatus: 'conflict' as const },
        );
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to delete connected service credential',
        error,
      });
      throw error;
    }
  }

  private async fetchConnectedServiceProfilesFromServer(params: Readonly<{
    serviceId: ConnectedServiceId;
  }>): Promise<ConnectedServiceProfileListResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const response = await axios.get(
      `${serverUrl}/v2/connect/${serviceId}/profiles`,
      {
        headers: createHeaders(this.token),
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service profiles response');
    }

    const serviceIdParsed = ConnectedServiceIdSchema.safeParse((raw as any).serviceId);
    if (!serviceIdParsed.success) {
      throw new Error('Invalid connected service profiles response');
    }

    const profilesParsed = z.array(
      z.object({
        profileId: z.string().check(z.minLength(1)),
        status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
        kind: z.optional(z.nullable(z.enum(['oauth', 'token']))),
        providerEmail: z.optional(z.nullable(z.string())),
        providerAccountId: z.optional(z.nullable(z.string())),
        expiresAt: z.optional(z.nullable(z.number())),
        lastUsedAt: z.optional(z.nullable(z.number())),
      }),
    ).safeParse((raw as any).profiles);

    if (!profilesParsed.success) {
      throw new Error('Invalid connected service profiles response');
    }

    return { serviceId: serviceIdParsed.data, profiles: profilesParsed.data };
  }

  async getAccountEncryptionMode(options?: AccountEncryptionModeReadOptions): Promise<ConnectedServiceAccountEncryptionMode> {
    try {
      return await this.readAccountEncryptionMode(options);
    } catch (error) {
      if (options?.signal?.aborted || options?.throwOnTransportError) throw error;
      return 'unknown';
    }
  }

  private async readAccountEncryptionMode(options?: AccountEncryptionModeReadOptions): Promise<ConnectedServiceAccountEncryptionMode> {
    return await this.fetchAccountEncryptionModeFromServer(options?.signal,
      options?.refresh ? 'fresh-authority' : options?.usage ?? 'identity');
  }

  private async fetchAccountEncryptionModeFromServer(signal?: AbortSignal, usage: 'identity' | 'fresh-authority' = 'fresh-authority'): Promise<ConnectedServiceAccountEncryptionMode> {
    const serverUrl = resolveServerHttpBaseUrl();
    try {
      const result = await readAccountEncryptionModeOnce({
        credentials: { token: this.token },
        scope: { token: this.token, serverBaseUrl: serverUrl, ...(signal ? { signal } : {}) },
        usage,
        request: async () => await axios.get(`${serverUrl}/v1/account/encryption`, {
          headers: createHeaders(this.token),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          validateStatus: () => true,
          ...(signal ? { signal } : {}),
        }),
      });
      // Most readers retain the existing unknown projection. Bootstrap readers
      // opting into throwOnTransportError must retain a responding Home failure
      // instead of treating it as missing Account encryption material.
      if (result.kind === 'http_error') {
        throw createHttpStatusError(result.status, 'Account encryption mode is unavailable');
      }
      return result.kind === 'resolved' ? result.mode : 'unknown';
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      logServerEndpointFailure({
        logger,
        operation: 'Failed to get account encryption mode',
        error,
      });
      throw error;
    }
  }

  async getConnectedServiceCredentialPlain(params: Readonly<{
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
          headers: createHeaders(this.token),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          ...(params.signal ? { signal: params.signal } : {}),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service credential response');
      }

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as any).content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
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

      const revision = readConnectedServiceCredentialRevisionBoundaryV1(raw as Record<string, unknown>);
      if (!revision) {
        throw new Error('Invalid connected service credential response');
      }

      return {
        ...revision,
        content: { t: 'plain', v: recordParsed.data },
      };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) {
        return null;
      }
      if (status === 409 && readAxiosErrorCode(error) === 'connect_credential_unsupported_format') {
        throw new ConnectedServiceCredentialUnsupportedFormatError(params.serviceId, params.profileId);
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to get connected service credential (v3)',
        error,
      });
      throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export function createConnectedServiceCredentialApi(
  credential: Readonly<{ token: string }>,
): ConnectedServiceCredentialHttpClient {
  return new ConnectedServiceCredentialHttpClient(credential);
}
