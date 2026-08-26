import { describe, expect, it, vi } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

import {
  CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS,
  isRevisionedLegacyOauthRefreshService,
  refreshReleasedPeerLegacyConnectedAccountOauthTokens,
} from './serviceRefreshers';

const encoder = new TextEncoder();
type LegacyFetchResponseFixture = Readonly<{
  ok?: boolean;
  status?: number;
  headers?: Readonly<Record<string, string>>;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}>;

function canonicalRuntimeFetch(
  runtimeFetch: (
    request: Parameters<HttpService['request']>[0],
    options?: Parameters<HttpService['request']>[1],
  ) => Promise<LegacyFetchResponseFixture>,
): HttpService['request'] {
  return async (request, options) => {
    const response = await runtimeFetch(request, options);
    const text = response.ok !== false && typeof response.json === 'function'
      ? JSON.stringify(await response.json())
      : typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(typeof response.json === 'function' ? await response.json() : null);
    return {
      status: response.status ?? (response.ok === false ? 500 : 200),
      finalUrl: request.url,
      headers: response.headers ?? {},
      body: encoder.encode(text),
    };
  };
}

function installGlobalFetchMock<TArgs extends readonly unknown[]>(
  fetchMock: (...args: TArgs) => Promise<LegacyFetchResponseFixture>,
): void {
  vi.stubGlobal('fetch', async (...args: TArgs) => {
    const response = await fetchMock(...args);
    const body = typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(typeof response.json === 'function' ? await response.json() : null);
    return new Response(body, {
      status: response.status ?? (response.ok === false ? 500 : 200),
      headers: response.headers,
    });
  });
}

describe('serviceRefreshers', () => {
  it('allows slow-but-valid provider OAuth refresh responses', () => {
    expect(CONNECTED_SERVICE_OAUTH_REFRESH_TIMEOUT_MS).toBe(120_000);
  });

  it('admits only revisioned legacy OAuth refresh services, never PAT services', () => {
    expect(isRevisionedLegacyOauthRefreshService('openai-codex'))
      .toBe(true);
    expect(isRevisionedLegacyOauthRefreshService('claude-subscription'))
      .toBe(true);
    expect(isRevisionedLegacyOauthRefreshService('openai')).toBe(false);
    expect(isRevisionedLegacyOauthRefreshService('github')).toBe(false);
    expect(isRevisionedLegacyOauthRefreshService('bitbucket')).toBe(false);
  });

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
      runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
    };
    const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens(params);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/oauth/token'),
      headers: expect.objectContaining({
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 1000,
      runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
    })).rejects.toThrow(/Connected account refresh failed \(openai-codex, 400\): invalid_grant/);
    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 1000,
      runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
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
    installGlobalFetchMock(fetchMock);

    const now = 1000;
    const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
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
    installGlobalFetchMock(fetchMock);

    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
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

    const fetchMock = vi.fn(async (input: unknown, _init?: unknown) => {
      if (String(input).endsWith('/api/oauth/profile')) {
        return {
          ok: true,
          json: async () => ({
            account: { has_claude_max: true },
            organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 123,
          scope: 'user:inference user:profile user:sessions:claude_code',
          token_type: 'Bearer',
        }),
      };
    });
    installGlobalFetchMock(fetchMock);

    const now = 2000;
    try {
      const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'old-refresh',
        now,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/anthropic/token');

      const init: unknown = fetchMock.mock.calls[0]?.[1];
      const bodyRaw =
        init && typeof init === 'object' && 'body' in init ? (init as { body?: unknown }).body : undefined;
      const bodyText = bodyRaw instanceof Uint8Array
        ? new TextDecoder().decode(bodyRaw)
        : typeof bodyRaw === 'string'
          ? bodyRaw
          : '';
      expect(bodyText).toContain('"grant_type":"refresh_token"');
      expect(bodyText).toContain('"refresh_token":"old-refresh"');
      expect(bodyText).toContain('"client_id":"client-123"');

      expect(refreshed.accessToken).toBe('new-access');
      expect(refreshed.refreshToken).toBe('new-refresh');
      expect(refreshed.expiresAt).toBe(now + 123 * 1000);
      expect(refreshed.scope).toBe('user:inference user:profile user:sessions:claude_code');
      expect(refreshed.tokenType).toBe('Bearer');
      expect(refreshed.raw).toEqual({
        claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      });
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID = previousClientId;
    }
  });

  it('rejects a Claude refresh when the profile endpoint rejects the new access token', async () => {
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';

    const runtimeFetch = vi.fn(async (input: Readonly<{ url: string }>) => {
      if (input.url === 'https://example.test/anthropic/token') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {},
          text: async () => '',
          json: async () => ({
            access_token: 'provider-rejected-access',
            refresh_token: 'rotated-refresh',
            expires_in: 28_800,
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        text: async () => JSON.stringify({ error: 'invalid_token' }),
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

    try {
      await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'previous-refresh',
        now: 2_000,
        runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
      })).rejects.toThrow(
        /refreshed access-token verification failed \(claude-subscription, 401\): invalid_token/,
      );
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
    }
  });

  it('does not reject a Claude refresh only because optional profile evidence is temporarily unavailable', async () => {
    const previousTokenUrl = process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL;
    process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = 'https://example.test/anthropic/token';

    const runtimeFetch = vi.fn(async (input: Readonly<{ url: string }>) => {
      if (input.url === 'https://example.test/anthropic/token') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {},
          text: async () => '',
          json: async () => ({
            access_token: 'accepted-access',
            refresh_token: 'rotated-refresh',
            expires_in: 28_800,
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: {},
        text: async () => '',
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

    try {
      await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'previous-refresh',
        now: 2_000,
        runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
      })).resolves.toMatchObject({
        accessToken: 'accepted-access',
        refreshToken: 'rotated-refresh',
      });
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
    } finally {
      process.env.HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL = previousTokenUrl;
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
    installGlobalFetchMock(fetchMock);

    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'claude-subscription',
      refreshToken: 'old-refresh',
      now: 2000,
    })).rejects.toThrow(/access_token/i);
  });

  it('fails closed for Gemini OAuth refresh because Gemini is API-key/Vertex-only in this closure', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Gemini OAuth refresh must not call the network');
    });
    installGlobalFetchMock(fetchMock);

    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'gemini',
      refreshToken: 'old-refresh',
      now: 3000,
    })).rejects.toThrow(/does not support OAuth refresh/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['github', 'bitbucket'] as const)(
    'refuses %s before transport because immutable old peers do not all accept that legacy identity',
    async (serviceId) => {
      const fetchMock = vi.fn();
      installGlobalFetchMock(fetchMock);

      await expect(
        refreshReleasedPeerLegacyConnectedAccountOauthTokens({
          serviceId,
          refreshToken: 'must-not-leave-process',
          now: 3000,
        }),
      ).rejects.toThrow(/does not support OAuth refresh/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('refreshes the explicit Claude old-peer OAuth mode by service id', async () => {
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
      const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
        serviceId: 'claude-subscription',
        refreshToken: 'old-refresh',
        now: 4000,
        runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
      });

      expect(runtimeFetch).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.test/claude/token',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(Uint8Array),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

  it('parses the explicit old-peer Codex OAuth refresh response', async () => {
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

    const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 5000,
      runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
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

    const refreshed = await refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'openai-codex',
      refreshToken: 'old-refresh',
      now: 7000,
      runtimeFetch: { request: canonicalRuntimeFetch(runtimeFetch) },
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

  it('does not parse Gemini OAuth refresh payloads because Gemini OAuth is not a released fallback mode', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        refresh_token: 'new-refresh',
        expires_in: 60,
      }),
    }));
    installGlobalFetchMock(fetchMock);

    await expect(refreshReleasedPeerLegacyConnectedAccountOauthTokens({
      serviceId: 'gemini',
      refreshToken: 'old-refresh',
      now: 3000,
    })).rejects.toThrow(/does not support OAuth refresh/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
