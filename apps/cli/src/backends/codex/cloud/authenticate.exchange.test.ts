import { describe, expect, it, vi } from 'vitest';

import { exchangeCodexAuthorizationCodeForTokens } from './authenticate';

describe('exchangeCodexAuthorizationCodeForTokens', () => {
  it('returns expiresAt when expires_in is present', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id_token: 'hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig',
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 1700000000000;
    const tokens = await exchangeCodexAuthorizationCodeForTokens({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:1455/auth/callback',
      now,
    });

    expect(tokens.expiresAt).toBe(now + 60_000);
  });
});

