import { URLSearchParams } from 'node:url';

import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedAccountOauthConfig } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ConnectedAccountOauthRefreshResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
}>;

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
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${params.serviceId} refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new Error(`${params.serviceId} refresh response missing access_token`);
  }
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim() ? data.refresh_token : params.refreshToken,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
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
