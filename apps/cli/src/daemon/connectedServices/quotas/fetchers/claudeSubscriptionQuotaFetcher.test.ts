import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeSubscriptionQuotaFetcher } from './claudeSubscriptionQuotaFetcher';

describe('createClaudeSubscriptionQuotaFetcher', () => {
  it('fetches and parses Claude subscription oauth usage into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
        seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 20, utilization: 20 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    expect(fetcher.serviceId).toBe('claude-subscription');
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('five_hour');
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('seven_day');
      expect(parsed.data.meters.map((m) => m.meterId)).toContain('extra_usage');
    }

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const headers: unknown =
      init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
    if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
      expect(String(headers.get('Authorization'))).toBe('Bearer at');
      expect(String(headers.get('anthropic-beta'))).toBe('oauth-2025-04-20');
    } else {
      const headerRecord = headers && typeof headers === 'object' && !Array.isArray(headers) ? (headers as Record<string, unknown>) : {};
      expect(headerRecord.Authorization).toBe('Bearer at');
      expect(headerRecord['anthropic-beta']).toBe('oauth-2025-04-20');
    }
  });

  it('refreshes oauth token and retries usage when the first usage call is unauthorized', async () => {
    const now = 2_000_000;
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input ?? '');
      if (url.includes('/api/oauth/usage')) {
        usageCalls += 1;
        if (usageCalls === 1) {
          return {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'unauthorized',
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            five_hour: { utilization: 12, resets_at: '2026-02-16T00:00:00Z' },
            seven_day: { utilization: 34, resets_at: '2026-02-23T00:00:00Z' },
          }),
        };
      }

      if (url.includes('/v1/oauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'refreshed-access-token',
            refresh_token: 'refreshed-refresh-token',
            expires_in: 3600,
          }),
        };
      }

      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'expired-access-token',
        refreshToken: 'old-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);

    expect(usageCalls).toBe(2);

    const usageCallsWithExpiredToken = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0] ?? '');
      const initArg = call[1];
      if (!url.includes('/api/oauth/usage')) return false;
      const headers =
        initArg && typeof initArg === 'object' && 'headers' in initArg
          ? (initArg as { headers?: Record<string, unknown> }).headers
          : undefined;
      return headers?.Authorization === 'Bearer expired-access-token';
    });
    expect(usageCallsWithExpiredToken.length).toBe(1);

    const usageCallsWithRefreshedToken = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0] ?? '');
      const initArg = call[1];
      if (!url.includes('/api/oauth/usage')) return false;
      const headers =
        initArg && typeof initArg === 'object' && 'headers' in initArg
          ? (initArg as { headers?: Record<string, unknown> }).headers
          : undefined;
      return headers?.Authorization === 'Bearer refreshed-access-token';
    });
    expect(usageCallsWithRefreshedToken.length).toBe(1);
  });

  it('surfaces a reconnect-required error when the token lacks usage scopes', async () => {
    const now = 3_000_000;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (url.includes('/api/oauth/usage')) {
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => JSON.stringify({
            error: {
              type: 'permission_error',
              message: 'OAuth token does not meet scope requirement user:profile',
            },
          }),
        };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .rejects
      .toThrow(/reconnect claude/i);
  });

  it('retries once when usage endpoint returns a transient server error', async () => {
    const now = 4_000_000;
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (!url.includes('/api/oauth/usage')) {
        throw new Error(`Unexpected URL in test: ${url}`);
      }
      usageCalls += 1;
      if (usageCalls === 1) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'internal error',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 8, resets_at: '2026-02-16T00:00:00Z' },
          seven_day: { utilization: 15, resets_at: '2026-02-23T00:00:00Z' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.length).toBeGreaterThan(0);
    expect(usageCalls).toBe(2);
  });
});
