import { describe, expect, it, vi } from 'vitest';

import * as geminiAuth from './authenticate';

describe('exchangeGeminiAuthorizationCodeForTokens', () => {
  it('exchanges tokens and sends client_secret', async () => {
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
    expect(body).toContain('client_secret=');
  });

  it('uses the env override token URL when provided', async () => {
    const exchange = (geminiAuth as unknown as {
      exchangeGeminiAuthorizationCodeForTokens?: (params: Readonly<{
        code: string;
        verifier: string;
        redirectUri: string;
      }>) => Promise<{ access_token: string; refresh_token?: string }>;
    }).exchangeGeminiAuthorizationCodeForTokens;

    expect(typeof exchange).toBe('function');

    const previous = process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL;
    process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL = 'https://oauth.example.test/token';

    try {
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

      await exchange!({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'http://localhost:54545/oauth2callback',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toBe('https://oauth.example.test/token');
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL = previous;
    }
  });

  it('redacts token exchange failure response bodies', async () => {
    const exchange = (geminiAuth as unknown as {
      exchangeGeminiAuthorizationCodeForTokens?: (params: Readonly<{
        code: string;
        verifier: string;
        redirectUri: string;
      }>) => Promise<{ access_token: string; refresh_token?: string }>;
    }).exchangeGeminiAuthorizationCodeForTokens;

    expect(typeof exchange).toBe('function');

    const fetchMock = vi.fn(async (_url: string, _init?: any) => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({}),
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh token gemini-secret-refresh was rejected',
        access_token: 'gemini-secret-access',
        refresh_token: 'gemini-secret-refresh',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    let caught: unknown = null;
    try {
      await exchange!({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'http://localhost:54545/oauth2callback',
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(/Token exchange failed \(400\): invalid_grant/);
    expect(String(caught)).not.toMatch(/gemini-secret-refresh|gemini-secret-access|error_description/);
  });
});
