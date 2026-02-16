import { describe, expect, it, vi } from 'vitest';

import { buildGeminiAuthorizationUrl, exchangeGeminiTokens } from './geminiOauth';

describe('geminiOauth', () => {
  it('builds an authorization URL containing redirect_uri and state', () => {
    const url = buildGeminiAuthorizationUrl({
      redirectUri: 'http://localhost:54545/oauth2callback',
      state: 'st1',
      challenge: 'ch1',
    });
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('http://localhost:54545/oauth2callback')}`);
    expect(url).toContain('state=st1');
    expect(url).toContain('code_challenge=ch1');
  });

  it('exchanges authorization code for oauth tokens', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'scope-a',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const res = await exchangeGeminiTokens({
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'http://localhost:54545/oauth2callback',
      now: 1700000000000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const body: unknown =
      init && typeof init === 'object' && 'body' in init ? (init as { body?: unknown }).body : undefined;
    const bodyText =
      typeof body === 'string'
        ? body
        : body && typeof body === 'object' && 'toString' in body && typeof body.toString === 'function'
          ? String(body.toString())
          : '';
    expect(bodyText).not.toContain('client_secret=');

    expect(res).toEqual(
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: 1700000000000 + 3600_000,
      }),
    );
  });
});
