import { URLSearchParams } from 'node:url';

import type { HttpService } from '@happier-dev/plugin-sdk/http';
import {
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_PROFILE_HEADERS,
  CLAUDE_OAUTH_PROFILE_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_URL,
  projectConnectedAccountOauthProfileMetadata,
  type ConnectedServiceId,
  type ConnectedServiceOauthCredentialRawMetadata,
} from '@happier-dev/protocol';

import {
  isBuiltInLegacyConnectedAccountPeerOperationSupported,
} from '@/api/client/qualifiedConnectedAccountApi';
import { readSafeOauthProviderErrorCode } from '@/cloud/safeOauthProviderError';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';

export const CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS = 120_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function readFetchResponseText(response: Awaited<ReturnType<HttpService['request']>>): string {
  return textDecoder.decode(response.body);
}

function readFetchResponseJson(response: Awaited<ReturnType<HttpService['request']>>): unknown {
  return JSON.parse(readFetchResponseText(response)) as unknown;
}

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
        OPENAI_CODEX_CLIENT_ID,
      ),
      tokenUrl: resolveNonEmptyEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL,
        OPENAI_CODEX_TOKEN_URL,
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
      CLAUDE_OAUTH_CLIENT_ID,
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
      endpointUrl: CLAUDE_OAUTH_PROFILE_URL,
      headers: CLAUDE_OAUTH_PROFILE_HEADERS,
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
  runtimeFetch?: Pick<HttpService, 'request'>;
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
  const response = await runtimeFetch.request(
    config.refreshBody === 'json'
      ? {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: textEncoder.encode(JSON.stringify(bodyFields)),
          redirect: 'error',
        }
      : {
          url: config.tokenUrl,
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: textEncoder.encode(new URLSearchParams(bodyFields).toString()),
          redirect: 'error',
        },
    { signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS) },
  );
  if (response.status < 200 || response.status >= 300) {
    const body = readFetchResponseText(response);
    const providerErrorCode = readSafeOauthProviderErrorCode(body);
    const safeError = providerErrorCode ?? 'provider_error';
    throw new Error(`Connected account refresh failed (${params.serviceId}, ${response.status}): ${safeError || 'provider_error'}`);
  }
  const json = readFetchResponseJson(response);
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
    let profileResponse: Awaited<ReturnType<HttpService['request']>> | null = null;
    try {
      profileResponse = await runtimeFetch.request({
        url: profileMetadata.endpointUrl,
        method: 'GET',
        headers: {
          ...profileMetadata.headers,
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: 'error',
      }, { signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS) });
    } catch {
      profileResponse = null;
    }

    if (profileResponse?.status === 401) {
      const body = readFetchResponseText(profileResponse);
      const providerErrorCode = readSafeOauthProviderErrorCode(body);
      const safeError = providerErrorCode ?? 'provider_error';
      throw new Error(
        `Connected account refreshed access-token verification failed (${params.serviceId}, 401): ${safeError || 'provider_error'}`,
      );
    }

    if (profileResponse && profileResponse.status >= 200 && profileResponse.status < 300) {
      try {
        raw = projectConnectedAccountOauthProfileMetadata({
          projection: profileMetadata.projection,
          value: readFetchResponseJson(profileResponse),
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
