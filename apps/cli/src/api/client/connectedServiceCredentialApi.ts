import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import { z } from 'zod';

import { AccountEncryptionCurrentnessResponseSchema, AccountEncryptionCurrentnessErrorResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { assertConnectedServiceCredentialRecordBinding } from '@happier-dev/protocol/connect/connectedServiceCredentialBinding';
import { ConnectedServiceCredentialRecordV1Schema, SealedConnectedServiceCredentialV1Schema, readConnectedServiceCredentialRevisionBoundaryV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ConnectedServiceCredentialRecordV1, ConnectedServiceCredentialRevisionV1, ConnectedServiceCredentialRevisionBoundaryV1, ConnectedServiceId, SealedConnectedServiceCredentialV1, AccountEncryptionCurrentnessResponse, AccountEncryptionCurrentnessErrorResponse } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentials } from '@/persistence';

import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { createHttpStatusError } from './httpStatusError';
import { logServerEndpointFailure } from './serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from './accountEncryptionMode';

const CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS = 10_000;
const ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS = 10_000;

export type ConnectedServiceAccountEncryptionMode = 'e2ee' | 'plain' | 'unknown';

export type AccountEncryptionModeReadOptions = Readonly<{
  refresh?: boolean;
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

type AccountEncryptionModeCacheEntry = Readonly<
  | { kind: 'value'; expiresAtMs: number; value: 'e2ee' | 'plain' }
  | { kind: 'in_flight'; promise: Promise<ConnectedServiceAccountEncryptionMode> }
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

export class AccountEncryptionCurrentnessUnavailableError extends Error {
  readonly code = 'account_encryption_currentness_unavailable' as const;

  constructor(
    message = 'Account encryption currentness is unavailable',
    readonly recipientEnvelopeReadiness?: AccountEncryptionCurrentnessErrorResponse['recipientEnvelopeReadiness'],
    options?: ErrorOptions,
  ) {
    // The wrapped transport failure stays reachable as `cause` so the caller
    // that owns the offline/auth classification (getOrCreateSession) can
    // classify this preflight exactly as it classifies its own request.
    super(message, options);
    this.name = 'AccountEncryptionCurrentnessUnavailableError';
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

export async function fetchAccountEncryptionCurrentness(params: Readonly<{
  token: string;
  authorizationHeaders?: Readonly<Record<string, string>>;
  serverBaseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<AccountEncryptionCurrentnessResponse> {
  const serverBaseUrl = (params.serverBaseUrl ?? resolveServerHttpBaseUrl())
    .replace(/\/+$/, '');
  const readCurrentness = async () => await axios.get(
    `${serverBaseUrl}/v1/account/encryption/currentness`,
    {
      headers: params.authorizationHeaders ?? createHeaders(params.token),
      timeout: params.timeoutMs ?? resolveConnectedServicesServerApiTimeoutMs(),
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  let response;
  try {
    response = await readCurrentness();
  } catch (error) {
    if (params.signal?.aborted) throw error;
    throw new AccountEncryptionCurrentnessUnavailableError(undefined, undefined, { cause: error });
  }
  const legacyReadiness = response.status === 400
    ? AccountEncryptionCurrentnessErrorResponseSchema.safeParse(response.data)
    : null;
  const suppliedAuthorization = params.authorizationHeaders
    ? Object.entries(params.authorizationHeaders).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
    : null;
  if (
    legacyReadiness?.success
    && legacyReadiness.data.recipientEnvelopeReadiness.reason === 'encryption_setup_required'
    && (!params.authorizationHeaders || suppliedAuthorization === `Bearer ${params.token}`)
  ) {
    const stored = await readStoredCredentials().catch(() => null);
    const expectedAccountId = readAccountIdFromToken(params.token);
    if (
      stored?.token === params.token
      && stored.credentialProvenance === 'stored_session'
      && stored.encryption?.type === 'legacy'
      && expectedAccountId
    ) {
      try {
        const snapshot = await fetchServerFeaturesSnapshot({
          serverUrl: serverBaseUrl,
          token: params.token,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        const serverIdentityId = snapshot.status === 'ready'
          ? snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim()
          : null;
        if (serverIdentityId) {
          const { authenticateExistingAccountWithLegacySecret } = await import('@/cli/commands/auth/nativeEmail');
          // The Home's expectedAccountId branch requires an already-bound key;
          // this existing-Account proof repairs the missing binding, then we
          // compare its issued Account with the stored bearer's subject.
          const repairedToken = await authenticateExistingAccountWithLegacySecret({
            secret: stored.encryption.secret,
            serverApiUrl: serverBaseUrl,
            serverIdentityId,
            ...(params.signal ? { signal: params.signal } : {}),
          });
          if (readAccountIdFromToken(repairedToken) !== expectedAccountId) {
            throw new Error('Recovered Account does not match the stored bearer');
          }
          response = await readCurrentness();
        }
      } catch (error) {
        params.signal?.throwIfAborted();
        // Preserve the original typed recovery result when proof cannot be completed.
      }
    }
  }
  if (response.status !== 200) {
    const parsedError = response.status === 400
      ? AccountEncryptionCurrentnessErrorResponseSchema.safeParse(response.data)
      : null;
    const message = `Account encryption currentness is unavailable (${response.status})`;
    throw new AccountEncryptionCurrentnessUnavailableError(
      message,
      parsedError?.success ? parsedError.data.recipientEnvelopeReadiness : undefined,
      // `validateStatus` suppresses Axios' own rejection, so carry the status
      // on the canonical minimal Axios-like error the status policies read.
      { cause: createHttpStatusError(response.status, message) },
    );
  }
  const parsed = AccountEncryptionCurrentnessResponseSchema.safeParse(
    response.data,
  );
  if (!parsed.success) {
    throw new AccountEncryptionCurrentnessUnavailableError(
      'Account encryption currentness response is invalid',
    );
  }
  return parsed.data;
}

export class ConnectedServiceCredentialHttpClient implements ConnectedServiceCredentialApi {
  private readonly token: string;
  private readonly connectedServiceProfileListCache = new Map<ConnectedServiceId, ConnectedServiceProfileListCacheEntry>();
  private accountEncryptionModeCache: AccountEncryptionModeCacheEntry | null = null;

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
        providerEmail: z.string().nullable().optional(),
        providerAccountId: z.string().nullable().optional(),
        expiresAt: z.number().nullable().optional(),
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
        || !z.object({ success: z.literal(true) }).strict()
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
        profileId: z.string().min(1),
        status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
        kind: z.enum(['oauth', 'token']).nullable().optional(),
        providerEmail: z.string().nullable().optional(),
        providerAccountId: z.string().nullable().optional(),
        expiresAt: z.number().nullable().optional(),
        lastUsedAt: z.number().nullable().optional(),
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
    if (options?.signal) return await this.fetchAccountEncryptionModeFromServer(options.signal);
    const cached = this.accountEncryptionModeCache;
    const nowMs = Date.now();
    if (!options?.refresh && cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
    if (!options?.refresh && cached?.kind === 'in_flight') return await cached.promise;

    const promise = this.fetchAccountEncryptionModeFromServer();
    this.accountEncryptionModeCache = { kind: 'in_flight', promise };
    try {
      const value = await promise;
      if (this.accountEncryptionModeCache?.kind === 'in_flight' && this.accountEncryptionModeCache.promise === promise) {
        this.accountEncryptionModeCache = value === 'unknown'
          ? null
          : { kind: 'value', value, expiresAtMs: Date.now() + ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS };
      }
      return value;
    } catch (error) {
      if (this.accountEncryptionModeCache?.kind === 'in_flight' && this.accountEncryptionModeCache.promise === promise) {
        this.accountEncryptionModeCache = null;
      }
      throw error;
    }
  }

  private async fetchAccountEncryptionModeFromServer(signal?: AbortSignal): Promise<ConnectedServiceAccountEncryptionMode> {
    const serverUrl = resolveServerHttpBaseUrl();
    try {
      const result = await readAccountEncryptionModeOnce({
        request: async () => await axios.get(`${serverUrl}/v1/account/encryption`, {
          headers: createHeaders(this.token),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          validateStatus: () => true,
          ...(signal ? { signal } : {}),
        }),
      });
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
