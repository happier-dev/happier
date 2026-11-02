import { randomBytes } from 'node:crypto';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { createOpenAiCodexQuotaFetcher } from '@/backends/codex/connectedServices/quotaFetcher';
import { createProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import { createProviderAccountUsageStore } from '../accountUsage/store';

import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

describe('ConnectedServiceQuotasCoordinator startup current-source refresh scheduling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateConnectedServiceAccountMode();
  });

  it.each([false, true])('retains source repair until credential identity authorizes a link (scheduler=%s)', async (scheduler) => {
    const now = 1_000_000;
    const buildRecord = (providerAccountId: string | null) => buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'cold-profile', kind: 'oauth', expiresAt: now + 3_600_000,
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null,
        providerAccountId, providerEmail: null },
    });
    let record = buildRecord(null);
    type Write = Parameters<NonNullable<QuotaApi['registerProviderAccountUsageSnapshotPlain']>>[0];
    const writes: Write[] = [];
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceQuotaSnapshotPlain: async () => null,
      getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain' as const, v: record } }),
      getConnectedServiceQuotaSnapshotSealed: async () => null,
      getConnectedServiceCredentialSealed: async () => null,
      registerProviderAccountUsageSnapshotPlain: async (write: Write) => { writes.push(write); },
    } satisfies QuotaApi;
    const persistence = scheduler ? createProviderAccountUsagePersistenceScheduler({
      api, now: () => now, fingerprintKey: new Uint8Array(32),
    }) : null;
    const store = createProviderAccountUsageStore();
    const providerHttp = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', providerHttp);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api, credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      quotaFetchers: [createOpenAiCodexQuotaFetcher({ usageUrl: 'https://quota.example/usage', resetCreditsUrl: null })],
      accountUsageStore: store, ...(persistence ? { accountUsagePersistence: persistence } : {}),
      discoveryEnabled: false, now: () => now, randomBytes,
    });
    const source = { serviceId: 'openai-codex', profileId: 'cold-profile', bindingKind: 'profile' } as const;
    try {
      coordinator.scheduleCurrentSourceRefresh([source]);
      await coordinator.tickOnce();
      await persistence?.flush(1_000);
      expect(writes).toHaveLength(1);
      expect(writes[0].source).toBeUndefined();
      expect(store.resolveBySource(source)).toBeNull();
      expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({ accepted: 0, ignored: 1 });

      // An unchanged record-only observation still has not repaired the source.
      await coordinator.tickOnce();
      await persistence?.flush(1_000);
      expect(store.resolveBySource(source)).toBeNull();
      expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({ accepted: 0, ignored: 1 });

      record = buildRecord('acct-cold');
      await coordinator.tickOnce();
      await persistence?.flush(1_000);
      expect(providerHttp).toHaveBeenCalledTimes(3);
      expect(store.resolveBySource(source)).toMatchObject({
        state: 'loaded_empty', recordKey: { subjectKind: 'account', accountSubjectId: 'acct-cold' },
      });
      expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({ source })]));
      expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({ accepted: 1, ignored: 0 });
    } finally { persistence?.dispose(); }
  });

  it.each([
    { scheduler: false, providerStatus: 429, renewDuringWrite: false },
    { scheduler: false, providerStatus: 429, renewDuringWrite: true },
    { scheduler: false, providerStatus: 200, renewDuringWrite: false },
    { scheduler: true, providerStatus: 429, renewDuringWrite: false },
  ])('retains startup-only refresh work until persistence accepts it (scheduler=$scheduler, provider=$providerStatus, renewed=$renewDuringWrite)', async ({ scheduler, providerStatus, renewDuringWrite }) => {
    const now = 1_000_000;
    let serverUnavailable = true;
    const record = buildConnectedServiceCredentialRecord({
      now, serviceId: 'openai-codex', profileId: 'cold-profile', kind: 'oauth', expiresAt: now + 3_600_000,
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null,
        providerAccountId: 'acct-cold', providerEmail: null },
    });
    type Write = Parameters<NonNullable<QuotaApi['registerProviderAccountUsageSnapshotPlain']>>[0];
    const writes: Write[] = [];
    const registerProviderAccountUsageSnapshotPlain = vi.fn(async (write: Write) => {
      if (serverUnavailable) throw new Error('server unavailable');
      writes.push(write);
      if (renewDuringWrite) coordinator.scheduleCurrentSourceRefresh([source]);
    });
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceQuotaSnapshotPlain: async () => null,
      getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain' as const, v: record } }),
      getConnectedServiceQuotaSnapshotSealed: async () => null,
      getConnectedServiceCredentialSealed: async () => null,
      registerProviderAccountUsageSnapshotPlain,
    } satisfies QuotaApi;
    const persistence = scheduler ? createProviderAccountUsagePersistenceScheduler({
      api, now: () => now, fingerprintKey: new Uint8Array(32),
    }) : null;
    const store = createProviderAccountUsageStore();
    const providerHttp = vi.fn(async () => new Response('{}', { status: providerStatus, headers: { 'retry-after': '120' } }));
    vi.stubGlobal('fetch', providerHttp);
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api, credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      quotaFetchers: [createOpenAiCodexQuotaFetcher({ usageUrl: 'https://quota.example/usage', resetCreditsUrl: null })],
      accountUsageStore: store, ...(persistence ? { accountUsagePersistence: persistence } : {}),
      discoveryEnabled: false, now: () => now, randomBytes,
    });
    const source = { serviceId: 'openai-codex', profileId: 'cold-profile', bindingKind: 'profile' } as const;
    try {
      coordinator.scheduleCurrentSourceRefresh([source]);
      await coordinator.tickOnce();
      await vi.waitFor(() => expect(registerProviderAccountUsageSnapshotPlain).toHaveBeenCalled());
      const state = providerStatus === 200 ? 'loaded_empty' : 'error_last_known_good';
      const fetchedAtMs = providerStatus === 200 ? now : 0;
      expect(store.resolveBySource(source)).toMatchObject({ state, fetchedAtMs });
      if (persistence) {
        // Successful intake transfers retries to the scheduler even while HTTP is failing.
        await coordinator.tickOnce();
        expect(providerHttp).toHaveBeenCalledTimes(1);
        serverUnavailable = false;
        await persistence.flush(1_000);
        expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({
          source, content: { t: 'plain', v: expect.objectContaining({ state, fetchedAtMs }) },
        })]));
        expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({ accepted: 1, ignored: 0 });
        return;
      }
      // Renew the request while its previous outcome is still unavailable on the server.
      expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({ accepted: 0, ignored: 1 });
      await coordinator.tickOnce();
      serverUnavailable = false;
      // The same clock/data now produce a duplicate local-store mutation; persistence still needs retrying.
      await coordinator.tickOnce();
      expect(writes).toEqual(expect.arrayContaining([expect.objectContaining({
        source, content: { t: 'plain', v: expect.objectContaining({ state, fetchedAtMs }) },
      })]));
      expect(providerHttp).toHaveBeenCalledTimes(providerStatus === 200 ? 3 : 1);
      expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual(renewDuringWrite
        ? { accepted: 0, ignored: 1 } : { accepted: 1, ignored: 0 });
    } finally { persistence?.dispose(); }
  });

  it('deduplicates and bounds startup refresh work inside the quota coordinator', () => {
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {} as QuotaApi,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [{
        serviceId: 'openai-codex',
        fetch: vi.fn(async () => null),
      }],
      now: () => 1,
      randomBytes,
      discoveryEnabled: false,
    });
    const sources = Array.from({ length: 300 }, (_, index) => ({
      serviceId: 'openai-codex' as const,
      profileId: `profile-${index}`,
      bindingKind: 'profile' as const,
    }));

    expect(coordinator.scheduleCurrentSourceRefresh([
      sources[0]!,
      ...sources,
      sources[1]!,
    ])).toEqual({
      accepted: 256,
      ignored: 46,
    });
  });

  it('polls a scheduled missing source without requiring a tracked runtime or discovery', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-cold',
        providerEmail: 'cold@example.test',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'cold-profile', status: 'connected' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'cold-profile',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'cold@example.test',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const source = {
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      bindingKind: 'profile',
    } satisfies ConnectedServiceUsageSourceV1;

    expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({
      accepted: 1,
      ignored: 0,
    });
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
    expect(coordinator.scheduleCurrentSourceRefresh([source])).toEqual({
      accepted: 1,
      ignored: 0,
    });
  });

  it('forces scheduled account-usage source repair even when the separate quota snapshot is fresh', async () => {
    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-cold',
        providerEmail: 'cold@example.test',
      },
    });
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      fetchedAt: now - 1_000,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'cold@example.test',
      meters: [],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      listConnectedServiceProfiles: vi.fn(async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'cold-profile', status: 'connected' as const }],
      })),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: freshSnapshot },
        metadata: {
          fetchedAt: freshSnapshot.fetchedAt,
          staleAfterMs: freshSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: record },
      })),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      fetch: vi.fn(async () => ({
        ...freshSnapshot,
        fetchedAt: now,
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const source = {
      serviceId: 'openai-codex',
      profileId: 'cold-profile',
      bindingKind: 'profile',
    } satisfies ConnectedServiceUsageSourceV1;

    coordinator.scheduleCurrentSourceRefresh([source]);
    await coordinator.tickOnce();

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
  });
});
