import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { createGeminiQuotaFetcher } from './quotaFetcher';

function geminiQuotaRecord() {
  return buildConnectedServiceCredentialRecord({ now: 1000, serviceId: 'gemini', profileId: 'selected', kind: 'oauth', expiresAt: 9000,
    oauth: { accessToken: 'selected-token', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: 'selected@example.com' } });
}

describe('Gemini selected-account quota', () => {
  it('fetches daemon quota through the selected bearer and project', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = createGeminiQuotaFetcher({ staleAfterMs: 123000, fetchRuntime: async (url, init) => {
      requests.push({ url, init });
      return Response.json(url.endsWith(':loadCodeAssist') ? { cloudaicompanionProject: 'selected-project' }
        : { buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.25, remainingAmount: '50' }] });
    } });
    const snapshot = await fetcher.fetch({ record: geminiQuotaRecord(), now: 2000, signal: new AbortController().signal });
    expect(requests.every(({ init }) => !new Headers(init.headers).has('user-agent'))).toBe(true);
    expect(requests.map(r => r.url)).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota']);
    expect(requests[1]?.init.headers).toMatchObject({ authorization: 'Bearer selected-token' });
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ project: 'selected-project' });
    expect(snapshot).toMatchObject({ profileId: 'selected', staleAfterMs: 123000, meters: [{ meterId: 'gemini-pro', used: 150, limit: 200, utilizationPct: 75, status: 'ok' }] });
  });
  it('reports upstream failure rather than a successful unavailable or empty snapshot', async () => {
    const fetcher = createGeminiQuotaFetcher({ fetchRuntime: async () => Response.json({}, { status: 401 }) });
    await expect(fetcher.fetch({ record: geminiQuotaRecord(), now: 2000, signal: new AbortController().signal })).rejects.toMatchObject({ quotaFetchErrorCode: 'auth_failure', status: 401 });
  });
});
