import type {
  FetchRuntimeRequestV1,
  FetchRuntimeResponseV1,
  FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildCodexAuthorizationUrl,
  exchangeCodexAuthorizationCodeForTokens,
  OPENAI_CODEX_AUTH_BASE_URL,
  OPENAI_CODEX_CLIENT_ID,
} from './exchange.js';

function encodeJwtPayload(payload: Readonly<Record<string, unknown>>): string {
  return `hdr.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function createJsonResponse(params: Readonly<{
  ok?: boolean;
  status?: number;
  statusText?: string;
  json: unknown;
  text?: string;
}>): FetchRuntimeResponseV1 {
  const text = params.text ?? JSON.stringify(params.json);
  return {
    ok: params.ok ?? true,
    status: params.status ?? 200,
    statusText: params.statusText,
    headers: {},
    body: params.json,
    text: async () => text,
    json: async () => params.json,
    arrayBuffer: async () => Buffer.from(text).buffer,
  };
}

describe('exchangeCodexAuthorizationCodeForTokens', () => {
  it('builds the OpenAI Codex PKCE authorization URL', () => {
    const authorizationUrl = new URL(buildCodexAuthorizationUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'oauth-state',
      challenge: 'pkce-challenge',
    }));

    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(`${OPENAI_CODEX_AUTH_BASE_URL}/oauth/authorize`);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(OPENAI_CODEX_CLIENT_ID);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe('pkce-challenge');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(authorizationUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(authorizationUrl.searchParams.get('state')).toBe('oauth-state');
  });

  it('exchanges PKCE authorization codes using the OpenAI Codex OAuth contract', async () => {
    const requests: FetchRuntimeRequestV1[] = [];
    const runtimeFetch: FetchRuntimeServiceV1 = vi.fn(async (request) => {
      requests.push(request);
      return createJsonResponse({
        json: {
          id_token: encodeJwtPayload({
            'https://api.openai.com/auth': { account_id: 'acct_nested' },
          }),
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 60,
        },
      });
    });

    const now = 1_700_000_000_000;
    const tokens = await exchangeCodexAuthorizationCodeForTokens({
      code: 'auth-code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
      now,
      runtimeFetch,
    });

    expect(tokens).toEqual({
      idToken: encodeJwtPayload({
        'https://api.openai.com/auth': { account_id: 'acct_nested' },
      }),
      accessToken: 'at',
      refreshToken: 'rt',
      accountId: 'acct_nested',
      expiresAt: now + 60_000,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`);
    expect(requests[0]?.method).toBe('POST');
    const body = requests[0]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const form = body as URLSearchParams;
    expect(form.get('client_id')).toBe(OPENAI_CODEX_CLIENT_ID);
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('code_verifier')).toBe('verifier');
    expect(form.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  it('redacts provider token response bodies from PKCE exchange failures', async () => {
    const runtimeFetch: FetchRuntimeServiceV1 = async () => createJsonResponse({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: {},
      text: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh token codex-secret-refresh was rejected',
        access_token: 'codex-secret-access',
        refresh_token: 'codex-secret-refresh',
      }),
    });

    await expect(exchangeCodexAuthorizationCodeForTokens({
      code: 'auth-code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
      now: 1_700_000_000_000,
      runtimeFetch,
    })).rejects.toThrow(/Token exchange failed \(400\): invalid_grant/);

    await expect(exchangeCodexAuthorizationCodeForTokens({
      code: 'auth-code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
      now: 1_700_000_000_000,
      runtimeFetch,
    })).rejects.not.toThrow(/codex-secret-refresh|codex-secret-access|error_description/);
  });
});
