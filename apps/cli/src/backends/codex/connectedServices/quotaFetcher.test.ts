import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import * as openAiCodexQuotaFetcherModule from './quotaFetcher';
import { createOpenAiCodexQuotaFetcher } from './quotaFetcher';

type QuotaDescriptorModule = Readonly<{
  openAiCodexQuotaFetcherDescriptor?: Readonly<{
    loadQuota: (params: Readonly<{
      env: NodeJS.ProcessEnv;
      staleAfterMs: number;
    }>) => ReturnType<typeof createOpenAiCodexQuotaFetcher>;
  }>;
}>;

describe('createOpenAiCodexQuotaFetcher', () => {
  it('exposes a provider-owned descriptor that parses endpoint host env before loading the fetcher', async () => {
    const descriptor = (openAiCodexQuotaFetcherModule as QuotaDescriptorModule).openAiCodexQuotaFetcherDescriptor;
    expect(descriptor).toBeTruthy();

    const now = 1_000_000;
    const usageUrl = 'https://quota.happier.dev/openai-codex/usage';
    const resetCreditsUrl = 'https://quota.happier.dev/openai-codex/reset-credits';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input ?? '');
      if (url === usageUrl) {
        return {
          ok: true,
          json: async () => ({
            rate_limit: {
              primary_window: { used_percent: 10, reset_at: 1700000000 },
            },
          }),
        };
      }
      if (url === resetCreditsUrl) {
        return {
          ok: true,
          json: async () => ({ available_count: 0, credits: [] }),
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = descriptor!.loadQuota({
      env: {
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: usageUrl,
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_RESET_CREDITS_URL: resetCreditsUrl,
        HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT: 'codex-descriptor-agent/1.0',
      },
      staleAfterMs: 123_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot).toMatchObject({
      serviceId: 'openai-codex',
      staleAfterMs: 123_000,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, usageUrl, expect.objectContaining({
      headers: expect.objectContaining({
        'User-Agent': 'codex-descriptor-agent/1.0',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, resetCreditsUrl, expect.anything());
  });

  it('polls the ChatGPT wham usage endpoint by default with connected account headers', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: 1700000000 },
          secondary_window: { used_percent: 25, reset_at: 1700003600 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.serviceId).toBe('openai-codex');
    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer at',
        'ChatGPT-Account-Id': 'acct',
      }),
    }));
  });

  it('fetches and parses approved OpenAI Codex usage proxy data into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: 1700000000 },
          secondary_window: { used_percent: 25, reset_at: 1700003600 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher({
      usageUrl: 'https://quota.happier.dev/openai-codex/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.planLabel).toBe('pro');
      expect(parsed.data.meters.map((m) => m.meterId)).toEqual(['session', 'weekly']);
    }

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const headers: unknown =
      init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
    if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
      expect(String(headers.get('Authorization'))).toBe('Bearer at');
      expect(String(headers.get('ChatGPT-Account-Id'))).toBe('acct');
    } else {
      const headerRecord = headers && typeof headers === 'object' && !Array.isArray(headers) ? (headers as Record<string, unknown>) : {};
      expect(headerRecord.Authorization).toBe('Bearer at');
      expect(headerRecord['ChatGPT-Account-Id']).toBe('acct');
    }
  });

  it('preserves additional provider allowance ids from the HTTP usage response', async () => {
    const now = 1_000_000;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: { primary_window: { used_percent: 10 } },
        additional_rate_limits: [{
          limit_name: 'GPT-5.3-Codex-Spark',
          metered_feature: 'codex_bengalfox',
          rate_limit: {
            primary_window: { used_percent: 80 },
            secondary_window: { used_percent: 35 },
          },
        }],
      }),
    })) as unknown as typeof fetch);
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null },
    });
    const snapshot = await createOpenAiCodexQuotaFetcher({ usageUrl: 'https://quota.test/usage', resetCreditsUrl: null })
      .fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters).toEqual(expect.arrayContaining([
      expect.objectContaining({ meterId: 'session', providerLimitId: 'session', utilizationPct: 10 }),
      expect.objectContaining({ meterId: 'codex_bengalfox:primary', providerLimitId: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark · Primary', utilizationPct: 80 }),
      expect.objectContaining({ meterId: 'codex_bengalfox:secondary', providerLimitId: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark · Secondary', utilizationPct: 35 }),
    ]));
  });

  it('fetches Codex reset-credit collection details with connected account headers', async () => {
    const now = 1_768_000_000_000;
    const usageUrl = 'https://quota.happier.dev/openai-codex/usage';
    const resetCreditsUrl = 'https://quota.happier.dev/openai-codex/rate-limit-reset-credits';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === usageUrl) {
        return {
          ok: true,
          json: async () => ({
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 100, reset_at: '2026-06-17T12:00:00.000Z' },
            },
            rate_limit_reset_credits: { available_count: 1 },
          }),
        };
      }
      if (url === resetCreditsUrl) {
        return {
          ok: true,
          json: async () => ({
            available_count: 1,
            credits: [
              {
                id: 'credit-1',
                reset_type: 'codex_rate_limits',
                status: 'available',
                granted_at: '2026-06-12T01:51:02.745763Z',
                expires_at: '2026-07-12T01:51:02.745763Z',
                redeem_started_at: null,
                redeemed_at: null,
                title: 'One free rate limit reset',
                description: 'Granted by the provider',
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher({
      usageUrl,
      resetCreditsUrl,
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });

    expect(snapshot?.recoveryCredits).toEqual({
      kind: 'usage_limit_resets',
      availableCount: 1,
      totalCount: 1,
      nextExpiresAtMs: Date.parse('2026-07-12T01:51:02.745Z'),
      source: 'provider_api',
      confidence: 'exact',
      credits: [
        {
          providerCreditId: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
          providerResetType: 'codex_rate_limits',
          title: 'One free rate limit reset',
          description: 'Granted by the provider',
          grantedAtMs: Date.parse('2026-06-12T01:51:02.745Z'),
          expiresAtMs: Date.parse('2026-07-12T01:51:02.745Z'),
          redeemStartedAtMs: null,
          redeemedAtMs: null,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(resetCreditsUrl, expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        Authorization: 'Bearer at',
        'ChatGPT-Account-Id': 'acct',
      }),
    }));
  });

  it('consumes Codex reset credits with connected account headers', async () => {
    const now = 1_768_000_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 'reset', windows_reset: 2 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();
    const result = await fetcher.consumeRecoveryCredit?.({
      record,
      now,
      idempotencyKey: 'reset-req-1',
      providerCreditId: 'credit-1',
      signal: new AbortController().signal,
    });

    expect(result).toBe('consumed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer at',
          'ChatGPT-Account-Id': 'acct',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ redeem_request_id: 'reset-req-1', credit_id: 'credit-1' }),
      }),
    );
  });

  it('consumes an aggregate reset credit when no provider credit id is supplied', async () => {
    const now = 1_768_000_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 'nothing_to_reset', windows_reset: 0 }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();
    await expect(fetcher.consumeRecoveryCredit?.({
      record,
      now,
      idempotencyKey: 'reset-req-1',
      signal: new AbortController().signal,
    })).resolves.toBe('nothing_to_reset');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ redeem_request_id: 'reset-req-1' }),
      }),
    );
  });

  it('allows an explicitly configured ChatGPT wham usage endpoint', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 55, reset_at: 1700000000 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher({
      usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((meter) => meter.meterId === 'session')?.utilizationPct).toBe(55);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
      method: 'GET',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', expect.objectContaining({
      method: 'GET',
    }));
  });

  it('exposes Retry-After backoff from non-ok provider responses', async () => {
    const now = 1_000_000;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        get: (name: string) => name.toLowerCase() === 'retry-after' ? '120' : null,
      },
    })) as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();

    await expect(fetcher.fetch({ record, now, signal: new AbortController().signal }))
      .rejects
      .toMatchObject({
        status: 503,
        retryAfterMs: 120_000,
      });
  });

  it('converts relative resets_in_seconds windows to absolute resets and drops implausible 1970-era epochs (RD-QUO-1)', async () => {
    const now = Date.parse('2026-06-11T10:00:00.000Z');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          // Legacy relative shape: no absolute reset, only seconds-until-reset.
          primary_window: { used_percent: 100, window_minutes: 300, resets_in_seconds: 1_800 },
          // A relative value misparsed as an epoch would land in 1970 — must be dropped.
          secondary_window: { used_percent: 25, reset_at: 86_400 },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();
    const snapshot = await fetcher.fetch({ record, now, signal: new AbortController().signal });
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse(snapshot);
    expect(parsed.meters).toMatchObject([
      { meterId: 'session', resetsAt: now + 1_800_000 },
      { meterId: 'weekly', resetsAt: null },
    ]);
  });
});

describe('OpenAI Codex usage credits', () => {
  it('keeps the wham/usage credit balance as a credit meter beside spent windows', async () => {
    const now = 1_000_000;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: { allowed: true, limit_reached: false, secondary_window: { used_percent: 100, reset_at: 1700000000 } },
        credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '16845' },
        spend_control: { reached: false, individual_limit: null },
      }),
    })) as unknown as typeof fetch);
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null, providerAccountId: 'acct', providerEmail: null },
    });
    const snapshot = await createOpenAiCodexQuotaFetcher({ usageUrl: 'https://quota.happier.dev/usage', resetCreditsUrl: null })
      .fetch({ record, now, signal: new AbortController().signal });
    expect(ConnectedServiceQuotaSnapshotV1Schema.parse(snapshot).meters).toContainEqual(expect.objectContaining({
      meterId: 'credits', unit: 'credits', remaining: 16_845, isExhausted: false,
    }));
    vi.unstubAllGlobals();
  });
});
