import { URLSearchParams } from 'node:url';

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';

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
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: params.refreshToken,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: String(data.refresh_token ?? params.refreshToken),
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    expiresAt,
  };
}

export async function refreshAnthropicOauthTokens(params: Readonly<{
  refreshToken: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}>> {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: String(data.refresh_token ?? params.refreshToken),
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
  const response = await fetch(GEMINI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GEMINI_CLIENT_ID,
      refresh_token: params.refreshToken,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const expiresAt =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
      ? params.now + Math.max(0, Math.trunc(data.expires_in)) * 1000
      : null;
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: String(data.refresh_token ?? params.refreshToken),
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    expiresAt,
  };
}
