import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

function setup(options: Readonly<{ poolMember: boolean; failing?: boolean; accountStatusByAgentId?: Record<string, boolean> }>) {
  let now = 1_000_000;
  const record = buildConnectedServiceCredentialRecord({ now, serviceId: 'antigravity', profileId: 'work',
    kind: 'oauth', expiresAt: now + 3_600_000, oauth: { accessToken: 'test-token', refreshToken: 'test-refresh',
      idToken: null, tokenType: null, scope: null, providerAccountId: 'account', providerEmail: null } });
  const groups = options.poolMember
    ? [{ groupId: 'pool', members: [{ profileId: 'work', enabled: true }] } as unknown as ConnectedServiceAuthGroupV1]
    : [];
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
    getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
    getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    listConnectedServiceProfiles: vi.fn(async () => ({ serviceId: 'antigravity' as const,
      profiles: [{ profileId: 'work', status: 'connected' as const }] })),
    listConnectedServiceAuthGroups: vi.fn(async () => groups),
  };
  // The provider read (agy `/usage`) is the system boundary.
  const fetch = vi.fn<ConnectedServiceQuotaFetcher['fetch']>(async ({ now: fetchedAt }) => {
    if (options.failing) throw new ConnectedServiceQuotaFetchError('antigravity_usage_unavailable', { quotaFetchErrorCode: 'provider_backoff' });
    return { v: 1, serviceId: 'antigravity', profileId: 'work', fetchedAt, staleAfterMs: 1_800_000,
      planLabel: null, accountLabel: null, meters: [] };
  });
  const coordinator = new ConnectedServiceQuotasCoordinator({
    api: api as unknown as QuotaApi,
    credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    quotaFetchers: [{ serviceId: 'antigravity', fetch }],
    accountUsageStore: createProviderAccountUsageStore(), now: () => now, randomBytes: (length) => new Uint8Array(length),
    failureBackoffMinMs: 10_000, failureBackoffMaxMs: 40_000, failureBackoffJitterPct: 0,
    discoveryEnabled: true, discoveryIntervalMs: 60_000,
    readAccountStatusByAgentId: () => options.accountStatusByAgentId ?? {},
  });
  return { coordinator, api, fetch, advance: (amount: number) => { now += amount; } };
}

describe('account-read consent in the quota coordinator', () => {
  afterEach(() => { invalidateConnectedServiceAccountMode(); });

  it('makes no provider-account read for an account outside every pool, discovered or in use', async () => {
    const fixture = setup({ poolMember: false });
    fixture.coordinator.registerSpawnTarget({ pid: 123, connectedServicesBindingsRaw: {
      v: 1, bindingsByServiceId: { antigravity: { source: 'connected', profileId: 'work' } },
    } });
    await fixture.coordinator.tickOnce();
    fixture.advance(3_600_000);
    await fixture.coordinator.tickOnce();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('reads usage for an account outside pools when its agent\'s account-status setting is on', async () => {
    const fixture = setup({ poolMember: false, accountStatusByAgentId: { agy: true } });
    await fixture.coordinator.tickOnce();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads usage for a pool member with the setting off', async () => {
    const fixture = setup({ poolMember: true });
    await fixture.coordinator.tickOnce();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops polling after repeated failures until the account is used again', async () => {
    const fixture = setup({ poolMember: true, failing: true });
    // Backoff 10s, 20s, then the 40s cap: the account stops being polled.
    for (const wait of [0, 10_001, 20_001]) {
      fixture.advance(wait);
      await fixture.coordinator.tickOnce();
    }
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    fixture.advance(3_600_000);
    await fixture.coordinator.tickOnce();
    expect(fixture.fetch).toHaveBeenCalledTimes(3);

    fixture.coordinator.registerSpawnTarget({ pid: 456, connectedServicesBindingsRaw: {
      v: 1, bindingsByServiceId: { antigravity: { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'work' } },
    } });
    await fixture.coordinator.tickOnce();
    expect(fixture.fetch).toHaveBeenCalledTimes(4);
  });
});
