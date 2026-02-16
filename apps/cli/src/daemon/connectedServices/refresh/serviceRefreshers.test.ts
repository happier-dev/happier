import { describe, expect, it, vi } from 'vitest';

import { refreshAnthropicOauthTokens, refreshGeminiOauthTokens, refreshOpenAiCodexOauthTokens } from './serviceRefreshers';

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

  it('refreshes Anthropic tokens via refresh_token grant', async () => {
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
    const refreshed = await refreshAnthropicOauthTokens({
      refreshToken: 'old-refresh',
      now,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('new-refresh');
    expect(refreshed.expiresAt).toBe(now + 123 * 1000);
  });

  it('refreshes Gemini tokens via refresh_token grant', async () => {
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
    expect(bodyText).not.toContain('client_secret=');
    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('new-refresh');
    expect(refreshed.expiresAt).toBe(now + 60 * 1000);
  });
});
