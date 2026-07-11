import { describe, expect, it, vi } from 'vitest';

import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  createOpenAiCodexQuotaFetcher,
  openAiCodexQuotaFetcherDescriptor,
} from './openaiFetcher.js';

describe('createOpenAiCodexQuotaFetcher', () => {
  it('uses the Codex-owned private ChatGPT usage endpoint by default', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1700000000 },
        },
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
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
    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(snapshot?.planLabel).toBe('pro');
    expect(snapshot?.activeAccountId).toBe('acct');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage');
  });

  it('loads reset-credit inventory with the same OAuth account headers for the default Codex usage endpoint', async () => {
    const now = 1_000_000;
    const requests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> }>> = [];
    const runtimeFetch = vi.fn(async (request: Parameters<FetchRuntimeServiceV1>[0]) => {
      const { url, headers } = request;
      requests.push({ url, headers: headers as Readonly<Record<string, string>> });
      if (url.endsWith('/rate-limit-reset-credits')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {},
          json: async () => ({
            available_count: 1,
            credits: [{
              id: 'credit-1',
              reset_type: 'codex_rate_limits',
              status: 'available',
              expires_at: '2026-05-24T10:00:00.000Z',
              profile_image_url: 'https://example.com/private-avatar.png',
              profile_user_id: 'user-secret',
            }],
          }),
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        json: async () => ({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 100, reset_at: 1700000000 },
          },
          rate_limit_reset_credits: { available_count: 1 },
        }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

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

    const fetcher = createOpenAiCodexQuotaFetcher({ runtimeFetch });
    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(requests.map((request) => request.url)).toEqual([
      'https://chatgpt.com/backend-api/wham/usage',
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    ]);
    expect(requests[1]?.headers).toMatchObject({
      Authorization: 'Bearer at',
      'ChatGPT-Account-Id': 'acct',
    });
    expect(snapshot?.recoveryCredits).toEqual({
      availableCount: 1,
      credits: [expect.objectContaining({
        id: 'credit-1',
        status: 'available',
        expiresAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
      })],
    });
    expect(JSON.stringify(snapshot?.recoveryCredits)).not.toContain('private-avatar');
    expect(JSON.stringify(snapshot?.recoveryCredits)).not.toContain('user-secret');
  });

  it('consumes reset credits with the same OAuth account headers', async () => {
    const now = 1_000_000;
    const requests: Array<Parameters<FetchRuntimeServiceV1>[0]> = [];
    const runtimeFetch = vi.fn(async (request: Parameters<FetchRuntimeServiceV1>[0]) => {
      requests.push(request);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {},
        json: async () => ({ code: 'reset', windows_reset: 2 }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

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

    const fetcher = createOpenAiCodexQuotaFetcher({ runtimeFetch });
    const outcome = await fetcher.consumeRecoveryCredit?.({
      record,
      now,
      idempotencyKey: 'consume:work:credit-1',
      providerCreditId: 'credit-1',
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('consumed');

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer at',
        'ChatGPT-Account-Id': 'acct',
      }),
      body: {
        redeem_request_id: 'consume:work:credit-1',
        credit_id: 'credit-1',
      },
    });
  });

  it('fetches and parses approved OpenAI Codex usage proxy data into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchInputs: Array<string | URL | Request> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      fetchInputs.push(input);
      return {
        ok: true,
        json: async () => ({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: 1700000000 },
            secondary_window: { used_percent: 25, reset_at: 1700003600 },
          },
        }),
      } as Response;
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
      usageUrl: 'https://quota.happier.dev/openai-codex/usage',
      staleAfterMs: 300_000,
    });

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });
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

  it('owns the OpenAI Codex usage URL env mapping in the backend descriptor', async () => {
    const now = 1_000_000;
    const fetchInputs: Array<string | URL | Request> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      fetchInputs.push(input);
      return {
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 5, reset_at: 1700000000 },
          secondary_window: { used_percent: 10, reset_at: 1700003600 },
        },
      }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetcher = openAiCodexQuotaFetcherDescriptor.createFetcher({
      env: {
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: 'https://quota.happier.dev/openai-codex/usage',
      },
      staleAfterMs: 123_000,
      userAgent: 'happier-test',
    });

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
        providerEmail: null,
      },
    });

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });
    expect(snapshot?.staleAfterMs).toBe(123_000);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quota.happier.dev/openai-codex/usage');
  });

  it('allows the Codex-owned private ChatGPT wham usage endpoint when configured', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 22, reset_at: 1700000000 },
          secondary_window: { used_percent: 44, reset_at: 1700003600 },
        },
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
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

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });
    expect(snapshot?.planLabel).toBe('pro');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage');

    const init: unknown = fetchMock.mock.calls[0]?.[1];
    const headers: unknown =
      init && typeof init === 'object' && 'headers' in init ? (init as { headers?: unknown }).headers : undefined;
    const headerRecord = headers && typeof headers === 'object' && !Array.isArray(headers)
      ? (headers as Record<string, unknown>)
      : {};
    expect(headerRecord.Authorization).toBe('Bearer at');
    expect(headerRecord['ChatGPT-Account-Id']).toBe('acct');
  });

  it('returns a quota_unknown snapshot without any network IO when the private endpoint is disabled', async () => {
    const now = 1_000_000;
    const runtimeFetch = vi.fn();

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
      disablePrivateEndpoint: true,
      staleAfterMs: 300_000,
      runtimeFetch,
    });

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(runtimeFetch).not.toHaveBeenCalled();
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    expect(snapshot?.meters.map((meter) => meter.meterId)).toEqual(['session', 'weekly']);
    for (const meter of snapshot?.meters ?? []) {
      expect(meter.status).toBe('unavailable');
      expect(meter.utilizationPct).toBeNull();
      expect(meter.details).toMatchObject({ code: 'quota_unknown' });
    }
  });

  it('reads HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT in the descriptor and skips the private endpoint', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetcher = openAiCodexQuotaFetcherDescriptor.createFetcher({
      env: {
        HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
      },
      staleAfterMs: 123_000,
      userAgent: 'happier-test',
    });

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
        providerEmail: null,
      },
    });

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot?.staleAfterMs).toBe(123_000);
    for (const meter of snapshot?.meters ?? []) {
      expect(meter.status).toBe('unavailable');
      expect(meter.details).toMatchObject({ code: 'quota_unknown' });
    }
  });

  it('lets the explicit usage URL override take precedence over the kill switch', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({
        rate_limit: {
          primary_window: { used_percent: 5, reset_at: 1700000000 },
        },
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetcher = openAiCodexQuotaFetcherDescriptor.createFetcher({
      env: {
        HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: 'https://quota.happier.dev/openai-codex/usage',
      },
      staleAfterMs: 123_000,
      userAgent: 'happier-test',
    });

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
        providerEmail: null,
      },
    });

    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quota.happier.dev/openai-codex/usage');
    expect(snapshot?.meters[0]?.utilizationPct).toBe(5);
  });

  it('does not include raw provider error bodies in thrown quota fetch errors', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers(),
      json: async () => ({}),
      text: async () => 'raw-provider-body access_token=secret',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
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
        providerEmail: null,
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();

    await expect(fetcher.loadQuota({
      record,
      now,
      signal: new AbortController().signal,
    })).rejects.toThrow(/^OpenAI usage fetch failed \(429\): Too Many Requests$/);
    await expect(fetcher.loadQuota({
      record,
      now,
      signal: new AbortController().signal,
    })).rejects.not.toThrow(/raw-provider-body|access_token=secret/);
  });
});
