import { describe, expect, it, vi } from 'vitest';

import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  createOpenAiCodexQuotaFetcher,
  openAiCodexQuotaFetcherDescriptor,
  parseOpenAiCodexConnectedAccountQuotaLimits,
} from './openaiFetcher.js';

function jsonResponse(value: unknown): Awaited<ReturnType<HttpService['request']>> {
  return {
    status: 200,
    finalUrl: 'https://chatgpt.com/backend-api/wham/usage',
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function systemJsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenAiCodexQuotaFetcher', () => {
  it('uses the published numeric-epoch threshold for a numeric quota reset', () => {
    expect(parseOpenAiCodexConnectedAccountQuotaLimits({
      rate_limit: { primary_window: { reset_at: 1_000_000_000_000 } },
    })).toEqual([
      { id: 'session', resetsAtMs: 1_000_000_000_000 },
      { id: 'weekly' },
    ]);
  });

  it('returns a provider-neutral public usage observation from the private quota fetcher', async () => {
    const now = 1_000_000;
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
      runtimeFetch: {
        request: async () => jsonResponse({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: 1_700_000_000 },
          },
        }),
      },
    });

    const snapshot = await fetcher.loadQuota({
      record,
      now,
      signal: new AbortController().signal,
    });

    expect(snapshot).toMatchObject({
      v: 1,
      providerId: 'openai-codex',
      recordKey: {
        providerId: 'openai-codex',
        accountSubjectId: 'acct',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      accountSubject: { kind: 'providerSubject', id: 'acct' },
      observedAtMs: now,
      fetchedAtMs: now,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: 'pro',
      accountLabel: 'user@example.com',
      meters: expect.arrayContaining([
        expect.objectContaining({ meterId: 'session', utilizationPct: 12 }),
      ]),
    });
    expect(snapshot).not.toHaveProperty('recordId');
    expect(snapshot).not.toHaveProperty('serviceId');
    expect(snapshot).not.toHaveProperty('profileId');
  });

  it('uses the Codex-owned private ChatGPT usage endpoint by default', async () => {
    const now = 1_000_000;
    const fetchMock = vi.fn(async () => systemJsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1700000000 },
        },
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
    const snapshot = await fetcher.loadQuota({ record, now, signal: new AbortController().signal });

    expect(snapshot?.planLabel).toBe('pro');
    expect(snapshot?.accountSubject).toEqual({ kind: 'providerSubject', id: 'acct' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/wham/usage');
  });

  it('loads reset-credit inventory with the same OAuth account headers for the default Codex usage endpoint', async () => {
    const now = 1_000_000;
    const requests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> }>> = [];
    const request = vi.fn(async (request: Parameters<HttpService['request']>[0]) => {
      const { url, headers } = request;
      requests.push({ url, headers: headers as Readonly<Record<string, string>> });
      if (url.endsWith('/rate-limit-reset-credits')) {
        return jsonResponse({
            available_count: 1,
            credits: [{
              id: 'credit-1',
              reset_type: 'codex_rate_limits',
              status: 'available',
              expires_at: '2026-05-24T10:00:00.000Z',
              profile_image_url: 'https://example.com/private-avatar.png',
              profile_user_id: 'user-secret',
            }],
        });
      }
      return jsonResponse({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 100, reset_at: 1700000000 },
          },
          rate_limit_reset_credits: { available_count: 1 },
      });
    });
    const runtimeFetch: Pick<HttpService, 'request'> = { request };

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
    const requests: Array<Parameters<HttpService['request']>[0]> = [];
    const request = vi.fn(async (input: Parameters<HttpService['request']>[0]) => {
      requests.push(input);
      return jsonResponse({ code: 'reset', windows_reset: 2 });
    });
    const runtimeFetch: Pick<HttpService, 'request'> = { request };

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
      body: expect.any(Uint8Array),
    });
    expect(JSON.parse(new TextDecoder().decode(requests[0]?.body))).toEqual({
      redeem_request_id: 'consume:work:credit-1',
      credit_id: 'credit-1',
    });
  });

  it('fetches and parses approved OpenAI Codex usage proxy data into a quota snapshot', async () => {
    const now = 1_000_000;
    const fetchInputs: Array<string | URL | Request> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      fetchInputs.push(input);
      return systemJsonResponse({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: 1700000000 },
            secondary_window: { used_percent: 25, reset_at: 1700003600 },
          },
      });
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
    expect(snapshot).toMatchObject({
      providerId: 'openai-codex',
      recordKey: { providerId: 'openai-codex', accountSubjectId: 'acct' },
      planLabel: 'pro',
      meters: [
        expect.objectContaining({ meterId: 'session' }),
        expect.objectContaining({ meterId: 'weekly' }),
      ],
    });
    expect(snapshot).not.toHaveProperty('recordId');

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
      return systemJsonResponse({
        rate_limit: {
          primary_window: { used_percent: 5, reset_at: 1700000000 },
          secondary_window: { used_percent: 10, reset_at: 1700003600 },
        },
      });
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
    const fetchMock = vi.fn(async () => systemJsonResponse({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 22, reset_at: 1700000000 },
          secondary_window: { used_percent: 44, reset_at: 1700003600 },
        },
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
    const request = vi.fn();
    const runtimeFetch: Pick<HttpService, 'request'> = { request };

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

    expect(request).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      providerId: 'openai-codex',
      recordKey: { providerId: 'openai-codex', accountSubjectId: 'acct' },
    });
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
    const fetchMock = vi.fn(async () => systemJsonResponse({
        rate_limit: {
          primary_window: { used_percent: 5, reset_at: 1700000000 },
        },
    }));
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
    const fetchMock = vi.fn(async () => new Response('raw-provider-body access_token=secret', {
      status: 429,
      statusText: 'Too Many Requests',
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
        providerEmail: null,
      },
    });

    const fetcher = createOpenAiCodexQuotaFetcher();

    await expect(fetcher.loadQuota({
      record,
      now,
      signal: new AbortController().signal,
    })).rejects.toThrow(/^OpenAI usage fetch failed \(429\): HTTP error$/);
    await expect(fetcher.loadQuota({
      record,
      now,
      signal: new AbortController().signal,
    })).rejects.not.toThrow(/raw-provider-body|access_token=secret/);
  });
});
