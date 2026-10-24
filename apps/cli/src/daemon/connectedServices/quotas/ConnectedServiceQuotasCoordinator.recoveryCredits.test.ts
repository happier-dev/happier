import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  buildRecoveryCreditConsumeIdempotencyKey,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { createClaudeSubscriptionQuotaFetcher } from '@/backends/claude/connectedServices/quotaFetcher';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
const serviceId = 'claude-subscription' as const;
const profileId = 'work';
const initialNow = Date.parse('2026-10-11T10:00:00Z');
const grant = { id: 'promo', resets_total: 2, resets_left: 2,
  starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z',
  clears: ['five_hour', 'seven_day'], paused: false, usable_now: true, use_requires_limit: false };

// The real coordinator and provider adapter run; only provider HTTP and account API transport are replaced.
async function createRecoveryHarness(program: 'cedar' | 'juniper' = 'cedar', pendingPost?: Promise<void>) {
  let now = initialNow;
  let snapshot: ConnectedServiceQuotaSnapshotV1 | null = null;
  const posts: Array<Readonly<{ program: string; grant_id?: string; request_id?: string }>> = [];
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (pendingPost) await pendingPost;
      return new Response(JSON.stringify({ result: 'reset', cleared: ['five_hour', 'seven_day'] }));
    }
    if (String(url).endsWith('/profile')) return new Response(JSON.stringify({ account: { uuid: 'account' }, organization: { uuid: 'org' } }));
    const recovery = program === 'cedar'
      ? { cedar_ember: { eligible: true, grants: [{ ...grant, resets_left: Math.max(0, 2 - posts.length) },
          { ...grant, id: 'other', resets_left: 1 }], next_grant_id: 'promo', cooldown_until: null },
        juniper_tide: { eligible: false, available: false } }
      : { cedar_ember: { eligible: false, grants: [] },
        juniper_tide: { eligible: true, arm: 'reset', available: posts.length < 2 } };
    const body = String(url).includes('?') ? { ...recovery, five_hour: { utilization: posts.length ? 0 : 100, resets_at: '2026-10-11T11:00:00Z' } }
      : { five_hour: { utilization: posts.length ? 0 : 100, resets_at: '2026-10-11T11:00:00Z' } };
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal('fetch', transport);
  const record = buildConnectedServiceCredentialRecord({
    now, serviceId, profileId, kind: 'oauth',
    oauth: { accessToken: 'placeholder', refreshToken: 'placeholder', idToken: null,
      scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
      tokenType: null, providerAccountId: 'account', providerEmail: null,
      raw: { claudeAiOauth: { organizationUuid: 'org' } } },
  });
  const provider = createClaudeSubscriptionQuotaFetcher({ userAgent: 'claude-cli/2.1.296 (external, cli)' });
  snapshot = await provider.fetch({ record, now: now - 1_000, signal: new AbortController().signal });
  expect(snapshot?.recoveryCredits?.availableCount).toBeGreaterThan(0);
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
    getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: snapshot } })),
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
  } as unknown as QuotaApi;
  const coordinator = new ConnectedServiceQuotasCoordinator({
    api, credentials: { token: 'placeholder', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
    quotaFetchers: [provider], now: () => now, randomBytes,
  });
  return { coordinator, posts, transport, providerCreditId: program === 'cedar' ? 'promo' : 'juniper_tide',
    snapshot: () => snapshot,
    observe: (next: ConnectedServiceQuotaSnapshotV1) => { snapshot = next; now += 1_000; },
  };
}

describe('connected-service recovery operation lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateConnectedServiceAccountMode();
  });

  it.each(['cedar', 'juniper'] as const)('allows a second %s use after a successful refreshed observation', async (program) => {
    const harness = await createRecoveryHarness(program);
    const first = await harness.coordinator.consumeAvailableRecoveryCreditForProfile({ serviceId, profileId,
      automaticResetContext: { groupId: 'pool', providerLimitIds: ['five_hour'] },
    });
    expect(first).toMatchObject({ ok: true, receipt: { providerCreditId: harness.providerCreditId, status: 'consumed' } });
    if (!first.ok || !first.snapshot) throw new Error('expected a refreshed quota snapshot');
    harness.observe(first.snapshot);
    const idempotencyKey = buildRecoveryCreditConsumeIdempotencyKey({ serviceId, profileId,
      providerCreditId: harness.providerCreditId, sourceSnapshotFetchedAtMs: first.snapshot.fetchedAt });
    const second = await harness.coordinator.consumeRecoveryCreditForProfile({
      serviceId, profileId, providerCreditId: harness.providerCreditId, idempotencyKey,
    });
    expect(second).toMatchObject({ ok: true, receipt: { idempotencyKey, status: 'consumed' } });
    expect(second.receipt?.idempotencyKey).not.toBe(first.receipt?.idempotencyKey);
    expect(harness.posts).toHaveLength(2);
    expect(harness.posts.map((post) => post.program)).toEqual([program === 'cedar' ? 'cedar_ember' : 'juniper_tide',
      program === 'cedar' ? 'cedar_ember' : 'juniper_tide']);
    if (program === 'cedar') expect(harness.posts[1].request_id).not.toBe(harness.posts[0].request_id);
    expect(await harness.coordinator.consumeRecoveryCreditForProfile({
      serviceId, profileId, providerCreditId: harness.providerCreditId, idempotencyKey,
    })).toEqual(second);
    expect(harness.posts).toHaveLength(2);
  });

  it.each(['same', 'aggregate', 'distinct'] as const)('preserves selected debit ownership for %s concurrent requests', async (overlap) => {
    let releasePost = () => {};
    const pendingPost = new Promise<void>((resolve) => { releasePost = resolve; });
    const harness = await createRecoveryHarness('cedar', pendingPost);
    const firstRequest = { serviceId, profileId, providerCreditId: 'promo', idempotencyKey: 'manual-original' };
    const firstPending = harness.coordinator.consumeRecoveryCreditForProfile(firstRequest);
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1));
    const secondPending = harness.coordinator.consumeRecoveryCreditForProfile({ serviceId, profileId,
      idempotencyKey: 'competing-new-observation', ...(overlap === 'aggregate' ? {} : { providerCreditId: overlap === 'same' ? 'promo' : 'other' }),
    });
    // Claude's fresh next_grant_id vetoes the other grant. Its own no-effect receipt
    // must settle independently rather than inherit the pending promo debit.
    if (overlap === 'distinct') await expect(secondPending).resolves.toMatchObject({
      receipt: { providerCreditId: 'other', status: 'not_available' },
    });
    releasePost();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first).toMatchObject({ ok: true, receipt: { providerCreditId: 'promo', idempotencyKey: 'manual-original' } });
    if (overlap === 'distinct') {
      expect(second.receipt).toMatchObject({ providerCreditId: 'other', idempotencyKey: 'competing-new-observation' });
    } else expect(second).toEqual(first);
    expect(harness.posts).toHaveLength(1);
  });

  it('leaves an irrelevant automatic credit available to manual redemption and replays a spent targeted action', async () => {
    const harness = await createRecoveryHarness();
    const request = { serviceId, profileId, providerCreditId: 'promo', idempotencyKey: 'targeted-account-action' };
    const automatic = await harness.coordinator.consumeRecoveryCreditForProfile({ ...request,
      automaticResetContext: { groupId: 'pool', providerLimitIds: ['seven_day_sonnet'] },
    });
    expect(automatic).toMatchObject({ ok: true, receipt: { status: 'not_available' } });
    expect(harness.posts).toHaveLength(0);
    const manual = await harness.coordinator.consumeRecoveryCreditForProfile(request);
    expect(manual).toMatchObject({ ok: true, receipt: { status: 'consumed' } });
    expect(harness.posts).toHaveLength(1);
    expect(await harness.coordinator.consumeRecoveryCreditForProfile({ ...request,
      automaticResetContext: { groupId: 'pool', providerLimitIds: ['five_hour'] },
    })).toEqual(manual);
    expect(harness.posts).toHaveLength(1);
  });

  it.each(['manual', 'another automatic target'] as const)('preserves a concurrent %s intent after an irrelevant automatic refusal', async (caller) => {
    const harness = await createRecoveryHarness();
    const originalTransport = harness.transport.getMockImplementation();
    if (!originalTransport) throw new Error('expected the provider HTTP boundary');
    let releasePreflight = () => {};
    let reportPreflight = () => {};
    const preflightPending = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const preflightStarted = new Promise<void>((resolve) => { reportPreflight = resolve; });
    let paused = false;
    harness.transport.mockImplementation(async (url, init) => {
      if (!paused && init?.method !== 'POST' && String(url).includes('?')) {
        paused = true;
        reportPreflight();
        await preflightPending;
      }
      return await originalTransport(url, init);
    });
    const request = { serviceId, profileId, providerCreditId: 'promo', idempotencyKey: 'concurrent-targeted-action' };
    const firstPending = harness.coordinator.consumeRecoveryCreditForProfile({ ...request,
      automaticResetContext: { groupId: 'first-pool', providerLimitIds: ['seven_day_sonnet'] },
    });
    await preflightStarted;
    const secondPending = harness.coordinator.consumeRecoveryCreditForProfile({ ...request,
      ...(caller === 'manual' ? {} : { automaticResetContext: { groupId: 'second-pool', providerLimitIds: ['five_hour'] } }),
    });
    releasePreflight();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first).toMatchObject({ ok: true, receipt: { status: 'not_available' } });
    expect(second).toMatchObject({ ok: true, receipt: { status: 'consumed', providerCreditId: 'promo' } });
    expect(harness.posts).toHaveLength(1);
  });
});
