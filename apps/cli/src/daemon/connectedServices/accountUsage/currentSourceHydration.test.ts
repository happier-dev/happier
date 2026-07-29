import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  type ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol';

import { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from './currentSourceHydration';
import { createProviderAccountUsageStore } from './store';

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
};

describe('hydrateProviderAccountUsageStoreFromConnectedServiceInventory', () => {
  it('preserves the ApiClient receiver for both exact source-resolution passes', async () => {
    const receiver = Symbol('receiver');
    let resolutions = 0;
    const api = {
      receiver,
      async listConnectedServiceProfiles() {
        return { serviceId: 'openai-codex' as const, profiles: [{ profileId: 'work' }] };
      },
      async listConnectedServiceAuthGroups() {
        return [];
      },
      async resolveProviderAccountUsageSource({ source }: { source: ConnectedServiceUsageSourceV1 }) {
        if (this.receiver !== receiver) throw new Error('receiver lost');
        resolutions += 1;
        return null;
      },
    };

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api,
      credentials,
      store: createProviderAccountUsageStore(),
      nowMs: 1,
    })).resolves.toMatchObject({
      sources: [{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }],
    });
    expect(resolutions).toBe(2);
  });

  it('does not mutate the live store when exact inventory enumeration fails', async () => {
    const store = createProviderAccountUsageStore();
    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => {
          throw new Error('inventory unavailable');
        },
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
      },
      credentials,
      store,
      nowMs: 1,
    })).rejects.toThrow('inventory unavailable');
    expect(store.listSnapshots()).toEqual([]);
  });

  it('does not commit when the authoritative profile inventory changes during hydration', async () => {
    const store = createProviderAccountUsageStore();
    let inventoryReads = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: inventoryReads++ === 0
            ? [{ profileId: 'work' }]
            : [{ profileId: 'work' }, { profileId: 'backup' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
      },
      credentials,
      store,
      nowMs: 1,
    })).rejects.toThrow('inventory changed during hydration');

    expect(inventoryReads).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('does not commit when exact source ownership changes during hydration', async () => {
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const recordKey = {
      providerId: 'codex',
      accountSubjectId: 'acct-work',
      subjectKind: 'account' as const,
      quotaScope: 'account' as const,
    };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: 'acct-work' },
      observedAtMs: 1,
      fetchedAtMs: 1,
      staleAfterMs: 60_000,
      source: 'connectedServiceProbe',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: null,
      accountLabel: null,
      meters: [],
    });
    const store = createProviderAccountUsageStore();
    let resolutionReads = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => resolutionReads++ === 0
          ? {
              source,
              recordId: snapshot.recordId,
              providerAccountId: 'acct-work',
              fetchedAt: snapshot.fetchedAtMs,
              staleAfterMs: snapshot.staleAfterMs,
            }
          : null,
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({
          content: { t: 'plain', v: snapshot },
          sources: [source],
        }),
      },
      credentials,
      store,
      nowMs: 2,
    })).rejects.toThrow('source changed during hydration');

    expect(resolutionReads).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('samples account encryption mode once for the authoritative hydration barrier', async () => {
    const snapshots = ['work', 'backup'].map((profileId) => {
      const recordKey = {
        providerId: 'codex',
        accountSubjectId: `acct-${profileId}`,
        subjectKind: 'account' as const,
        quotaScope: 'account' as const,
      };
      return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
        observedAtMs: 1,
        fetchedAtMs: 1,
        staleAfterMs: 60_000,
        source: 'connectedServiceProbe',
        confidence: 'confirmed',
        state: 'loaded_data',
        planLabel: null,
        accountLabel: null,
        meters: [],
      });
    });
    const sources = ['work', 'backup'].map((profileId) => ({
      serviceId: 'openai-codex' as const,
      profileId,
      bindingKind: 'profile' as const,
    }));
    const getAccountEncryptionMode = vi.fn(async () => 'plain' as const);
    const store = createProviderAccountUsageStore();

    await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: sources.map(({ profileId }) => ({ profileId })),
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => {
          const index = source.profileId === 'work' ? 0 : 1;
          const snapshot = snapshots[index]!;
          return {
            source,
            recordId: snapshot.recordId,
            providerAccountId: snapshot.recordKey.accountSubjectId,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
          };
        },
        getAccountEncryptionMode,
        getProviderAccountUsageSnapshotPlain: async ({ recordId }) => {
          const index = recordId === snapshots[0]!.recordId ? 0 : 1;
          return { content: { t: 'plain', v: snapshots[index]! }, sources: [sources[index]!] };
        },
      },
      credentials,
      store,
      nowMs: 2,
    });

    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(store.listSnapshots()).toHaveLength(2);
  });

  it('bounds exact source resolution concurrency while preserving inventory order', async () => {
    const store = createProviderAccountUsageStore();
    const profileIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
    let active = 0;
    let maxActive = 0;

    const result = await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: profileIds.map((profileId) => ({ profileId })),
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return null;
        },
      },
      credentials,
      store,
      nowMs: 1,
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.sources.map((source) => source.profileId)).toEqual(profileIds);
    expect(result.hydration.refreshSources.map((source) => source.profileId)).toEqual(profileIds);
  });
});
