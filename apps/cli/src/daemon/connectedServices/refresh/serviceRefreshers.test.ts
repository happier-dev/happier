import { describe, expect, it, vi } from 'vitest';
import { getConnectedAccountDescriptor } from '@happier-dev/protocol';

import { refreshConnectedAccountOauthTokens } from './serviceRefreshers';

describe('serviceRefreshers', () => {
  it('refreshes OpenAI Codex tokens through injected runtime fetch without using global fetch', async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch must not be used by connected-service refreshers');
    });
    vi.stubGlobal('fetch', globalFetch as unknown as typeof fetch);
    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const params = {
      serviceId: 'openai-codex' as const,
      refreshToken: 'old-refresh',
      now: 1000,
      runtimeFetch,
    };
    const refreshed = await refreshConnectedAccountOauthTokens(params);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/oauth/token'),
      headers: expect.objectContaining({
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(refreshed).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      idToken: 'new-id',
    });
  });

  it('does not include raw refresh failure response bodies in thrown errors', async () => {
    const runtimeFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        refresh_token: 'secret-refresh-token',
        access_token: 'secret-access-token',
      }),
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 1000,
      runtimeFetch,
    })).rejects.toThrow(/Connected account refresh failed \(openai-codex, 400\): invalid_grant/);
    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 1000,
      runtimeFetch,
    })).rejects.not.toThrow(/secret-refresh-token|secret-access-token|old-refresh/);
  });

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
    const refreshed = await refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
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

    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
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
        scope: 'user:inference user:profile user:sessions:claude_code',
        token_type: 'Bearer',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 2000;
    try {
      const refreshed = await refreshConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
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
      expect(refreshed.scope).toBe('user:inference user:profile user:sessions:claude_code');
      expect(refreshed.tokenType).toBe('Bearer');
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

    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'claude-subscription',
      refreshToken: 'old-refresh',
      now: 2000,
    })).rejects.toThrow(/access_token/i);
  });

  it('fails closed for Gemini OAuth refresh because Gemini is API-key/Vertex-only in this closure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Gemini OAuth refresh must not call the network');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'gemini',
      refreshToken: 'old-refresh',
      now: 3000,
    })).rejects.toThrow(/does not support OAuth refresh/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes standard OAuth tokens from descriptor metadata by service id', async () => {
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    const previousClientId = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/claude/token';
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = 'claude-client';

    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 90,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    try {
      const refreshed = await refreshConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'old-refresh',
        now: 4000,
        runtimeFetch,
      });

      expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.test/claude/token',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh',
          client_id: 'claude-client',
        }),
      }));
      expect(refreshed).toEqual({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        expiresAt: 94_000,
      });
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = previousClientId;
    }
  });

  it('parses standard OAuth refresh responses from descriptor payload mapping', async () => {
    const descriptor = getConnectedAccountDescriptor('openai-codex');
    if (!descriptor?.oauth) throw new Error('fixture');
    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      json: async () => ({
        access_token: 'mapped-access',
        refresh_token: 'mapped-refresh',
        id_token: 'mapped-id',
        expires_in: 7,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const refreshed = await refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 5000,
      runtimeFetch,
    });

    expect(refreshed).toEqual({
      accessToken: 'mapped-access',
      refreshToken: 'mapped-refresh',
      idToken: 'mapped-id',
      scope: null,
      tokenType: null,
      expiresAt: 12_000,
    });
  });

  it('preserves existing standard OAuth refresh edge-case parsing', async () => {
    const runtimeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      json: async () => ({
        access_token: 'new-access',
        refresh_token: '',
        id_token: '',
        expires_in: 0,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const refreshed = await refreshConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 7000,
      runtimeFetch,
    });

    expect(refreshed).toEqual({
      accessToken: 'new-access',
      refreshToken: 'old-refresh',
      idToken: '',
      scope: null,
      tokenType: null,
      expiresAt: 7000,
    });
  });

  it('does not parse Gemini OAuth refresh payloads because Gemini OAuth is not a supported descriptor mode', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        refresh_token: 'new-refresh',
        expires_in: 60,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshConnectedAccountOauthTokens({
      serviceId: 'gemini',
      refreshToken: 'old-refresh',
      now: 3000,
    })).rejects.toThrow(/does not support OAuth refresh/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
