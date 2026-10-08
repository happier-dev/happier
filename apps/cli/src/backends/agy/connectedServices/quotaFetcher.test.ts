import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_CLIENT_ID } from '@happier-dev/agents';
import { buildConnectedServiceCredentialRecord, ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';

import { createConnectedServiceQuotaFetchers } from '@/daemon/connectedServices/quotas/createConnectedServiceQuotaFetchers';

const now = 1_000_000;
const record = buildConnectedServiceCredentialRecord({
  now, serviceId: 'antigravity', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
  oauth: { accessToken: 'private-access', refreshToken: 'private-refresh', idToken: null, scope: null, tokenType: 'Bearer',
    providerAccountId: 'account-a', providerEmail: 'a@example.test',
    raw: { antigravity: { clientId: AGY_OAUTH_CLIENT_ID, authMethod: 'oauth-personal', projectId: 'project-a' } } },
});
function fetcher() {
  const result = createConnectedServiceQuotaFetchers({ HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS: '123000' }).find((item) => item.serviceId === 'antigravity');
  expect(result, 'AGY must be wired into the daemon quota catalog').toBeDefined();
  return result!;
}
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.unstubAllGlobals());

describe('Antigravity quota through the daemon catalog', () => {
  it('uses live model buckets, keeps missing limits unknown and preserves shared windows without inventing counts', async () => {
    const network = vi.fn(async (url: string) => {
      if (url.endsWith(':retrieveUserQuota')) return response({ buckets: [
        { modelId: 'gemini-pro', remainingFraction: .25, resetTime: '2026-10-08T02:08:12Z' },
        { modelId: 'claude-opus', remainingFraction: null },
      ] });
      if (url.endsWith(':retrieveUserQuotaSummary')) return response({ groups: [{ displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: .7 },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0 },
      ] }] });
      return response({ models: {
        'claude-opus': { displayName: 'Claude Opus', quotaInfo: { remainingFraction: 1 } },
        'gemini-flash': { displayName: 'Gemini Flash', quotaInfo: { remainingFraction: .8 } },
      } });
    });
    vi.stubGlobal('fetch', network);
    const snapshot = await fetcher().fetch({ record, now, signal: new AbortController().signal });
    expect(ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ serviceId: 'antigravity', profileId: 'work', accountLabel: 'a@example.test', staleAfterMs: 123000 });
    expect(snapshot?.meters).toHaveLength(3);
    expect(snapshot?.meters.find((m) => m.meterId === 'family:claude-opus')).toMatchObject({ remainingPct: null, utilizationPct: null, status: 'unavailable' });
    expect(snapshot?.meters.find((m) => m.providerLimitId === 'gemini-weekly')).toMatchObject({ scope: 'weekly', remainingPct: 70, label: 'Gemini · Weekly' });
    expect(snapshot?.meters.find((m) => m.providerLimitId === 'gemini-5h')).toMatchObject({ scope: 'five_hour', remainingPct: 0, isExhausted: true });
    expect(snapshot?.meters.every((m) => m.used === null && m.limit === null)).toBe(true);
    expect(network.mock.calls.every(([url]) => /:(retrieveUserQuota|retrieveUserQuotaSummary|fetchAvailableModels)$/.test(url))).toBe(true);
    expect(network.mock.calls).toHaveLength(3);
  });

  it('keeps valid model quotas when optional summary is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith(':retrieveUserQuotaSummary')
      ? response({}, 404) : url.endsWith(':retrieveUserQuota') ? response({ buckets: [{ modelId: 'model', remainingFraction: .5 }] }) : response({ models: {} })));
    expect((await fetcher().fetch({ record, now, signal: new AbortController().signal }))?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'model', remainingPct: 50 })]));
  });

  it.each(['fetchAvailableModels', 'retrieveUserQuotaSummary'])('retains live quota and honors RetryAfter only for optional %s', async (optionalRpc) => {
    let liveFraction = .25;
    const network = vi.fn(async (url: string) => {
      if (url.endsWith(`:${optionalRpc}`)) return response({}, 429, { 'retry-after': '60' });
      if (url.endsWith(':retrieveUserQuota')) return response({ buckets: [{ modelId: 'model', remainingFraction: liveFraction }] });
      return url.endsWith(':fetchAvailableModels') ? response({ models: {} }) : response({ groups: [] });
    });
    vi.stubGlobal('fetch', network);
    const owner = fetcher();
    const poll = (at: number) => owner.fetch({ record, now: at, signal: new AbortController().signal });
    expect((await poll(now))?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'model', remainingPct: 25 })]));
    liveFraction = .4;
    expect((await poll(now + 1_000))?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'model', remainingPct: 40 })]));
    expect(network.mock.calls.filter(([url]) => url.endsWith(`:${optionalRpc}`))).toHaveLength(1);
    expect(network.mock.calls.filter(([url]) => url.endsWith(':retrieveUserQuota'))).toHaveLength(2);
    const otherOptional = optionalRpc === 'fetchAvailableModels' ? 'retrieveUserQuotaSummary' : 'fetchAvailableModels';
    expect(network.mock.calls.filter(([url]) => url.endsWith(`:${otherOptional}`))).toHaveLength(2);
    expect((await poll(now + 60_001))?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'model', remainingPct: 40 })]));
    expect(network.mock.calls.filter(([url]) => url.endsWith(`:${optionalRpc}`))).toHaveLength(2);
  });

  it.each([
    { providerAccountId: 'account-b', projectId: 'project-a' },
    { providerAccountId: 'account-a', projectId: 'project-b' },
  ])('keeps optional RPC backoff isolated for $providerAccountId / $projectId', async ({ providerAccountId, projectId }) => {
    const otherRecord = buildConnectedServiceCredentialRecord({
      now, serviceId: 'antigravity', profileId: 'other', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'other-access', refreshToken: 'other-refresh', idToken: null, scope: null, tokenType: 'Bearer',
        providerAccountId, providerEmail: 'b@example.test',
        raw: { antigravity: { clientId: 'native-client', authMethod: 'oauth-personal', projectId } } },
    });
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(':retrieveUserQuota')) return response({ buckets: [{ modelId: 'model', remainingFraction: .5 }] });
      if (url.endsWith(':fetchAvailableModels')) return new Headers(init?.headers).get('authorization') === 'Bearer private-access' ? response({}, 429, { 'retry-after': '60' })
        : response({ models: { additional: { quotaInfo: { remainingFraction: .8 } } } });
      return response({ groups: [] });
    });
    vi.stubGlobal('fetch', network);
    const owner = fetcher();
    await owner.fetch({ record, now, signal: new AbortController().signal });
    const second = await owner.fetch({ record: otherRecord, now: now + 1_000, signal: new AbortController().signal });
    expect(second?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'additional', remainingPct: 80 })]));
    expect(network.mock.calls.filter(([url]) => url.endsWith(':fetchAvailableModels'))).toHaveLength(2);
  });

  it('falls back to model catalog when live buckets are unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith(':fetchAvailableModels')
      ? response({ models: { model: { quotaInfo: { remainingFraction: .1 } }, unknown: { quotaInfo: {} } } }) : response({}, 404)));
    const snapshot = await fetcher().fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters.find((m) => m.modelId === 'model')?.remainingPct).toBe(10);
    expect(snapshot?.confidence).toBe('estimated');
    expect(snapshot?.meters.find((m) => m.modelId === 'unknown')?.remainingPct).toBeNull();
  });

  it.each([401, 403, 429])('classifies HTTP %s and sanitizes provider errors', async (status) => {
    const network = vi.fn(async () => response({ error: { message: 'private-access private-refresh' } }, status, { 'retry-after': '60' }));
    vi.stubGlobal('fetch', network);
    const promise = fetcher().fetch({ record, now, signal: new AbortController().signal });
    await expect(promise).rejects.toMatchObject({ status, quotaFetchErrorCode: status === 401 ? 'auth_failure' : 'provider_backoff', retryAfterMs: 60000 });
    await expect(promise).rejects.not.toThrow(/private-access|private-refresh/);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation without trying another endpoint', async () => {
    const controller = new AbortController(); controller.abort();
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    await expect(fetcher().fetch({ record, now, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(network).not.toHaveBeenCalled();
  });

  it('does not convert absent, nonnumeric, or out-of-range fractions into usable quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith(':retrieveUserQuota') ? response({ buckets: [
      { modelId: 'absent' }, { modelId: 'negative', remainingFraction: -.2 },
      { modelId: 'too-large', remainingFraction: 2 }, { modelId: 'string', remainingFraction: '1' },
    ] }) : url.endsWith(':fetchAvailableModels') ? response({ models: {} }) : response({ groups: [] })));
    const snapshot = await fetcher().fetch({ record, now, signal: new AbortController().signal });
    expect(snapshot?.meters).toHaveLength(4);
    expect(snapshot?.meters.every((meter) => meter.remainingPct === null && meter.status === 'unavailable')).toBe(true);
  });

  it('reports malformed provider bodies instead of treating them as unlimited quota', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ unexpected: 'shape' })));
    await expect(fetcher().fetch({ record, now, signal: new AbortController().signal })).rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
  });
});
