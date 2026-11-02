import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, getProviderAccountUsageRefreshErrorAt,
  isProviderAccountUsageRefreshRequestSettled } from '@happier-dev/protocol';
import { createOpenAiCodexSubscriptionFetcher } from '@/backends/codex/connectedServices/subscriptionFetcher';
import { createOpenAiCodexQuotaFetcher } from '@/backends/codex/connectedServices/quotaFetcher';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../accountUsage/fromConnectedServiceQuotaObservation';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

function setup(options: { quota?: boolean; enabled?: boolean } = {}) {
  let now = 1_000_000;
  const record = buildConnectedServiceCredentialRecord({ now, serviceId: 'openai-codex', profileId: 'work',
    kind: 'oauth', expiresAt: now + 3_600_000, oauth: { accessToken: 'test-token', refreshToken: 'test-refresh',
      idToken: null, tokenType: null, scope: null, providerAccountId: 'account', providerEmail: null } });
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
    getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
  };
  const store = createProviderAccountUsageStore();
  const coordinator = new ConnectedServiceQuotasCoordinator({
    // The HTTP client is the system boundary; unused API operations are absent.
    api: api as unknown as QuotaApi,
    credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    quotaFetchers: options.quota ? [createOpenAiCodexQuotaFetcher({ usageUrl: 'https://quota.example/usage', resetCreditsUrl: null })] : [],
    subscriptionFetchers: [createOpenAiCodexSubscriptionFetcher({ staleAfterMs: 100 })],
    subscriptionEnabled: options.enabled ?? true,
    accountUsageStore: store, now: () => now, randomBytes: (length) => new Uint8Array(length),
    failureBackoffMinMs: 10_000, failureBackoffJitterPct: 0,
  });
  coordinator.registerSpawnTarget({ pid: 123, connectedServicesBindingsRaw: {
    v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
  } });
  return { coordinator, store, api, advance: (amount: number) => { now += amount; } };
}

describe('subscription observations in the account polling coordinator', () => {
  afterEach(() => { vi.unstubAllGlobals(); invalidateConnectedServiceAccountMode(); });

  it('supports subscription-only readers, isolates their clock, and fails closed when disabled', async () => {
    const fetchMock = vi.fn(async () => Response.json({ active_until: '2026-10-01T00:00:00Z', will_renew: false }));
    vi.stubGlobal('fetch', fetchMock);
    const fixture = setup();
    await fixture.coordinator.tickOnce();
    expect(fixture.store.listSnapshots()[0]).toMatchObject({ meters: [], subscription: { status: 'subscribed', renewal: 'off' } });
    expect(fixture.api.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    const initial = fixture.store.listSnapshots()[0]!;
    fixture.advance(300_001);
    await fixture.coordinator.tickOnce();
    expect(fixture.store.listSnapshots()[0]).toMatchObject({ fetchedAtMs: initial.fetchedAtMs,
      subscription: { observedAtMs: 1_300_001 } });
    const disabled = setup({ enabled: false });
    await disabled.coordinator.tickOnce();
    expect(disabled.store.listSnapshots()).toEqual([]);
  });

  it('keeps successful quota data when billing fails and uses independent backoff', async () => {
    const subscriptionRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://quota.example')) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
      subscriptionRequests.push(String(input));
      return new Response('billing forbidden', { status: 401 });
    }));
    const fixture = setup({ quota: true });
    await fixture.coordinator.tickOnce();
    expect(fixture.store.listSnapshots()[0]).toMatchObject({ meters: expect.arrayContaining([expect.objectContaining({ utilizationPct: 10 })]),
      subscription: { status: 'unavailable', lastRefreshError: { code: 'auth_failure', status: 401 } } });
    expect(fixture.api.getConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    fixture.advance(1_000);
    await fixture.coordinator.tickOnce();
    expect(subscriptionRequests).toHaveLength(1);
  });

  it('updates subscriptions without clearing a quota failure or settling a newer quota refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ active_until: '2026-10-01T00:00:00Z', will_renew: false })));
    const fixture = setup();
    const refreshError = { kind: 'provider_http', status: 429, observedAtMs: 950_000 } as const;
    const previous = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({
      snapshot: { v: 1, serviceId: 'openai-codex', profileId: 'work', activeAccountId: 'account',
        fetchedAt: 900_000, staleAfterMs: 300_000, source: 'provider_api', confidence: 'exact',
        planLabel: null, accountLabel: null, meters: [{ meterId: 'weekly', label: 'Weekly',
          used: null, limit: null, unit: 'unknown', utilizationPct: 10, remainingPct: 90,
          resetsAt: null, status: 'ok', details: {} }] },
      observedAtMs: refreshError.observedAtMs,
      refreshError,
    });
    fixture.store.recordSnapshot(previous, { sources: [{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }] });

    await fixture.coordinator.tickOnce();

    const updated = fixture.store.listSnapshots()[0]!;
    expect(updated).toMatchObject({ state: 'error_last_known_good', observedAtMs: 950_000,
      fetchedAtMs: 900_000, diagnostics: [refreshError], meters: previous.meters,
      subscription: { status: 'subscribed', renewal: 'off', observedAtMs: 1_000_000 } });
    const outcome = { fetchedAt: updated.fetchedAtMs, refreshErrorAt: getProviderAccountUsageRefreshErrorAt(updated) };
    expect(isProviderAccountUsageRefreshRequestSettled({ ...outcome, refreshRequestedAt: 950_000 })).toBe(true);
    expect(isProviderAccountUsageRefreshRequestSettled({ ...outcome, refreshRequestedAt: 975_000 })).toBe(false);
  });
});
