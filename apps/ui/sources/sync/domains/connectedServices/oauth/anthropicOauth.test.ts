import { describe, expect, it, vi } from 'vitest';

import { buildAnthropicAuthorizationUrl, exchangeAnthropicTokens } from './anthropicOauth';

describe('anthropicOauth', () => {
  it('builds an authorization URL containing redirect_uri and state', () => {
    const url = buildAnthropicAuthorizationUrl({
      redirectUri: 'http://localhost:54545/callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('https://claude.ai/oauth/authorize?');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('http://localhost:54545/callback')}`);
    expect(url).toContain('state=st1');
    expect(url).toContain('code_challenge=ch1');
  });

  it('exchanges authorization code for oauth tokens', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token_type: 'Bearer',
        access_token: 'at',
        expires_in: 120,
        refresh_token: 'rt',
        scope: 'user:inference',
        account: { uuid: 'acct', email_address: 'user@example.com' },
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const res = await exchangeAnthropicTokens({
      code: 'code-1',
      verifier: 'verifier-1',
      state: 'st1',
      redirectUri: 'http://localhost:54545/callback',
      now: 1700000000000,
    });

    expect(res).toEqual(
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
        expiresAt: 1700000000000 + 120_000,
      }),
    );
  });
});

