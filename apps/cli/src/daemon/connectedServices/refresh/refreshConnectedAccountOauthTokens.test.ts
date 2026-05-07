import { describe, expect, it, vi } from 'vitest';

describe('refreshConnectedAccountOauthTokens', () => {
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
});
