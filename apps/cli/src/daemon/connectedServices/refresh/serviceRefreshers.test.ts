import { describe, expect, it, vi } from 'vitest';

import {
  refreshClaudeSubscriptionOauthTokens,
  refreshConnectedAccountOauthTokens,
  refreshGeminiOauthTokens,
  refreshOpenAiCodexOauthTokens,
} from './serviceRefreshers';

function buildJwt(payload: Record<string, unknown>): string {
  return [
    'hdr',
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
    'sig',
  ].join('.');
}

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

  it('passes an abort signal to the provider token refresh fetch', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now: 1000,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('extracts OpenAI Codex account email from refreshed id_token claims', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: buildJwt({
          chatgpt_account_id: 'acct-from-token',
          'https://api.openai.com/profile': {
            email: 'codex-user@example.test',
          },
        }),
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const refreshed = await refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now: 1000,
    });

    expect(refreshed.providerAccountId).toBe('acct-from-token');
    expect(refreshed.providerEmail).toBe('codex-user@example.test');
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

  it('does not include raw refresh failure response bodies in thrown errors', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        refresh_token: 'secret-refresh-token',
        access_token: 'secret-access-token',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now: 1000,
    })).rejects.toThrow(/openai-codex refresh failed \(400\): invalid_grant/);
    await expect(refreshOpenAiCodexOauthTokens({
      refreshToken: 'old-refresh',
      now: 1000,
    })).rejects.not.toThrow(/secret-refresh-token|secret-access-token|old-refresh/);
  });

  it('classifies provider refresh failures without retaining response secrets', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh token secret-refresh-token was rejected',
        refresh_token: 'secret-refresh-token',
        access_token: 'secret-access-token',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    let caught: unknown = null;
    try {
      await refreshConnectedAccountOauthTokens({
        serviceId: 'openai-codex',
        refreshToken: 'old-refresh',
        now: 1000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      category: 'invalid_grant',
      status: 400,
      providerErrorCode: 'invalid_grant',
    });
    expect(String(caught)).not.toMatch(/secret-refresh-token|secret-access-token|old-refresh/);
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
            organization: {
              organization_type: 'claude_max',
              rate_limit_tier: 'default_claude_max_20x',
            },
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
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const now = 2000;
    try {
      const refreshed = await refreshClaudeSubscriptionOauthTokens({
        refreshToken: 'old-refresh',
        now,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expect(refreshed.raw).toEqual({
        claudeAiOauth: {
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      });
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
      expect(refreshed.scope).toBe('scope');
      expect(refreshed.tokenType).toBe('Bearer');
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


describe('Antigravity issuer refresh', () => {
  it('uses the validated native issuer and refuses mismatched metadata before sending credentials', async () => {
    const { AGY_OAUTH_CLIENT_ID } = await import('@happier-dev/agents');
    const { refreshConnectedAccountOauthTokens } = await import('./serviceRefreshers');
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ access_token: 'fresh', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_AGY_OAUTH_CLIENT_ID', 'wrong-client');
    try {
      await expect(refreshConnectedAccountOauthTokens({ serviceId: 'antigravity', refreshToken: 'secret', now: 1, credentialRaw: { antigravity: { clientId: 'wrong-client', authMethod: 'oauth-personal' } } })).rejects.toThrow(/issuer/);
      expect(fetcher).not.toHaveBeenCalled();
      await refreshConnectedAccountOauthTokens({ serviceId: 'antigravity', refreshToken: 'secret', now: 1, credentialRaw: { antigravity: { clientId: AGY_OAUTH_CLIENT_ID, authMethod: 'oauth-personal', projectId: 'project' } } });
      const request = fetcher.mock.calls[0][1];
      expect(new URLSearchParams(String(request?.body)).get('client_id')).toBe(AGY_OAUTH_CLIENT_ID);
      expect(new URLSearchParams(String(request?.body)).has('scope')).toBe(false);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});
