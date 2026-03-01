import { describe, expect, it, vi } from 'vitest';

import { refreshClaudeSubscriptionOauthTokens, refreshGeminiOauthTokens, refreshOpenAiCodexOauthTokens } from './serviceRefreshers';

describe('serviceRefreshers', () => {
  it('refreshes OpenAI Codex tokens via refresh_token grant', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 1000;
    const refreshed = await refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('new-refresh');
    expect(refreshed.idToken).toBe('new-id');
    expect(refreshed.expiresAt).toBe(now + 3600 * 1000);
  });

  it('throws when OpenAI Codex refresh response is missing access_token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now: 1000,
    })).rejects.toThrow(/access_token/i);
  });

  it('refreshes Claude subscription tokens via refresh_token grant', async () => {
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    const previousClientId = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = 'client-123';

    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 123,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 2000;
    try {
      const refreshed = await refreshClaudeSubscriptionOauthTokens({
        refreshToken: 'old-refresh',
        now,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/anthropic/token');

      const init: unknown = fetchMock.mock.calls[0]?.[1];
      const bodyRaw =
        init && typeof init === 'object' && 'body' in init ? (init as { body?: unknown }).body : undefined;
      const bodyText = typeof bodyRaw === 'string' ? bodyRaw : '';
      expect(bodyText).toContain('"grant_type":"refresh_token"');
      expect(bodyText).toContain('"refresh_token":"old-refresh"');
      expect(bodyText).toContain('"client_id":"client-123"');

      expect(refreshed.accessToken).toBe('new-access');
      expect(refreshed.refreshToken).toBe('new-refresh');
      expect(refreshed.expiresAt).toBe(now + 123 * 1000);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = previousClientId;
    }
  });

  it('throws when Claude subscription refresh response is missing access_token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        refresh_token: 'new-refresh',
        expires_in: 123,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshClaudeSubscriptionOauthTokens({
      refreshToken: 'old-refresh',
      now: 2000,
    })).rejects.toThrow(/access_token/i);
  });

  it('refreshes Gemini tokens via refresh_token grant', async () => {
    const previousClientSecret = process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET;
    process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET = 'secret-123';

    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 60,
        scope: 'scope',
        token_type: 'Bearer',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 3000;
    try {
      const refreshed = await refreshGeminiOauthTokens({
        refreshToken: 'old-refresh',
        now,
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
      expect(bodyText).toContain('client_secret=secret-123');
      expect(refreshed.accessToken).toBe('new-access');
      expect(refreshed.refreshToken).toBe('new-refresh');
      expect(refreshed.expiresAt).toBe(now + 60 * 1000);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET = previousClientSecret;
    }
  });

  it('throws when Gemini refresh response is missing access_token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        refresh_token: 'new-refresh',
        expires_in: 60,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshGeminiOauthTokens({
      refreshToken: 'old-refresh',
      now: 3000,
    })).rejects.toThrow(/access_token/i);
  });
});
