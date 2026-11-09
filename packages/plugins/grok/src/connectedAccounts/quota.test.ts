import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { fetchXaiQuota, parseXaiBilling } from './quota.js';

type Http = Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0]['services']['http'];
const creditsUrl = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const monthlyUrl = 'https://cli-chat-proxy.grok.com/v1/billing';
const subscription = { mode: 'subscription', accessToken: 'fake-selected-subscription' } as const;
const nowMs = Date.parse('2026-11-09T12:00:00Z');
const weekly = {
  config: {
    currentPeriod: { start: '2026-11-06T00:00:00Z', end: '2026-11-13T00:00:00Z', type: 'USAGE_PERIOD_TYPE_WEEKLY' },
    creditUsagePercent: '18',
    productUsage: [{ product: 'GrokBuild', usagePercent: '16' }, { product: 'Api', usagePercent: 2 }],
  },
};
// Billing amounts are returned as { val }; the source does not declare a currency.
const monthly = {
  config: {
    monthlyLimit: { val: '15000' }, used: { val: '10548' },
    onDemandCap: { val: '100' }, onDemandUsed: { val: '25' },
    billingPeriodStart: '2026-10-01T00:00:00Z', billingPeriodEnd: '2026-11-01T00:00:00Z',
  },
};
function httpResponses(responses: readonly Readonly<{ payload: unknown; status?: number }>[]) {
  let cursor = 0;
  const request = vi.fn<Http['request']>(async (input) => {
    const response = responses[cursor++];
    if (!response) throw new Error('Unexpected billing request');
    return { status: response.status ?? 200, headers: {}, finalUrl: input.url,
      body: new TextEncoder().encode(JSON.stringify(response.payload)) };
  });
  return { request };
}

describe('xAI sourced billing', () => {
  it('keeps weekly credit percentages and product observations without fabricating credit amounts', () => {
    const limits = parseXaiBilling(weekly);
    expect(limits).toHaveLength(3);
    expect(limits[0]).toMatchObject({ id: 'weekly-credits', unit: 'credits', used: null, limit: null,
      utilizationPct: 18, resetsAtMs: Date.parse(weekly.config.currentPeriod.end),
      windowDurationMs: 7 * 24 * 60 * 60 * 1000, scope: 'weekly', confidence: 'exact' });
    expect(limits.slice(1).map((limit) => limit.utilizationPct)).toEqual([16, 2]);
    expect(limits[0]?.details?.note).toContain(creditsUrl);
  });

  it('preserves monthly included amounts and on-demand spend as distinct unknown-denomination meters', () => {
    const limits = parseXaiBilling(monthly);
    expect(limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'monthly-included', unit: 'unknown', used: 10548, limit: 15000,
        remaining: 4452, windowDurationMs: 31 * 24 * 60 * 60 * 1000,
        resetsAtMs: Date.parse('2026-11-01T00:00:00Z'), scope: 'monthly' }),
      expect.objectContaining({ id: 'on-demand', unit: 'unknown', used: 25, limit: 100, remaining: 75 }),
    ]));
  });

  it('fetches only weekly credits for a usable non-unified response using selected auth and cancellation', async () => {
    const http = httpResponses([{ payload: weekly }]);
    const signal = new AbortController().signal;
    const result = await fetchXaiQuota({ http, credential: subscription, nowMs, signal });
    expect(result.observedAtMs).toBe(nowMs);
    expect(result.limits).toHaveLength(3);
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({ url: creditsUrl, redirect: 'error',
      headers: { Authorization: `Bearer ${subscription.accessToken}`, Accept: 'application/json', 'X-XAI-Token-Auth': 'xai-grok-cli' },
    }), { signal });
  });

  it('fetches monthly only when unified is advertised and preserves both weekly and monthly facts', async () => {
    const http = httpResponses([{ payload: { config: { ...weekly.config, isUnifiedBillingUser: true } } }, { payload: monthly }]);
    const result = await fetchXaiQuota({ http, credential: subscription, nowMs });
    expect(http.request.mock.calls.map(([input]) => input.url)).toEqual([creditsUrl, monthlyUrl]);
    expect(result.limits.map((limit) => limit.id)).toEqual(expect.arrayContaining(['weekly-credits', 'monthly-included', 'on-demand']));
  });

  it('does not infer zero from a weekly period without usage, and requests the monthly shape', async () => {
    const http = httpResponses([{ payload: { config: { currentPeriod: weekly.config.currentPeriod } } }, { payload: monthly }]);
    const result = await fetchXaiQuota({ http, credential: subscription, nowMs });
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(result.limits.map((limit) => limit.id)).toEqual(['monthly-included', 'on-demand']);
  });

  it('never requests subscription billing for a paid API credential', async () => {
    const http = httpResponses([]);
    expect(await fetchXaiQuota({ http, credential: { mode: 'api-key', accessToken: 'fake-paid-key' }, nowMs }))
      .toEqual({ observedAtMs: nowMs, limits: [] });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('reports unsupported schemas as unavailable instead of a zero allowance', async () => {
    const http = httpResponses([{ payload: { config: {} } }, { payload: { config: {} } }]);
    await expect(fetchXaiQuota({ http, credential: subscription, nowMs })).rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
  });

  it.each([[403, 'network'], [429, 'provider_backoff'], [401, 'auth_failure']] as const)
    ('keeps HTTP %s provenance without interpreting a policy refusal as invalid credentials', async (status, quotaFetchErrorCode) => {
      const http = httpResponses([{ payload: { message: 'fake-selected-subscription BLOCKED_REASON_NO_LOGS' }, status }]);
      const error = await fetchXaiQuota({ http, credential: subscription, nowMs }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status, quotaFetchErrorCode });
      expect(String(error)).not.toContain(subscription.accessToken);
    });

  it.each([
    { error: 'BLOCKED_REASON_NO_LOGS', expectedReason: 'BLOCKED_REASON_NO_LOGS' },
    { error: 'UNCHARACTERIZED_REASON', expectedReason: null },
  ])('preserves only the characterized policy reason from a 403 response: $error', async ({ error, expectedReason }) => {
    const http = httpResponses([{ status: 403, payload: { error, message: subscription.accessToken } }]);
    const failure = await fetchXaiQuota({ http, credential: subscription, nowMs }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ status: 403, quotaFetchErrorCode: 'network', providerCode: expectedReason });
    if (expectedReason) expect(String(failure)).toContain(expectedReason);
    else expect(String(failure)).not.toContain(error);
    expect(String(failure)).not.toContain(subscription.accessToken);
    expect(JSON.stringify(failure)).not.toContain(subscription.accessToken);
  });

  it('retains available weekly facts when optional monthly billing is unavailable', async () => {
    const http = httpResponses([{ payload: { config: { ...weekly.config, isUnifiedBillingUser: true } } }, { payload: {}, status: 503 }]);
    const result = await fetchXaiQuota({ http, credential: subscription, nowMs });
    expect(result.limits[0]).toMatchObject({ id: 'weekly-credits', utilizationPct: 18 });
    expect(result.limits).toContainEqual(expect.objectContaining({ id: 'monthly-included', status: 'unavailable',
      used: null, limit: null, details: expect.objectContaining({ code: 'provider_backoff' }) }));
  });

  it('preserves conflicting on-demand counters from their distinct billing sources', async () => {
    const http = httpResponses([{ payload: { config: { ...weekly.config, isUnifiedBillingUser: true,
      onDemandCap: { val: 100 }, onDemandUsed: { val: 10 } } } }, { payload: monthly }]);
    const result = await fetchXaiQuota({ http, credential: subscription, nowMs });
    expect(result.limits.filter((limit) => limit.id.startsWith('on-demand')).map((limit) => limit.used)).toEqual([10, 25]);
  });

  it('does not turn cancellation into a quota observation or make another request', async () => {
    const controller = new AbortController();
    const reason = new Error('fake cancellation');
    const request = vi.fn<Http['request']>(async () => { controller.abort(reason); throw reason; });
    await expect(fetchXaiQuota({ http: { request }, credential: subscription, nowMs, signal: controller.signal })).rejects.toBe(reason);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
