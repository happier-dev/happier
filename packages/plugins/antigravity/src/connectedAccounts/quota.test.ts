import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { readAntigravityQuota } from './quota.js';

type Context = Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
function context(request: Context['services']['http']['request'], projectId?: string): Context {
  const values = new Map([['accessToken', 'selected-access'], ...(projectId ? [['projectId', projectId] as [string, string]] : [])]);
  const account = { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected-account' };
  // Credential and HTTP services are genuine host boundaries; internal quota parsing stays real.
  return { account, credentials: { async get(key: string) { return values.get(key) ?? null; } }, signal: new AbortController().signal,
    configuration: { target: { kind: 'account', account, modeId: 'oauth-personal' }, revision: 'config-1', values: {}, async getSecret() { return null; } },
    services: { http: { request } },
  } as Context;
}
function response(status: number, body: unknown) {
  return { status, finalUrl: 'https://cloudcode-pa.googleapis.com', headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}
// ACP 1.3.0 requires its product identity even when the OAuth token is valid.
function unsupportedClientResponse(headers: Readonly<Record<string, string>> | undefined) {
  if (new Headers(headers).get('user-agent')?.startsWith('antigravity/')) return null;
  return response(200, {
    allowedTiers: [{ id: 'standard-tier', userDefinedCloudaicompanionProject: true }],
    ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }],
  });
}
// Antigravity ACP 1.3.0 onboard.py and bundled CCPA discovery schema; synthetic response evidence.
describe('Antigravity qualified quota', () => {
  it('reads wrapped summaries and project objects while preserving provider windows', async () => {
    const quota = await readAntigravityQuota(context(async request => response(200, request.url.endsWith(':loadCodeAssist')
      ? { currentTier: { id: 'free' }, cloudaicompanionProject: { id: 'project' } }
      : { quotaSummary: { groups: [{ displayName: 'Provider group', buckets: [{ bucketId: 'window', window: 'weekly', remainingFraction: 0.4 }] }] } })));
    expect(quota.limits[0]).toMatchObject({ providerLimitId: 'window', scope: 'weekly', windowDurationMs: 604800000, remainingPct: 40 });
  });
  it('preserves exact model versions when the provider only returns per-model quota', async () => {
    const requests: string[] = [];
    const quota = await readAntigravityQuota(context(async request => {
      requests.push(request.url);
      const unsupported = unsupportedClientResponse(request.headers);
      if (unsupported) return unsupported;
      return response(200, request.url.endsWith(':loadCodeAssist') ? { currentTier: { id: 'free' }, cloudaicompanionProject: 'project' }
        : request.url.endsWith(':retrieveUserQuotaSummary') ? { groups: [] }
        : { buckets: [{ modelId: 'gemini-2.5-flash', remainingFraction: 0.2 }, { modelId: 'gemini-3-flash', tokenType: 'REQUESTS', remainingFraction: 0.8, remainingAmount: '80' }, { modelId: 'gemini-3-flash', tokenType: 'WTUS', remainingFraction: 0.4, remainingAmount: '40' }] });
    }));
    expect(requests.at(-1)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
    expect(quota.limits).toMatchObject([
      { id: 'model:gemini-2.5-flash', modelId: 'gemini-2.5-flash', remainingPct: 20, scope: 'model' },
      { id: 'model:["gemini-3-flash","REQUESTS"]', modelId: 'gemini-3-flash', remainingPct: 80, scope: 'model', unit: 'requests' },
      { id: 'model:["gemini-3-flash","WTUS"]', modelId: 'gemini-3-flash', remainingPct: 40, scope: 'model', unit: 'unknown', label: 'gemini-3-flash · WTUS' },
    ]);
  });

  it.each([false, true])('uses selected bearer/project and returned tier endpoint (GCP terms: %s)', async usesGcpTos => {
    const requests: Array<{ url: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array }> = [];
    const quota = await readAntigravityQuota(context(async request => {
      requests.push(request);
      const unsupported = unsupportedClientResponse(request.headers);
      if (unsupported) return unsupported;
      return response(200, request.url.endsWith(':loadCodeAssist')
        ? { currentTier: { id: 'tier' }, paidTier: { usesGcpTos }, cloudaicompanionProject: 'provider-project' }
        : { groups: [{ displayName: 'Provider group', buckets: [
            { bucketId: 'window', window: 'provider-period', remainingAmount: '50', remainingFraction: 0.25, resetTime: '2026-10-09T12:00:00Z' },
            { bucketId: 'disabled', remainingFraction: 0, disabled: true },
            { bucketId: 'unknown' },
          ] }] });
    }, 'selected-project'));
    expect(requests.map(request => request.url)).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      `https://${usesGcpTos ? 'cloudcode-pa' : 'daily-cloudcode-pa'}.googleapis.com/v1internal:retrieveUserQuotaSummary`]);
    expect(requests.every(request => request.headers?.Authorization === 'Bearer selected-access')).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(requests[1]?.body))).toEqual({ project: 'selected-project' });
    expect(quota.limits).toMatchObject([
      { id: 'window', label: 'Provider group · provider-period', used: 150, limit: 200, remaining: 50, remainingPct: 25,
        utilizationPct: 75, resetsAtMs: Date.parse('2026-10-09T12:00:00Z'), status: 'ok', details: { rawScope: 'provider-period' } },
      { id: 'disabled', isExhausted: false, status: 'unavailable', details: { code: 'provider_disabled' } },
      { id: 'unknown', status: 'unavailable' },
    ]);
  });
  it('preserves deprecated exhausted buckets without manufacturing capacity and refuses missing entitlement', async () => {
    const quota = await readAntigravityQuota(context(async request => response(200, request.url.endsWith(':loadCodeAssist')
      ? { currentTier: { id: 'tier' }, cloudaicompanionProject: 'project' }
      : { buckets: [{ bucketId: 'empty', remainingFraction: 0, remainingAmount: '0' }] })));
    expect(quota.limits[0]).toMatchObject({ id: 'empty', remaining: 0, limit: null, isExhausted: true });
    const requests: string[] = [];
    await expect(readAntigravityQuota(context(async request => { requests.push(request.url); return response(200, {}); }))).rejects.toHaveProperty('quotaFetchErrorCode', 'malformed');
    expect(requests).toHaveLength(1);
  });
  it('reports upstream and malformed successes as errors', async () => {
    for (const status of [200, 503]) {
      await expect(readAntigravityQuota(context(async request => request.url.endsWith(':loadCodeAssist')
        ? response(200, { currentTier: {}, cloudaicompanionProject: 'project' }) : response(status, {})))).rejects.toHaveProperty('quotaFetchErrorCode');
    }
  });
});
