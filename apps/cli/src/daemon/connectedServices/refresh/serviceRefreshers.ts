import { URLSearchParams } from 'node:url';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceOauthCredentialRawMetadata } from '@happier-dev/protocol';

import { readSafeOauthProviderErrorCode } from '@/cloud/safeOauthProviderError';
import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import type { ConnectedServiceRefreshFailureCategory } from '@/daemon/connectedServices/credentials/lifecycleTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS = 120_000;

function buildRefreshAbortSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS)
    : undefined;
}

function classifyProviderRefreshFailure(params: Readonly<{
  status: number | null;
  providerErrorCode: string | null;
}>): ConnectedServiceRefreshFailureCategory {
  if (params.providerErrorCode === 'invalid_grant') return 'invalid_grant';
  if (params.providerErrorCode === 'invalid_client') return 'invalid_client';
  if (params.status === 401) return 'provider_401';
  if (params.status === 403) return 'provider_403';
  return 'unknown';
}

export class ConnectedServiceOauthRefreshError extends Error {
  readonly category: ConnectedServiceRefreshFailureCategory;
  readonly status: number | null;
  readonly providerErrorCode: string | null;

  constructor(params: Readonly<{
    serviceId: ConnectedServiceId;
    category: ConnectedServiceRefreshFailureCategory;
    status: number | null;
    providerErrorCode: string | null;
    detail: string;
  }>) {
    const statusText = params.status === null ? 'unknown_status' : String(params.status);
    super(`${params.serviceId} refresh failed (${statusText}): ${params.detail}`);
    this.name = 'ConnectedServiceOauthRefreshError';
    this.category = params.category;
    this.status = params.status;
    this.providerErrorCode = params.providerErrorCode;
  }
}

export type ConnectedAccountOauthRefreshResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope?: string | null;
  tokenType?: string | null;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  expiresAt: number | null;
  raw?: ConnectedServiceOauthCredentialRawMetadata | null;
}>;

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildRefreshRequestBody(input: Readonly<{
  refreshTokenBody: 'form' | 'json';
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}>): Readonly<{
  headers: Record<string, string>;
  body: string | URLSearchParams;
}> {
  const payload: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  };
  if (input.clientSecret) {
    payload.client_secret = input.clientSecret;
  }

  if (input.refreshTokenBody === 'json') {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }

  return {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload),
  };
}

export async function refreshConnectedAccountOauthTokens(params: Readonly<{
  serviceId: ConnectedServiceId;
  refreshToken: string;
  now: number;
}>): Promise<ConnectedAccountOauthRefreshResult> {
  const config = resolveConnectedAccountOauthConfig(params.serviceId, process.env);
  const request = buildRefreshRequestBody({
    refreshTokenBody: config.refreshTokenBody,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: params.refreshToken,
  });
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: buildRefreshAbortSignal(),
    });
  } catch {
    throw new ConnectedServiceOauthRefreshError({
      serviceId: params.serviceId,
      category: 'network_error',
      status: null,
      providerErrorCode: null,
      detail: 'network_error',
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const providerErrorCode = readSafeOauthProviderErrorCode(body);
    const safeError = providerErrorCode ?? response.statusText;
    throw new ConnectedServiceOauthRefreshError({
      serviceId: params.serviceId,
      category: classifyProviderRefreshFailure({ status: response.status, providerErrorCode }),
      status: response.status,
      providerErrorCode,
      detail: safeError || 'provider_error',
    });
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ConnectedServiceOauthRefreshError({
      serviceId: params.serviceId,
      category: 'malformed_response',
      status: response.status,
      providerErrorCode: null,
      detail: 'malformed_response',
    });
  }
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new ConnectedServiceOauthRefreshError({
      serviceId: params.serviceId,
      category: 'missing_access_token',
      status: response.status,
      providerErrorCode: null,
      detail: 'missing_access_token',
    });
  }
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  const idToken = typeof data.id_token === 'string' ? data.id_token : null;
  // CS-FIX-4: provider identity extraction lives in the provider's descriptor hook, not a
  // serviceId branch here — the central refresher stays pure config mapping.
  const refreshResponseIdentity = config.extractRefreshResponseIdentity?.({ idToken, payload: data }) ?? {};
  let raw: ConnectedServiceOauthCredentialRawMetadata | null | undefined;
  if (config.resolveRefreshCredentialEvidence) {
    let evidence: Awaited<ReturnType<typeof config.resolveRefreshCredentialEvidence>> | undefined;
    try {
      evidence = await config.resolveRefreshCredentialEvidence({
        accessToken,
        fetcher: fetch,
        signal: buildRefreshAbortSignal(),
      });
    } catch {
      evidence = undefined;
    }
    if (evidence?.status === 'rejected') {
      throw new ConnectedServiceOauthRefreshError({
        serviceId: params.serviceId,
        category: classifyProviderRefreshFailure({
          status: evidence.providerStatus,
          providerErrorCode: evidence.providerErrorCode,
        }),
        status: evidence.providerStatus,
        providerErrorCode: evidence.providerErrorCode,
        detail: 'refreshed_access_token_rejected',
      });
    }
    // Missing entitlement evidence must not turn a successful token rotation into a failure.
    raw = evidence?.status === 'accepted' ? evidence.raw : undefined;
  }
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim() ? data.refresh_token : params.refreshToken,
    idToken,
    scope: readTrimmedString(data.scope),
    tokenType: readTrimmedString(data.token_type),
    ...refreshResponseIdentity,
    ...(raw !== undefined ? { raw } : {}),
    expiresAt,
  };
}

export async function refreshOpenAiCodexOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<ConnectedAccountOauthRefreshResult> {
  return refreshConnectedAccountOauthTokens({
    serviceId: 'openai-codex',
    refreshToken: params.refreshToken,
    now: params.now,
  });
}

export async function refreshClaudeSubscriptionOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<ConnectedAccountOauthRefreshResult> {
  return refreshConnectedAccountOauthTokens({
    serviceId: 'claude-subscription',
    refreshToken: params.refreshToken,
    now: params.now,
  });
}

export async function refreshGeminiOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<ConnectedAccountOauthRefreshResult> {
  return refreshConnectedAccountOauthTokens({
    serviceId: 'gemini',
    refreshToken: params.refreshToken,
    now: params.now,
  });
}
