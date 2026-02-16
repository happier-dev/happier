import { describe, expect, it, vi } from 'vitest';

import * as geminiAuth from './authenticate';

describe('exchangeGeminiAuthorizationCodeForTokens', () => {
  it('exchanges tokens without sending client_secret', async () => {
    const exchange = (geminiAuth as unknown as {
      exchangeGeminiAuthorizationCodeForTokens?: (params: Readonly<{
        code: string;
        verifier: string;
        redirectUri: string;
      }>) => Promise<{ access_token: string; refresh_token?: string }>;
    }).exchangeGeminiAuthorizationCodeForTokens;

    expect(typeof exchange).toBe('function');

    const fetchMock = vi.fn(async (_url: string, _init?: any) => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
        token_type: 'Bearer',
        scope: 'scope',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const tokens = await exchange!({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:54545/oauth2callback',
    });

    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] ?? [];
    const init = call[1] ?? null;
    const body = String(init?.body?.toString?.() ?? init?.body ?? '');
    expect(body).not.toContain('client_secret=');
  });
});
