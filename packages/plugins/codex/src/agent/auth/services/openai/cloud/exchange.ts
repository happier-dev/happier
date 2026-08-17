import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { OPENAI_CODEX_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  assertNonEmptyString,
  buildSafeOauthProviderFailureMessage,
  extractOpenAiAccountIdFromIdToken,
} from './oauth.js';
import type { CodexAuthTokens } from './types.js';

export {
  buildCodexAuthorizationUrl,
} from './oauth.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function exchangeCodexAuthorizationCodeForAuthTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
  runtimeFetch: Pick<HttpService, 'request'>;
}>): Promise<CodexAuthTokens> {
  const response = await params.runtimeFetch.request({
    url: OPENAI_CODEX_OAUTH_PROFILE.tokenUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new TextEncoder().encode(new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }).toString()),
    redirect: 'error',
  });

  const body = new TextDecoder().decode(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      statusText: undefined,
      body,
    }));
  }

  const data: unknown = JSON.parse(body);
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
  runtimeFetch: Pick<HttpService, 'request'>;
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
