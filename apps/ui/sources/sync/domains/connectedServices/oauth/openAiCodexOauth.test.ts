import { describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import { buildOpenAiCodexAuthorizationUrl, exchangeOpenAiCodexTokens, extractOpenAiAccountIdFromIdToken } from './openAiCodexOauth';

describe('openAiCodexOauth', () => {
  it('builds an authorization URL with redirect_uri, state, and code_challenge', () => {
    const url = buildOpenAiCodexAuthorizationUrl({
      redirectUri: 'http://localhost:1455/auth/callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('https://auth.openai.com/oauth/authorize?');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('http://localhost:1455/auth/callback')}`);
    expect(url).toContain('state=st1');
    expect(url).toContain('code_challenge=ch1');
  });

  it('extracts account id from id_token payload', () => {
    const header = encodeBase64(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })), 'base64url');
    const payload = encodeBase64(new TextEncoder().encode(JSON.stringify({ chatgpt_account_id: 'acct_123' })), 'base64url');
    const idToken = `${header}.${payload}.`;
    expect(extractOpenAiAccountIdFromIdToken(idToken)).toBe('acct_123');
  });

  it('exchanges authorization code for tokens', async () => {
    const header = encodeBase64(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })), 'base64url');
    const payload = encodeBase64(new TextEncoder().encode(JSON.stringify({ chatgpt_account_id: 'acct_999' })), 'base64url');
    const idToken = `${header}.${payload}.`;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id_token: idToken,
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const res = await exchangeOpenAiCodexTokens({
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'http://localhost:1455/auth/callback',
      now: 1700000000000,
    });

    expect(res).toEqual(
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        idToken,
        providerAccountId: 'acct_999',
        expiresAt: 1700000000000 + 60_000,
      }),
    );
  });
});
