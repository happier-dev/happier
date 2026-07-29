import type { CodexRuntimeFetch } from '../../runtimeFetch.js';

import {
  assertNonEmptyString,
  buildSafeOauthProviderFailureMessage,
  extractOpenAiAccountIdFromIdToken,
  OPENAI_CODEX_AUTH_BASE_URL,
  OPENAI_CODEX_CLIENT_ID,
} from './oauth.js';
import type { CodexAuthTokens } from './types.js';

export { buildCodexAuthorizationUrl, OPENAI_CODEX_AUTH_BASE_URL, OPENAI_CODEX_CLIENT_ID } from './oauth.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function exchangeCodexAuthorizationCodeForAuthTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
  runtimeFetch: CodexRuntimeFetch;
}>): Promise<CodexAuthTokens> {
  const response = await params.runtimeFetch({
    url: `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      statusText: response.statusText,
      body,
    }));
  }

  const data = await response.json();
  const record = isRecord(data) ? data : {};
  const idToken = assertNonEmptyString(record.id_token, 'id_token');
  const refreshToken = assertNonEmptyString(record.refresh_token, 'refresh_token');
  const accessToken = typeof record.access_token === 'string' && record.access_token ? record.access_token : idToken;
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : undefined;

  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: extractOpenAiAccountIdFromIdToken(idToken),
    expires_in: expiresIn,
    expires_at: expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
      ? params.now + Math.trunc(expiresIn) * 1000
      : null,
  };
}

export async function exchangeCodexAuthorizationCodeForTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
  runtimeFetch: CodexRuntimeFetch;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number | null;
}>> {
  const tokens = await exchangeCodexAuthorizationCodeForAuthTokens(params);
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
    expiresAt: tokens.expires_at ?? null,
  };
}
