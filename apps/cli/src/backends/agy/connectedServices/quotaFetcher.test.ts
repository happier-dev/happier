import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { createAgyQuotaFetcher } from './quotaFetcher';

function record(raw: Readonly<{ project_id?: string }> | null = null) {
  return buildConnectedServiceCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId: 'agy-selected', kind: 'oauth', expiresAt: 9000,
    oauth: { accessToken: 'agy-selected-token', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'selected-google-id', providerEmail: 'agy@example.com', raw } });
}

// Google returns HTTP 200 without a project/tier when the client is not
// identified as Antigravity, even with a valid Antigravity OAuth token.
function unsupportedClientResponse(init: RequestInit): Response | null {
  if (new Headers(init.headers).get('user-agent')?.startsWith('antigravity/')) return null;
  return Response.json({
    allowedTiers: [{ id: 'standard-tier', userDefinedCloudaicompanionProject: true }],
    ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }],
  });
}
// Response fields and endpoint selection are sourced from Antigravity ACP 1.3.0's
// bundled CCPA discovery document and ccpa_connection/onboard.py, not live auth proof.
describe('Antigravity selected-account quota summary', () => {
  it('reads the wrapped summary and project object without losing provider windows', async () => {
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => Response.json(url.endsWith(':loadCodeAssist')
      ? { currentTier: { id: 'free' }, cloudaicompanionProject: { id: 'selected-project' } }
      : { quotaSummary: { groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 }] }] } }) });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(snapshot?.meters[0]).toMatchObject({ providerLimitId: 'gemini-weekly', scope: 'weekly', windowDurationMs: 604800000, remainingPct: 40 });
  });
  it('retains exact model identity when only per-model quota is available', async () => {
    const requests: string[] = [];
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async (url, init) => {
      requests.push(url);
      const unsupported = unsupportedClientResponse(init);
      if (unsupported) return unsupported;
      return Response.json(url.endsWith(':loadCodeAssist') ? { currentTier: { id: 'free' }, cloudaicompanionProject: 'project' }
        : url.endsWith(':retrieveUserQuotaSummary') ? { groups: [] }
        : { buckets: [{ modelId: 'gemini-2.5-flash', remainingFraction: 0.2 }, { modelId: 'gemini-3-flash', tokenType: 'REQUESTS', remainingFraction: 0.8, remainingAmount: '80' }, { modelId: 'gemini-3-flash', tokenType: 'WTUS', remainingFraction: 0.4, remainingAmount: '40' }] });
    } });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(requests.at(-1)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    expect(snapshot?.meters).toMatchObject([
      { meterId: 'model:gemini-2.5-flash', modelId: 'gemini-2.5-flash', remainingPct: 20, scope: 'model' },
      { meterId: 'model:["gemini-3-flash","REQUESTS"]', modelId: 'gemini-3-flash', remainingPct: 80, scope: 'model', unit: 'requests' },
      { meterId: 'model:["gemini-3-flash","WTUS"]', modelId: 'gemini-3-flash', remainingPct: 40, scope: 'model', unit: 'unknown', label: 'gemini-3-flash · WTUS' },
    ]);
  });
  it.each([false, true])('uses the selected bearer and tier endpoint (GCP terms: %s)', async usesGcpTos => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = createAgyQuotaFetcher({ staleAfterMs: 45000, fetchRuntime: async (url, init) => {
      requests.push({ url, init });
      const unsupported = unsupportedClientResponse(init);
      if (unsupported) return unsupported;
      return Response.json(url.endsWith(':loadCodeAssist') ? { currentTier: { id: 'selected-tier' }, paidTier: { usesGcpTos }, cloudaicompanionProject: 'selected-project' }
        : { groups: [{ displayName: 'Gemini Pro', buckets: [
          { bucketId: 'provider-window', window: 'provider-period', remainingFraction: 0.25, remainingAmount: '50', resetTime: '2026-10-09T12:00:00Z' },
          { bucketId: 'disabled-window', window: 'another-period', remainingFraction: 0, disabled: true },
        ] }] });
    } });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(requests.map(r => r.url)).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', `https://${usesGcpTos ? 'cloudcode-pa' : 'daily-cloudcode-pa'}.googleapis.com/v1internal:retrieveUserQuotaSummary`]);
    expect(requests.every(r => (r.init.headers as Record<string, string>).authorization === 'Bearer agy-selected-token')).toBe(true);
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({ project: 'selected-project' });
    expect(snapshot).toMatchObject({ serviceId: 'antigravity', profileId: 'agy-selected', accountLabel: 'agy@example.com', staleAfterMs: 45000, meters: [
      { meterId: 'provider-window', label: 'Gemini Pro · provider-period', remaining: 50, used: 150, limit: 200, utilizationPct: 75, resetsAt: Date.parse('2026-10-09T12:00:00Z'), status: 'ok' },
      { meterId: 'disabled-window', status: 'unavailable', details: { code: 'provider_disabled' } },
    ] });
  });
  it('preserves explicit project and normalizes the deprecated flat response without inventing exhausted capacity', async () => {
    const bodies: unknown[] = [];
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async (url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(url.endsWith(':loadCodeAssist') ? { currentTier: { id: 'business' }, paidTier: { usesGcpTos: true }, cloudaicompanionProject: 'different-project' }
        : { buckets: [{ bucketId: 'flat-id', displayName: 'Provider limit', remainingFraction: 0, remainingAmount: '0' }] });
    } });
    const snapshot = await fetcher.fetch({ record: record({ project_id: 'explicit-project' }), now: 2000, signal: new AbortController().signal });
    expect(bodies[0]).toMatchObject({ cloudaicompanionProject: 'explicit-project' });
    expect(bodies[1]).toEqual({ project: 'explicit-project' });
    expect(snapshot?.meters[0]).toMatchObject({ meterId: 'flat-id', limit: null, used: null, remaining: 0, utilizationPct: 100, isExhausted: true });
  });
  it('does not enroll or fetch quota without a resolved project and active tier', async () => {
    const requests: string[] = [];
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => { requests.push(url); return Response.json({}); } });
    await expect(fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal })).rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
    expect(requests).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']);
  });
  it('keeps informational groups, unknown allowance and legitimate zero usage distinct', async () => {
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => Response.json(url.endsWith(':loadCodeAssist')
      ? { currentTier: { id: 'free' }, cloudaicompanionProject: 'project' }
      : { groups: [{ displayName: 'Informational' }, { buckets: [
          { bucketId: 'unknown', resetTime: 'unavailable' },
          { bucketId: 'unused', remainingFraction: 1, remainingAmount: '90' },
        ] }] }) });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(snapshot?.meters).toMatchObject([
      { meterId: 'unknown', status: 'unavailable', limit: null, used: null, utilizationPct: null, resetsAt: null, isExhausted: false },
      { meterId: 'unused', status: 'ok', limit: 90, used: 0, remaining: 90, utilizationPct: 0, isExhausted: false },
    ]);
  });
  it('rejects malformed success and upstream failures instead of emitting fresh empty allowance', async () => {
    for (const response of [Response.json({}), Response.json({}, { status: 503 })]) {
      const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => url.endsWith(':loadCodeAssist') ? Response.json({ currentTier: { id: 'free' }, cloudaicompanionProject: 'project' }) : response });
      await expect(fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal })).rejects.toHaveProperty('quotaFetchErrorCode');
    }
  });
});
