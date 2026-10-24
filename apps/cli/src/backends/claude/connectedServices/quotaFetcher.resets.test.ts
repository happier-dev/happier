import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, ConnectedServiceCredentialRecordV1Schema, ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';

import { createClaudeSubscriptionQuotaFetcher } from './quotaFetcher';

// Provider vectors: oh-my-pi ca18a903c5d7c946c26c728a66d3a9151f0c26b1,
// packages/ai/src/usage/claude-reset.ts; only the HTTP transport is replaced.
const now = Date.parse('2026-10-11T10:00:00Z');
const signal = new AbortController().signal;
const record = buildConnectedServiceCredentialRecord({
  now, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
  oauth: { accessToken: 'oauth-placeholder', refreshToken: 'refresh-placeholder', idToken: null,
    scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
    tokenType: null, providerAccountId: 'account-is-not-organization', providerEmail: null },
});
const grant = { id: 'promo', label: 'Promotion', resets_total: 2, resets_left: 1,
  starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z',
  clears: ['five_hour', 'seven_day', 'seven_day_overage_included'], blocking: [], percent_used: {},
  paused: false, usable_now: true, use_requires_limit: false };
const evaluated = { cedar_ember: { eligible: true, grants: [grant], next_grant_id: 'promo', cooldown_until: null },
  juniper_tide: { eligible: false, ineligible_reason: 'not_at_wall', in_experiment: false, available: false } };
const ordinary = { five_hour: { utilization: 100, resets_at: '2026-10-11T11:00:00Z' },
  extra_usage: { is_enabled: true, used_credits: 23, monthly_limit: 100, utilization: 23 }, cedar_ember: null };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function fetcher() { return createClaudeSubscriptionQuotaFetcher({ userAgent: 'claude-cli/2.1.296 (external, cli)' }); }

describe('Claude provider reset vertical', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not consume a reset in a profile context belonging to another user', async () => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(
      init?.method === 'POST' ? { result: 'reset' }
        : String(url).endsWith('/profile')
          ? { account: { uuid: 'another-user' }, organization: { uuid: 'org-other' } }
          : evaluated,
    ));
    vi.stubGlobal('fetch', transport);
    await expect(fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'context-mismatch' }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
    expect(transport.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('does not debit another organization when the same user profile contradicts the credential context', async () => {
    const scopedRecord = ConnectedServiceCredentialRecordV1Schema.parse({
      ...record, oauth: { ...record.oauth, raw: { claudeAiOauth: { organizationUuid: 'org-selected' } } },
    });
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(
      init?.method === 'POST' ? { result: 'reset' }
        : String(url).endsWith('/profile')
          ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org-other' } }
          : evaluated,
    ));
    vi.stubGlobal('fetch', transport);
    await expect(fetcher().consumeRecoveryCredit!({ record: scopedRecord, now, signal, providerCreditId: 'promo', idempotencyKey: 'organization-mismatch' }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: false });
    expect(transport.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it.each([{ target: 'provider-seven-day', expected: 'consumed', posts: 1 },
    { target: 'seven_day', expected: 'not_available', posts: 0 }])('uses the actual provider limit identity for $target', async ({ target, expected, posts }) => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(init?.method === 'POST'
      ? { result: 'reset' } : String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } }
        : { seven_day: { utilization: 100, provider_limit_id: 'provider-seven-day' },
          cedar_ember: { eligible: true, next_grant_id: 'promo', grants: [{ ...grant, clears: [target] }] } }));
    vi.stubGlobal('fetch', transport);
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo',
      idempotencyKey: 'actual-limit-action', providerLimitIds: [target] })).toBe(expected);
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(posts);
  });

  it('evaluates reset programs separately and preserves ordinary spend meters', async () => {
    const transport = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => response(String(url).includes('?') ? evaluated : ordinary));
    vi.stubGlobal('fetch', transport);
    const snapshot = await fetcher().fetch({ record, now, signal });
    expect(ConnectedServiceQuotaSnapshotV1Schema.parse(snapshot).recoveryCredits).toMatchObject({
      availableCount: 1, totalCount: 2, credits: [{ providerCreditId: 'promo', providerResetType: 'cedar_ember', status: 'available' }],
    });
    expect(snapshot?.meters).toContainEqual(expect.objectContaining({ meterId: 'extra_usage', used: 23, limit: 100 }));
    expect(snapshot?.recoveryCreditDetails?.promo).toMatchObject({ remainingCount: 1,
      appliesToProviderLimitIds: ['five_hour', 'seven_day', 'seven_day_overage_included'] });
    expect(snapshot?.recoveryCredits?.credits[0]).toMatchObject({ title: 'Promotion', description: null });
    const [url, init] = transport.mock.calls[1];
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&at_wall=1&skip_spend=1');
    expect(init).toMatchObject({ headers: { 'User-Agent': 'claude-cli/2.1.296 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20' } });
  });

  it.each([
    { ...grant, usable_now: false }, { ...grant, paused: true },
    { ...grant, ends_at: '2026-10-01T00:00:00Z' },
  ])('does not count saved or expired unusable grants as redeemable', async (unusableGrant) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => response(String(url).includes('?')
      ? { cedar_ember: { ...evaluated.cedar_ember, grants: [unusableGrant] } } : ordinary)));
    const snapshot = await fetcher().fetch({ record, now, signal });
    expect(snapshot?.recoveryCredits?.availableCount).toBe(0);
    expect(snapshot?.recoveryCredits?.credits[0].status).not.toBe('available');
  });

  it('preserves usage when supplemental discovery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('?')) throw new Error('network unavailable');
      return response(ordinary);
    }));
    const snapshot = await fetcher().fetch({ record, now, signal });
    expect(snapshot?.meters).toContainEqual(expect.objectContaining({ meterId: 'extra_usage', used: 23 }));
    expect(snapshot?.recoveryCredits).toBeUndefined();
  });

  it('uses fresh selected eligibility and the organization UUID for exactly one Cedar POST', async () => {
    const scopedRecord = ConnectedServiceCredentialRecordV1Schema.parse({
      ...record, oauth: { ...record.oauth, raw: { claudeAiOauth: { organizationUuid: 'org-uuid' } } },
    });
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/profile')) return response({ account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org-uuid' } });
      if (init?.method === 'POST') return response({ result: 'reset', cleared: grant.clears });
      return response(String(url).includes('?') ? evaluated : ordinary);
    });
    vi.stubGlobal('fetch', transport);
    const provider = fetcher();
    expect(provider.consumeRecoveryCredit).toBeTypeOf('function');
    expect(await provider.consumeRecoveryCredit!({ record: scopedRecord, now, signal, providerCreditId: 'promo', idempotencyKey: 'account-action' })).toBe('consumed');
    const posts = transport.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('https://api.anthropic.com/api/organizations/org-uuid/reset_rate_limits');
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ program: 'cedar_ember', grant_id: 'promo',
      request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    await expect(provider.fetch({ record, now, signal })).resolves.not.toBeNull();
  });

  it.each(['wrong-grant', 'juniper_tide'])('never substitutes another program for a selected unavailable handle %s', async (providerCreditId) => {
    const transport = vi.fn(async () => response(evaluated)); vi.stubGlobal('fetch', transport);
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId, idempotencyKey: 'action' })).toBe('not_available');
    expect(transport.mock.calls).toHaveLength(1);
  });

  it.each([['already_used', 'already_consumed'], ['not_limited', 'nothing_to_reset'], ['ineligible', 'not_available'],
    ['unavailable', 'not_available'], ['cooldown', 'not_available']] as const)('maps confirmed %s outcome', async (result, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(init?.method === 'POST'
      ? { result } : String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } } : evaluated)));
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'action' })).toBe(expected);
  });

  it.each(['network', 'malformed', 'server'])('does not retry or claim a confirmed reset after %s uncertainty', async (mode) => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        if (mode === 'network') throw new Error('connection lost');
        return mode === 'server' ? response({}, 500) : response({ unexpected: true });
      }
      return response(String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } } : evaluated);
    });
    vi.stubGlobal('fetch', transport);
    await expect(fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'action' }))
      .rejects.toMatchObject({ recoveryCreditConsumeOutcomeUnknown: true });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('refuses an automatic reset that does not clear the exhausted model allowance', async () => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(init?.method === 'POST'
      ? { result: 'reset' } : String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } } : evaluated));
    vi.stubGlobal('fetch', transport);
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo',
      providerLimitIds: ['seven_day_opus'], idempotencyKey: 'automatic-action' })).toBe('not_available');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('discovers and consumes Juniper only with an authoritative available reset arm', async () => {
    const juniper = { five_hour: ordinary.five_hour, cedar_ember: evaluated.cedar_ember, juniper_tide: { eligible: true, arm: 'reset', available: true,
      resets_per_week: 3, weekly_resets_at: '2026-10-18T00:00:00Z' } };
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(init?.method === 'POST'
      ? { result: 'reset' } : String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } } : juniper));
    vi.stubGlobal('fetch', transport);
    const provider = fetcher();
    const snapshot = await provider.fetch({ record, now, signal });
    expect(snapshot?.recoveryCredits?.availableCount).toBe(2); // One selected Cedar unit + one Juniper unit, never resets_per_week.
    expect(snapshot?.recoveryCredits?.totalCount).toBeUndefined();
    expect(await provider.consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'juniper_tide',
      providerLimitIds: ['five_hour'], idempotencyKey: 'juniper-action' })).toBe('consumed');
    const post = transport.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ program: 'juniper_tide' });
  });

  it('refuses a formerly usable grant when fresh provider eligibility changed', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => response(String(url).includes('?')
      ? { cedar_ember: { ...evaluated.cedar_ember, grants: [{ ...grant, usable_now: false }] } } : ordinary));
    vi.stubGlobal('fetch', transport);
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'action' })).toBe('not_available');
    expect(transport.mock.calls).toHaveLength(1);
  });

  it('never substitutes the credential account ID for a missing organization', async () => {
    const transport = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => response(String(url).endsWith('/profile')
      ? { account: { uuid: 'account-is-not-organization' } } : evaluated));
    vi.stubGlobal('fetch', transport);
    await expect(fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'action' }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: false });
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('honors provider Retry-After from a failed supplemental read without erasing usage', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => String(url).includes('?')
      ? new Response('', { status: 429, headers: { 'Retry-After': '1800' } }) : response(ordinary));
    vi.stubGlobal('fetch', transport);
    const provider = fetcher();
    expect(await provider.fetch({ record, now, signal })).not.toBeNull();
    expect(await provider.fetch({ record, now: now + 60_000, signal })).toBeNull();
    expect(await provider.consumeRecoveryCredit!({ record, now: now + 60_000, signal, providerCreditId: 'promo', idempotencyKey: 'action' })).toBe('not_available');
    expect(transport.mock.calls).toHaveLength(2);
  });

  it('clears only the local failure cooldown after a confirmed reset so postconsume refresh can run', async () => {
    let usageFails = true;
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') { usageFails = false; return response({ result: 'reset' }); }
      if (String(url).endsWith('/profile')) return response({ account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } });
      if (String(url).includes('?')) return response(evaluated);
      return usageFails ? response({}, 500) : response(ordinary);
    });
    vi.stubGlobal('fetch', transport);
    const provider = fetcher();
    await expect(provider.fetch({ record, now, signal })).rejects.toThrow();
    expect(await provider.consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo', idempotencyKey: 'action' })).toBe('consumed');
    expect(await provider.fetch({ record, now, signal })).not.toBeNull();
  });

  it('does not dispatch a reset when canceled during fresh discovery', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => { controller.abort(); return response(evaluated); });
    vi.stubGlobal('fetch', transport);
    await expect(fetcher().consumeRecoveryCredit!({ record, now, signal: controller.signal, providerCreditId: 'promo', idempotencyKey: 'action' })).rejects.toBeDefined();
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it.each([{ providerLimitIds: [] }, { providerLimitIds: ['five_hour'] }])('does not automatically spend a usable grant without freshly proven target exhaustion ($providerLimitIds)', async ({ providerLimitIds }) => {
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => response(init?.method === 'POST'
      ? { result: 'reset' } : String(url).endsWith('/profile') ? { account: { uuid: 'account-is-not-organization' }, organization: { uuid: 'org' } }
        : { ...evaluated, five_hour: { utilization: 50 } }));
    vi.stubGlobal('fetch', transport);
    expect(await fetcher().consumeRecoveryCredit!({ record, now, signal, providerCreditId: 'promo',
      providerLimitIds, idempotencyKey: 'automatic-action' })).toBe('not_available');
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
});
