import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import * as claudeSubscriptionQuotaFetcherModule from './quotaFetcher';
import { createClaudeSubscriptionQuotaFetcher } from './quotaFetcher';

type QuotaDescriptorModule = Readonly<{
  claudeSubscriptionQuotaFetcherDescriptor?: Readonly<{
    loadQuota: (params: Readonly<{
      env: NodeJS.ProcessEnv;
      staleAfterMs: number;
    }>) => ReturnType<typeof createClaudeSubscriptionQuotaFetcher>;
  }>;
}>;

describe('createClaudeSubscriptionQuotaFetcher', () => {
  const claudeCodeScope = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';

  it('does not claim exact quota support for setup-token credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000_000,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: {
        token: 'sk-ant-oat01-setup-placeholder',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    await expect(fetcher.fetch({ record, now: 1_000_000, signal: new AbortController().signal }))
      .resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes a provider-owned descriptor that parses Anthropic endpoint host env before loading the fetcher', async () => {
    const descriptor = (claudeSubscriptionQuotaFetcherModule as QuotaDescriptorModule)
      .claudeSubscriptionQuotaFetcherDescriptor;
    expect(descriptor).toBeTruthy();

    const now = 1_000_000;
    const usageUrl = 'https://quota.happier.dev/anthropic/oauth/usage';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = descriptor!.loadQuota({
      env: {
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: usageUrl,
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USER_AGENT: 'claude-code/descriptor',
        HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT: 'codex-only-agent/1.0',
      },
      staleAfterMs: 321_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot).toMatchObject({
      serviceId: 'claude-subscription',
      staleAfterMs: 321_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(usageUrl, expect.objectContaining({
      headers: expect.objectContaining({
        'User-Agent': 'claude-code/descriptor',
        'anthropic-beta': 'oauth-2025-04-20',
      }),
    }));
  });

  it('polls the Anthropic OAuth usage endpoint by default as best-effort quota telemetry', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });
    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .resolves
      .toMatchObject({ serviceId: 'claude-subscription', profileId: 'work' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer at',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': expect.stringMatching(/^claude-code\/[0-9][a-zA-Z0-9._+-]*$/u),
      }),
    }));
  });

  it('allows an explicitly configured Anthropic OAuth usage endpoint', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 20, resets_at: '2026-02-16T00:00:00Z' },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://api.anthropic.com/api/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour')?.utilizationPct).toBe(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
          },
        },
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });
    expect(fetcher.serviceId).toBe('claude-subscription');
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.planLabel).toBe('max');
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

  it('preserves new Anthropic usage windows instead of dropping unknown meter keys', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
        seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
        seven_day_fable: { utilization: 50, resets_at: '2026-02-24T00:00:00Z' },
        ignored_metadata: { name: 'not a quota window' },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    const fable = snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable');
    expect(fable).toMatchObject({
      label: 'Weekly (Fable)',
      utilizationPct: 50,
      resetsAt: Date.parse('2026-02-24T00:00:00Z'),
      status: 'ok',
    });
    expect(snapshot?.meters.some((meter) => meter.meterId === 'ignored_metadata')).toBe(false);
  });

  it('preserves model-specific Anthropic usage windows from nested usage collections', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
        seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
        usage_windows: [
          {
            window: 'seven_day',
            model: 'fable',
            utilization_pct: 61,
            reset_at: '2026-02-24T00:00:00Z',
          },
        ],
        rate_limits: {
          sonnetFiveHour: {
            rate_limit_type: 'sonnet',
            window: 'five_hour',
            remaining_pct: 7,
            reset_at_ms: Date.parse('2026-02-16T01:00:00Z'),
          },
        },
        ignored_metadata: {
          usage_windows: 'not-a-collection',
        },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
      label: 'Weekly (Fable)',
      utilizationPct: 61,
      resetsAt: Date.parse('2026-02-24T00:00:00Z'),
      status: 'ok',
    });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour_sonnet')).toMatchObject({
      label: '5-hour (Sonnet)',
      utilizationPct: 93,
      resetsAt: Date.parse('2026-02-16T01:00:00Z'),
      status: 'ok',
    });
    expect(snapshot?.meters.some((meter) => meter.meterId === 'sonnetFiveHour')).toBe(false);
  });

  it('preserves scoped model limits from the current Claude usage endpoint contract', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: {
          utilization: 63,
          resets_at: '2026-07-02T13:59:59.747852+00:00',
        },
        seven_day: {
          utilization: 12,
          resets_at: '2026-07-07T19:59:59.747880+00:00',
        },
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 63,
            resets_at: '2026-07-02T13:59:59.747852+00:00',
            scope: null,
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 12,
            resets_at: '2026-07-07T19:59:59.747880+00:00',
            scope: null,
          },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 22,
            resets_at: '2026-07-07T19:59:59.748308+00:00',
            scope: {
              model: {
                id: null,
                display_name: 'Fable',
              },
              surface: null,
            },
          },
        ],
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
      label: 'Weekly (Fable)',
      utilizationPct: 22,
      resetsAt: Date.parse('2026-07-07T19:59:59.748308+00:00'),
      status: 'ok',
    });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour')).toMatchObject({
      utilizationPct: 63,
    });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day')).toMatchObject({
      utilizationPct: 12,
    });
    expect(snapshot?.meters.some((meter) => meter.meterId === 'weekly_scoped')).toBe(false);
  });

  it('canonicalizes common Anthropic usage-window aliases before labeling model limits', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        weekly_opus: {
          utilization: 52,
          resets_at: '2026-02-25T00:00:00Z',
        },
        usage_windows: [
          {
            window: 'weekly',
            model: 'fable',
            utilization: 44,
            resets_at: '2026-02-24T00:00:00Z',
          },
          {
            window: '5h',
            model_family: 'sonnet',
            remaining_pct: 12,
            reset_at_ms: Date.parse('2026-02-16T01:00:00Z'),
          },
        ],
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
      label: 'Weekly (Fable)',
      utilizationPct: 44,
      status: 'ok',
    });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour_sonnet')).toMatchObject({
      label: '5-hour (Sonnet)',
      utilizationPct: 88,
      status: 'ok',
    });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_opus')).toMatchObject({
      label: 'Weekly (Opus)',
      utilizationPct: 52,
      status: 'ok',
    });
  });

  it('derives the plan label from legacy Claude OAuth raw metadata', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });
    if (record.kind !== 'oauth') throw new Error('fixture');
    const legacyRawRecord = {
      ...record,
      oauth: {
        ...record.oauth,
        raw: {
          'claude.ai_oauth': {
            subscriptionType: 'team',
            rateLimitTier: 'team_5x',
          },
        },
      },
    };

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({
      record: legacyRawRecord,
      now,
      signal: new AbortController().signal,
    });

    expect(snapshot?.planLabel).toBe('team');
  });

  it('does not refresh oauth credentials when usage polling is unauthorized', async () => {
    const now = 2_000_000;
    const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input ?? '');
      if (url.includes('/anthropic/oauth/usage')) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => 'unauthorized',
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });
    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .rejects
      .toThrow(/anthropic usage fetch failed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).toContain('/anthropic/oauth/usage');
  });

  it('backs off after 429 Retry-After and leaves existing snapshots stale until polling is allowed again', async () => {
    const now = 5_000_000;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (!url.includes('/anthropic/oauth/usage')) {
        throw new Error(`Unexpected URL in test: ${url}`);
      }
      return {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '120' : null) },
        text: async () => 'rate limited',
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    let clock = now;
    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
      nowMs: () => clock,
    });

    await expect(fetcher.fetch({ record, now: clock, signal: new AbortController().signal })).resolves.toBeNull();
    clock += 60_000;
    await expect(fetcher.fetch({ record, now: clock, signal: new AbortController().signal })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a Retry-After cooldown after a profile reconnects with different credentials', async () => {
    const now = 5_250_000;
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
      const url = String(input ?? '');
      if (!url.includes('/anthropic/oauth/usage')) {
        throw new Error(`Unexpected URL in test: ${url}`);
      }
      usageCalls += 1;
      const auth = (() => {
        const headers: unknown =
          init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
        if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
          return String(headers.get('Authorization'));
        }
        return String((headers as Record<string, unknown> | undefined)?.Authorization ?? '');
      })();
      if (auth === 'Bearer stale-access-token') {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '120' : null) },
          text: async () => 'rate limited',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 11, resets_at: '2026-02-16T00:00:00Z' },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const staleRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        idToken: null,
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });
    const reconnectedRecord = buildConnectedServiceCredentialRecord({
      now: now + 60_000,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 120_000,
      oauth: {
        accessToken: 'fresh-access-token',
        refreshToken: 'fresh-refresh-token',
        idToken: null,
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    let clock = now;
    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
      nowMs: () => clock,
    });

    await expect(fetcher.fetch({ record: staleRecord, now: clock, signal: new AbortController().signal })).resolves.toBeNull();
    clock += 60_000;
    await expect(fetcher.fetch({ record: reconnectedRecord, now: clock, signal: new AbortController().signal }))
      .resolves
      .toMatchObject({ profileId: 'work' });
    expect(usageCalls).toBe(2);
  });

  it('records cooldown before fetching so repeated provider failures do not immediately refetch', async () => {
    const now = 5_500_000;
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    let clock = now;
    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
      nowMs: () => clock,
    });

    await expect(fetcher.fetch({ record, now: clock, signal: new AbortController().signal }))
      .rejects
      .toThrow(/network unavailable/);
    clock += 60_000;
    await expect(fetcher.fetch({ record, now: clock, signal: new AbortController().signal })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a reconnect-required error when the token lacks usage scopes', async () => {
    const now = 3_000_000;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (url.includes('/anthropic/oauth/usage')) {
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });
    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .rejects
      .toThrow(/reconnect claude/i);
  });

  it('retries once when usage endpoint returns a transient server error', async () => {
    const now = 4_000_000;
    let usageCalls = 0;
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (!url.includes('/anthropic/oauth/usage')) {
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
        scope: claudeCodeScope,
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.length).toBeGreaterThan(0);
    expect(usageCalls).toBe(2);
  });

  it('requires Claude Code OAuth scope before reporting quota as usable', async () => {
    const now = 6_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 8, resets_at: '2026-02-16T00:00:00Z' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'legacy',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: null,
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createClaudeSubscriptionQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
      staleAfterMs: 300_000,
    });
    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .rejects
      .toMatchObject({
        quotaFetchErrorCode: 'auth_failure',
        status: 403,
        providerCode: 'missing_claude_code_scope',
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
