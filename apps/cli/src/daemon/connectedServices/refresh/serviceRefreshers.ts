import { URLSearchParams } from 'node:url';

import type { FetchRuntimeServiceV1 } from '@/plugins/runtime/exec/privateContract';
import {
  CLAUDE_OAUTH_TOKEN_URL,
  projectConnectedAccountOauthProfileMetadata,
  type ConnectedServiceId,
  type ConnectedServiceOauthCredentialRawMetadata,
} from '@happier-dev/protocol';

import {
  isBuiltInLegacyConnectedAccountPeerOperationSupported,
} from '@/api/client/qualifiedConnectedAccountApi';
import { readSafeOauthProviderErrorCode } from '@/cloud/safeOauthProviderError';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';

const CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

type LegacyOauthPayloadMapping = Readonly<{
  accessTokenField: string;
  refreshTokenField: string;
  idTokenField?: string;
  scopeField?: string;
  tokenTypeField?: string;
  providerAccountIdField?: string | Readonly<{
    objectField?: string;
    field: string;
  }>;
  providerEmailField?: string | Readonly<{
    objectField?: string;
    field: string;
  }>;
  expiresAt: Readonly<{
    absoluteField?: string;
    expiresInField?: string;
  }>;
}>;

type LegacyOauthRefreshConfig = Readonly<{
  clientId: string;
  tokenUrl: string;
  refreshBody: 'form' | 'json';
  payloadMapping: LegacyOauthPayloadMapping;
  profileMetadata?: Readonly<{
    endpointUrl: string;
    headers: Readonly<Record<string, string>>;
    projection: 'claude_oauth_profile_entitlement';
  }>;
}>;

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * The generated projection is the only legacy-id eligibility owner. These
 * handwritten provider details merely refine the two OAuth modes admitted by
 * the revisioned V2/V3 operation table.
 * Delete this adapter when that window no longer includes a V2/V3 server or a
 * persisted legacy OAuth credential requiring client-side rotation.
 */
export function isRevisionedLegacyOauthRefreshService(
  serviceId: ConnectedServiceId,
): serviceId is 'openai-codex' | 'claude-subscription' {
  return isBuiltInLegacyConnectedAccountPeerOperationSupported({
    serviceId,
    peerClass: 'revisioned_v2_v3',
    operation: 'oauth_refresh',
  });
}

function resolveLegacyOauthRefreshConfig(
  serviceId: ConnectedServiceId,
): LegacyOauthRefreshConfig {
  if (!isRevisionedLegacyOauthRefreshService(serviceId)) {
    throw new Error(
      `Connected account does not support OAuth refresh on released peers: ${serviceId}`,
    );
  }
  if (serviceId === 'openai-codex') {
    return Object.freeze({
      clientId: resolveNonEmptyEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID,
        'app_EMoamEEZ73f0CkXaXp7hrann',
      ),
      tokenUrl: resolveNonEmptyEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL,
        'https://auth.openai.com/oauth/token',
      ),
      refreshBody: 'form',
      payloadMapping: Object.freeze({
        accessTokenField: 'access_token',
        refreshTokenField: 'refresh_token',
        idTokenField: 'id_token',
        providerAccountIdField: 'account_id',
        expiresAt: Object.freeze({
          absoluteField: 'expires_at',
          expiresInField: 'expires_in',
        }),
      }),
    });
  }
  return Object.freeze({
    clientId: resolveNonEmptyEnv(
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID,
      '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    ),
    tokenUrl: resolveNonEmptyEnv(
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL,
      CLAUDE_OAUTH_TOKEN_URL,
    ),
    refreshBody: 'json',
    payloadMapping: Object.freeze({
      accessTokenField: 'access_token',
      refreshTokenField: 'refresh_token',
      scopeField: 'scope',
      tokenTypeField: 'token_type',
      providerAccountIdField: Object.freeze({
        objectField: 'account',
        field: 'uuid',
      }),
      providerEmailField: Object.freeze({
        objectField: 'account',
        field: 'email_address',
      }),
      expiresAt: Object.freeze({ expiresInField: 'expires_in' }),
    }),
    profileMetadata: Object.freeze({
      endpointUrl: 'https://api.anthropic.com/api/oauth/profile',
      headers: Object.freeze({
        'anthropic-beta': 'oauth-2025-04-20',
      }),
      projection: 'claude_oauth_profile_entitlement',
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readMappedString(
  data: Readonly<Record<string, unknown>>,
  mapping: string | Readonly<{ objectField?: string; field: string }> | undefined,
  preserveEmpty: boolean,
): string | null {
  if (!mapping) return null;
  const owner =
    typeof mapping === 'string'
      ? data
      : mapping.objectField
        ? data[mapping.objectField]
        : data;
  const value =
    typeof mapping === 'string'
      ? data[mapping]
      : isRecord(owner)
        ? owner[mapping.field]
        : undefined;
  return typeof value === 'string' && (preserveEmpty || value.length > 0)
    ? value
    : null;
}

function mapLegacyOauthPayload(input: Readonly<{
  mapping: LegacyOauthPayloadMapping;
  now: number;
  payload: unknown;
  fallbackRefreshToken: string;
}>): Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  expiresAt: number | null;
}> {
  const data = isRecord(input.payload) ? input.payload : {};
  const expiresAtValue = input.mapping.expiresAt.absoluteField
    ? data[input.mapping.expiresAt.absoluteField]
    : undefined;
  const expiresInValue = input.mapping.expiresAt.expiresInField
    ? data[input.mapping.expiresAt.expiresInField]
    : undefined;
  const expiresAt =
    typeof expiresAtValue === 'number'
    && Number.isFinite(expiresAtValue)
    && expiresAtValue > 0
      ? expiresAtValue
      : typeof expiresInValue === 'number'
        && Number.isFinite(expiresInValue)
        && expiresInValue >= 0
          ? input.now + Math.trunc(expiresInValue) * 1000
          : null;
  const accessToken = data[input.mapping.accessTokenField];
  const refreshToken = data[input.mapping.refreshTokenField];
  return Object.freeze({
    accessToken: typeof accessToken === 'string' ? accessToken : '',
    refreshToken:
      typeof refreshToken === 'string' && refreshToken.length > 0
        ? refreshToken
        : input.fallbackRefreshToken,
    idToken: readMappedString(data, input.mapping.idTokenField, true),
    scope: readMappedString(data, input.mapping.scopeField, true),
    tokenType: readMappedString(data, input.mapping.tokenTypeField, true),
    expiresAt,
  });
}

export async function refreshReleasedPeerLegacyConnectedAccountOauthTokens(params: Readonly<{
  serviceId: ConnectedServiceId;
  refreshToken: string;
  now: number;
  runtimeFetch?: FetchRuntimeServiceV1;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  expiresAt: number | null;
  raw?: ConnectedServiceOauthCredentialRawMetadata | null;
}>> {
  const config = resolveLegacyOauthRefreshConfig(params.serviceId);
  const runtimeFetch = params.runtimeFetch ?? createGlobalFetchRuntime();
  const bodyFields: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: config.clientId,
  };
  const response = await runtimeFetch(
    config.refreshBody === 'json'
      ? {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyFields),
          signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS),
        }
      : {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(bodyFields),
          signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS),
        },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const providerErrorCode = readSafeOauthProviderErrorCode(body);
    const safeError = providerErrorCode ?? response.statusText;
    throw new Error(`Connected account refresh failed (${params.serviceId}, ${response.status}): ${safeError || 'provider_error'}`);
  }
  const json: unknown = await response.json();
  const mapped = mapLegacyOauthPayload({
    mapping: config.payloadMapping,
    now: params.now,
    payload: json,
    fallbackRefreshToken: params.refreshToken,
  });
  const accessToken = mapped.accessToken.trim();
  if (!accessToken) {
    throw new Error(`Connected account refresh response missing access_token for ${params.serviceId}`);
  }
  let raw: ConnectedServiceOauthCredentialRawMetadata | null | undefined;
  const profileMetadata = config.profileMetadata;
  if (profileMetadata) {
    let profileResponse: Awaited<ReturnType<FetchRuntimeServiceV1>> | null = null;
    try {
      profileResponse = await runtimeFetch({
        url: profileMetadata.endpointUrl,
        method: 'GET',
        headers: {
          ...profileMetadata.headers,
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS),
      });
    } catch {
      profileResponse = null;
    }

    if (profileResponse?.status === 401) {
      const body = await profileResponse.text().catch(() => '');
      const providerErrorCode = readSafeOauthProviderErrorCode(body);
      const safeError = providerErrorCode ?? profileResponse.statusText;
      throw new Error(
        `Connected account refreshed access-token verification failed (${params.serviceId}, 401): ${safeError || 'provider_error'}`,
      );
    }

    if (profileResponse?.ok) {
      try {
        raw = projectConnectedAccountOauthProfileMetadata({
          projection: profileMetadata.projection,
          value: await profileResponse.json(),
        }) ?? undefined;
      } catch {
        raw = undefined;
      }
    }
  }
  return {
    accessToken,
    refreshToken: mapped.refreshToken.trim() ? mapped.refreshToken : params.refreshToken,
    idToken: mapped.idToken,
    scope: mapped.scope,
    tokenType: mapped.tokenType,
    expiresAt: mapped.expiresAt,
    ...(raw !== undefined ? { raw } : {}),
  };
}
