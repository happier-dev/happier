import { URLSearchParams } from 'node:url';

import {
  resolveClaudeSubscriptionOauthClientId,
  resolveClaudeSubscriptionOauthTokenUrl,
  resolveGeminiOauthClientId,
  resolveGeminiOauthClientSecret,
  resolveGeminiOauthTokenUrl,
  resolveOpenAiCodexOauthClientId,
  resolveOpenAiCodexOauthTokenUrl,
} from '@/backends/connectedServices/oauthConfig';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function refreshOpenAiCodexOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
}>> {
  const tokenUrl = resolveOpenAiCodexOauthTokenUrl(process.env);
  const clientId = resolveOpenAiCodexOauthClientId(process.env);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: params.refreshToken,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('OpenAI refresh response missing access_token');
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

export async function refreshClaudeSubscriptionOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}>> {
  const tokenUrl = resolveClaudeSubscriptionOauthTokenUrl(process.env);
  const clientId = resolveClaudeSubscriptionOauthClientId(process.env);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: clientId,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Claude subscription refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Claude subscription refresh response missing access_token');
  }
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token.trim() ? data.refresh_token : params.refreshToken,
    expiresAt,
  };
}

export async function refreshGeminiOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
}>> {
  const tokenUrl = resolveGeminiOauthTokenUrl(process.env);
  const clientId = resolveGeminiOauthClientId(process.env);
  const clientSecret = resolveGeminiOauthClientSecret(process.env);
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: params.refreshToken,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Gemini refresh response missing access_token');
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
