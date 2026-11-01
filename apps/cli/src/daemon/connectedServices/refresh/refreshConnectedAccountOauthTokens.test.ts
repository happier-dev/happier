import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_TOKEN_URL } from '@happier-dev/agents';

afterEach(() => { vi.unstubAllEnvs(); });

describe('refreshConnectedAccountOauthTokens', () => {
  it('refuses to bind a refreshed token organization to a different retained provider user', async () => {
    const { refreshConnectedAccountOauthTokens } = await import('./serviceRefreshers');
    const fetcher: typeof fetch = async (url) => String(url).includes('/profile')
      ? Response.json({ account: { uuid: 'different-user' }, organization: { uuid: 'different-organization' } })
      : Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(refreshConnectedAccountOauthTokens({ serviceId: 'claude-subscription',
        refreshToken: 'refresh', now: 1000, expectedProviderAccountId: 'original-user' }))
        .rejects.toMatchObject({ providerErrorCode: 'provider_account_mismatch' });
    } finally { vi.unstubAllGlobals(); }
  });
  it('honors containing-operation cancellation before refreshing a native imported grant', async () => {
    const { refreshConnectedAccountOauthTokens } = await import('./serviceRefreshers');
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    try {
      await expect(refreshConnectedAccountOauthTokens({ serviceId: 'antigravity', refreshToken: 'unconsumed-grant', now: 1000, signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([false, true])('refreshes Antigravity using its registered issuer and keeps the unrotated refresh token (legacy-looking overrides: %s)', async (withOverrides) => {
    if (withOverrides) {
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_ID', 'machine-client');
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_CLIENT_SECRET', 'machine-client-secret');
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_ANTIGRAVITY_OAUTH_TOKEN_URL', 'https://machine-issuer.example.test/token');
    }
    const { refreshConnectedAccountOauthTokens } = await import('./serviceRefreshers');
    let tokenRequest: Readonly<{ url: string; body: URLSearchParams }> | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const body = new URLSearchParams(String(init?.body));
      tokenRequest = { url: String(input), body };
      expect(body.get('refresh_token')).toBe('agy-refresh');
      return Response.json({ access_token: 'agy-new-access', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(refreshConnectedAccountOauthTokens({ serviceId: 'antigravity', refreshToken: 'agy-refresh', now: 1000 }))
        .resolves.toMatchObject({ accessToken: 'agy-new-access', refreshToken: 'agy-refresh', expiresAt: 3601000 });
      expect(tokenRequest?.url).toBe(AGY_OAUTH_TOKEN_URL);
      expect(tokenRequest?.body.get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
      expect(tokenRequest?.body.get('client_secret')).toBe(AGY_OAUTH_CLIENT_SECRET);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('uses the descriptor refresh body format for JSON OAuth providers', async () => {
    const mod = await import('./serviceRefreshers');
    expect(mod.refreshConnectedAccountOauthTokens).toEqual(expect.any(Function));

    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    const previousClientId = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = 'client-123';

    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 123,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const refreshed = await mod.refreshConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'old-refresh',
        now: 2000,
      });

      expect(refreshed.accessToken).toBe('new-access');
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(String(init?.body)).toContain('"client_id":"client-123"');
      expect(String(init?.body)).toContain('"refresh_token":"old-refresh"');
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = previousClientId;
    }
  });

  it('rejects a Claude refresh when the provider profile endpoint rejects the new access token', async () => {
    const mod = await import('./serviceRefreshers');
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === 'https://example.test/anthropic/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'provider-rejected-access',
            refresh_token: 'rotated-refresh',
            expires_in: 28_800,
          }),
        };
      }
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      await expect(mod.refreshConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'previous-refresh',
        now: 2_000,
      })).rejects.toMatchObject({
        name: 'ConnectedServiceOauthRefreshError',
        category: 'provider_401',
        status: 401,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      vi.unstubAllGlobals();
    }
  });

  it('does not reject a Claude refresh only because optional profile evidence is temporarily unavailable', async () => {
    const mod = await import('./serviceRefreshers');
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === 'https://example.test/anthropic/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'accepted-access',
            refresh_token: 'rotated-refresh',
            expires_in: 28_800,
          }),
        };
      }
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      await expect(mod.refreshConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'previous-refresh',
        now: 2_000,
      })).resolves.toMatchObject({
        accessToken: 'accepted-access',
        refreshToken: 'rotated-refresh',
        raw: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      vi.unstubAllGlobals();
    }
  });

  it('extracts openai-codex account identity from the refresh id_token via the descriptor hook', async () => {
    const mod = await import('./serviceRefreshers');
    const claims = { chatgpt_account_id: 'chatgpt-acct-1', email: 'codex@example.test' };
    const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
        id_token: idToken,
        expires_in: 100,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const refreshed = await mod.refreshConnectedAccountOauthTokens({
        serviceId: 'openai-codex',
        refreshToken: 'old',
        now: 1000,
      });
      expect(refreshed.providerAccountId).toBe('chatgpt-acct-1');
      expect(refreshed.providerEmail).toBe('codex@example.test');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not populate provider identity for a service without an identity hook', async () => {
    const mod = await import('./serviceRefreshers');
    const claims = { chatgpt_account_id: 'should-not-be-read', email: 'nope@example.test' };
    const idToken = `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'gemini-access',
        refresh_token: 'gemini-refresh',
        id_token: idToken,
        expires_in: 100,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const refreshed = await mod.refreshConnectedAccountOauthTokens({
        serviceId: 'gemini',
        refreshToken: 'old',
        now: 1000,
      });
      expect(refreshed.providerAccountId).toBeUndefined();
      expect(refreshed.providerEmail).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
