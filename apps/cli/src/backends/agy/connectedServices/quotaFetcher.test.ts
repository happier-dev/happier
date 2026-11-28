import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '@/daemon/connectedServices/accountUsage/fromConnectedServiceQuotaObservation';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { buildConnectedServiceAuthGroupSwitchStateFromAccountUsage } from '@/daemon/connectedServices/accountGroups/switching/buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, selectConnectedServiceAuthGroupCandidate } from '@/daemon/connectedServices/accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createAgyQuotaFetcher } from './quotaFetcher';

function record(raw: Readonly<{ project_id?: string }> | null = null, profileId = 'agy-selected') {
  return buildConnectedServiceCredentialRecord({ now: 1000, serviceId: 'antigravity', profileId, kind: 'oauth', expiresAt: 9000,
    oauth: { accessToken: 'agy-selected-token', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: `${profileId}-google-id`, providerEmail: 'agy@example.com', raw } });
}

// Shapes captured 2026-11-27 from daily-cloudcode-pa with the Antigravity client identity
// (values redacted/replaced). A consumer account carries a free current tier plus its paid tier.
const LIVE_LOAD_CODE_ASSIST = { currentTier: { id: 'free-tier', name: 'Antigravity' }, cloudaicompanionProject: 'live-project', gcpManaged: false,
  allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier', userDefinedCloudaicompanionProject: true, usesGcpTos: true }],
  paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } };
function liveSummary(weeklyRemaining: number) {
  return { description: 'Quota', groups: [
    { displayName: 'Gemini Pro', description: 'Pro models', buckets: [
      { bucketId: 'pro-weekly', displayName: 'Weekly', window: 'weekly', resetTime: '2026-12-03T10:00:00Z', description: 'Weekly', remainingFraction: weeklyRemaining },
      { bucketId: 'pro-5h', displayName: '5 hours', window: '5h', resetTime: '2026-11-27T15:00:00Z', description: '5 hours', disabled: true, remainingFraction: 0.6994001 },
    ] },
    { displayName: 'Gemini Flash', description: 'Flash models', buckets: [
      { bucketId: 'flash-weekly', displayName: 'Weekly', window: 'weekly', remainingFraction: 1 },
      { bucketId: 'flash-5h', displayName: '5 hours', window: '5h', remainingFraction: 1 },
    ] },
  ] };
}
// An account that has never been onboarded to Code Assist (native agy onboards on its first run):
// a well-formed entitlement with an onboardable free tier, but no current tier or project yet.
const NOT_ONBOARDED_LOAD_CODE_ASSIST = { gcpManaged: false,
  allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier', userDefinedCloudaicompanionProject: true, usesGcpTos: true }] };

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
  it('reports an account awaiting a user-defined project as unknown quota without enrolling it or inventing allowance', async () => {
    const requests: string[] = [];
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async (url, init) => {
      requests.push(url);
      return unsupportedClientResponse(init) ?? Response.json({ currentTier: { id: 'standard-tier', userDefinedCloudaicompanionProject: true } });
    } });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(requests).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']);
    expect(snapshot).toMatchObject({ serviceId: 'antigravity', profileId: 'agy-selected', meters: [] });
  });
  // Native agy onboards an account on its first run; a pool member connected through Happier may
  // never have run agy. Onboarding follows the Code Assist login contract (same as 0.3's
  // discoverAntigravityProject): onboardUser(free-tier) → poll the operation → load the project.
  it('onboards a never-onboarded account and then reads its real quota', async () => {
    const requests: Array<{ url: string; method: string; body: unknown; userAgent: string | null }> = [];
    let onboarded = false;
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async (url, init) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, userAgent: new Headers(init.headers).get('user-agent') });
      const unsupported = unsupportedClientResponse(init);
      if (unsupported) return unsupported;
      if (url.endsWith(':loadCodeAssist')) return Response.json(onboarded ? LIVE_LOAD_CODE_ASSIST : NOT_ONBOARDED_LOAD_CODE_ASSIST);
      if (url.endsWith(':onboardUser')) return Response.json({ name: 'operations/onboard-1', done: false });
      if (url.endsWith('/v1internal/operations/onboard-1')) {
        onboarded = true;
        return Response.json({ name: 'operations/onboard-1', done: true, response: { '@type': 'type.googleapis.com/OnboardUserResponse' } });
      }
      return Response.json(liveSummary(0.8));
    } });
    const snapshot = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal });
    expect(requests.map(({ url, method }) => `${method} ${url}`)).toEqual([
      'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser',
      'GET https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-1',
      'POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
      'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    ]);
    expect(requests[1]?.body).toEqual({ tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
    expect(requests[4]?.body).toEqual({ project: 'live-project' });
    expect(snapshot?.meters).toContainEqual(expect.objectContaining({ providerLimitId: 'pro-weekly', remainingPct: 80, isExhausted: false }));
  });
  it.each([
    ['the onboarding operation fails', { name: 'operations/onboard-1', done: true, error: { code: 7, message: 'private vendor response' } }, NOT_ONBOARDED_LOAD_CODE_ASSIST, 'antigravity_onboarding_failed'],
    ['onboarding leaves no project', { name: 'operations/onboard-1', done: true, response: {} }, { currentTier: { id: 'free-tier' } }, 'antigravity_quota_malformed:onboarded_without_project:allowed=-;ineligible=-;paid=-'],
  ])('fails observably without inventing quota when %s', async (_name, operation, reloaded, message) => {
    const requests: string[] = [];
    let onboarded = false;
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => {
      requests.push(url);
      if (url.endsWith(':loadCodeAssist')) return Response.json(onboarded ? reloaded : NOT_ONBOARDED_LOAD_CODE_ASSIST);
      if (url.endsWith(':onboardUser')) { onboarded = true; return Response.json(operation); }
      return Response.json(liveSummary(1));
    } });
    const error = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message });
    expect(String((error as Error).message)).not.toContain('private vendor response');
    expect(requests.some(url => url.includes('retrieveUserQuota'))).toBe(false);
  });
  // agy's Code Assist contract: an account Google must verify first is reported as an ineligible
  // tier with reason VALIDATION_REQUIRED (plus a validation link agy sometimes drops).
  it.each([
    ['without an allowed free tier', [{ id: 'standard-tier', userDefinedCloudaicompanionProject: true }]],
    ['while the free tier is offered', [{ id: 'free-tier', isDefault: true }]],
  ])('reports an account awaiting Google verification %s as validation required without onboarding it', async (_name, allowedTiers) => {
    const requests: string[] = [];
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => {
      requests.push(url);
      return Response.json({ allowedTiers, ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED', tierId: 'free-tier',
        reasonMessage: 'private vendor response', validationUrl: 'https://accounts.google.com/signin/continue?private' }] });
    } });
    const error = await fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'antigravity_validation_required', providerCode: 'antigravity_validation_required' });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(requests).toEqual(['https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']);
  });
  it('keeps an unidentified-client entitlement malformed', async () => {
    const fetcher = createAgyQuotaFetcher({ fetchRuntime: async () => unsupportedClientResponse({ headers: {} })! });
    // The reason names the failed check and the provider's own tier ids and ineligibility codes,
    // so a refresh log tells an unidentified client apart from an account that is not onboarded.
    await expect(fetcher.fetch({ record: record(), now: 2000, signal: new AbortController().signal })).rejects.toMatchObject({
      quotaFetchErrorCode: 'malformed',
      message: 'antigravity_quota_malformed:no_project_or_tier:allowed=standard-tier;ineligible=UNSUPPORTED_CLIENT;paid=-',
    });
  });
});

describe('Antigravity pool hard-limit recovery from fetched quota', () => {
  const nowMs = 2000;
  function group(): ConnectedServiceAuthGroupV1 {
    const member = (profileId: string, priority: number) => ({ v: 1 as const, serviceId: 'antigravity' as const, groupId: 'agy', profileId,
      enabled: true, priority, createdAt: 1, updatedAt: 1, state: { credentialHealthStatus: 'connected' as const } });
    return { v: 1, serviceId: 'antigravity', groupId: 'agy', displayName: 'agy', activeProfileId: 'exhausted', generation: 3, runtimeStateRevision: 0,
      state: { lastSwitchReason: 'usage_limit', lastSwitchAt: 1 }, createdAt: 1, updatedAt: 1,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
      members: [member('exhausted', 1), member('candidate', 2)] };
  }
  async function select(candidateLoad: unknown, candidateWeekly: number) {
    const store = createProviderAccountUsageStore();
    const g = group();
    for (const [profileId, load, weekly] of [['exhausted', LIVE_LOAD_CODE_ASSIST, 0], ['candidate', candidateLoad, candidateWeekly]] as const) {
      let onboarded = false;
      const fetcher = createAgyQuotaFetcher({ fetchRuntime: async url => {
        if (url.endsWith(':onboardUser')) { onboarded = true; return Response.json({ done: true, response: {} }); }
        return Response.json(url.endsWith(':loadCodeAssist') ? onboarded ? LIVE_LOAD_CODE_ASSIST : load : liveSummary(weekly));
      } });
      const snapshot = await fetcher.fetch({ record: record(null, profileId), now: nowMs, signal: new AbortController().signal });
      store.recordSnapshot(buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: snapshot!, sourceProviderAccountId: `${profileId}-google-id` }),
        { sources: [{ serviceId: 'antigravity', profileId, bindingKind: 'group_member', groupId: 'agy', groupGeneration: g.generation }] });
    }
    const { state } = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({ group: g, accountUsageStore: store });
    return selectConnectedServiceAuthGroupCandidate({ ...state, nowMs, quotaFreshnessMs: 300_000, switchReason: 'usage_limit' });
  }
  it('selects a member whose live-shaped quota has headroom while the active member is at its weekly limit', async () => {
    const selection = await select(LIVE_LOAD_CODE_ASSIST, 0.8);
    expect(selection.selected?.profileId).toBe('candidate');
    expect(selection.decisionTrace.candidates).toContainEqual(expect.objectContaining({ profileId: 'exhausted', decision: 'excluded' }));
  });
  it('does not select a member whose live-shaped weekly quota is also exhausted', async () => {
    expect((await select(LIVE_LOAD_CODE_ASSIST, 0)).selected).toBeNull();
  });
  it('onboards a never-used member so its real quota decides hard-limit recovery', async () => {
    expect((await select(NOT_ONBOARDED_LOAD_CODE_ASSIST, 1)).selected?.profileId).toBe('candidate');
    expect((await select(NOT_ONBOARDED_LOAD_CODE_ASSIST, 0)).selected).toBeNull();
  });
});
