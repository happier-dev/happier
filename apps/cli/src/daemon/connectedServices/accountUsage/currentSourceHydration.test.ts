import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceAuthGroupV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from './currentSourceHydration';
import { createProviderAccountUsageStore } from './store';

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function createUsageSnapshot(accountSubjectId = 'acct-work'): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: accountSubjectId },
    observedAtMs: 1_700_000_000_000,
    fetchedAtMs: 1_700_000_000_000,
    staleAfterMs: 60_000,
    source: 'connectedServiceProbe',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'work@example.com',
    meters: [],
  });
}

function createGroup(): ConnectedServiceAuthGroupV1 {
  return ConnectedServiceAuthGroupV1Schema.parse({
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    policy: { v: 1, autoSwitch: true },
    activeProfileId: 'work',
    generation: 4,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'work',
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      },
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'disabled',
        priority: 2,
        enabled: false,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
}

describe('hydrateProviderAccountUsageStoreFromConnectedServiceInventory', () => {
  it.each([
    ['org-work', true],
    ['org-other', false],
    [null, false],
  ] as const)('adopts scoped Claude quota only when the current credential proves the same organization (%s)', async (currentOrganizationId, expectedHydrated) => {
    const recordKey = {
      providerId: 'claude', accountSubjectId: 'acct-work', subjectKind: 'account' as const,
      quotaScope: 'organization' as const, quotaScopeId: 'org-work',
    };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      ...createUsageSnapshot(), recordKey, recordId: buildProviderAccountUsageRecordId(recordKey), providerId: 'claude',
    });
    const source = { serviceId: 'claude-subscription', profileId: 'work', bindingKind: 'profile' } as const;
    const store = createProviderAccountUsageStore();
    const result = await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['claude-subscription'],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'claude-subscription', profiles: [{ profileId: 'work' }] }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => ({
          source, recordId: snapshot.recordId, providerAccountId: 'acct-work',
          fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
        }),
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({ content: { t: 'plain', v: snapshot }, sources: [source] }),
      },
      resolveCurrentProviderAccountIdentityForSource: async () => currentOrganizationId
        ? { providerAccountId: 'acct-work', providerOrganizationId: currentOrganizationId } : null,
      credentials: createCredentials(), store, nowMs: snapshot.fetchedAtMs + 1,
    });
    expect(result.hydration.refreshSources).toEqual(expectedHydrated ? [] : [source]);
    expect(store.listSnapshots()).toEqual(expectedHydrated ? [snapshot] : []);
  });

  it('preserves the API receiver while resolving the current source inventory', async () => {
    const store = createProviderAccountUsageStore();
    const receiverToken = Symbol('receiver-token');
    const api = {
      receiverToken,
      async listConnectedServiceProfiles() {
        return {
          serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'work' }],
        };
      },
      async listConnectedServiceAuthGroups() {
        return [];
      },
      async resolveProviderAccountUsageSource({ source }: { source: ConnectedServiceUsageSourceV1 }) {
        if (this.receiverToken !== receiverToken) {
          throw new Error('API receiver was not preserved');
        }
        return {
          source,
          recordId: buildProviderAccountUsageRecordId({
            providerId: 'codex',
            accountSubjectId: 'acct-work',
            subjectKind: 'account',
            quotaScope: 'account',
          }),
          providerAccountId: 'acct-work',
          fetchedAt: null,
          staleAfterMs: null,
        };
      },
    };

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api,
      credentials: createCredentials(),
      store,
      nowMs: 1,
    })).resolves.toMatchObject({
      sources: [{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }],
    });
  });

  it('enumerates every connected profile and enabled current-generation group member before hydrating', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [
        { profileId: 'work', status: 'connected' as const },
        { profileId: 'needs-reauth', status: 'needs_reauth' as const },
      ],
    }));
    const listConnectedServiceAuthGroups = vi.fn(async () => [createGroup(), createGroup()]);
    const resolveProviderAccountUsageSource = vi.fn(async ({ source }: { source: ConnectedServiceUsageSourceV1 }) => ({
      source,
      recordId: snapshot.recordId,
      providerAccountId: 'acct-work',
      fetchedAt: snapshot.fetchedAtMs,
      staleAfterMs: snapshot.staleAfterMs,
    }));
    const returnedSources: ConnectedServiceUsageSourceV1[] = [
      { serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' },
      { serviceId: 'openai-codex', profileId: 'needs-reauth', bindingKind: 'profile' },
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    ];
    const getProviderAccountUsageSnapshotPlain = vi.fn(async () => ({
      content: { t: 'plain' as const, v: snapshot },
      sources: returnedSources,
    }));

    const result = await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex', 'openai-codex'],
      api: {
        listConnectedServiceProfiles,
        listConnectedServiceAuthGroups,
        resolveProviderAccountUsageSource,
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain,
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(listConnectedServiceProfiles).toHaveBeenCalledTimes(2);
    expect(listConnectedServiceProfiles).toHaveBeenNthCalledWith(1, {
      serviceId: 'openai-codex',
      forceRefresh: true,
    });
    expect(listConnectedServiceProfiles).toHaveBeenNthCalledWith(2, {
      serviceId: 'openai-codex',
      forceRefresh: true,
    });
    expect(listConnectedServiceAuthGroups).toHaveBeenCalledTimes(2);
    expect(resolveProviderAccountUsageSource.mock.calls.slice(0, 3).map(([call]) => call.source)).toEqual([
      { serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' },
      { serviceId: 'openai-codex', profileId: 'needs-reauth', bindingKind: 'profile' },
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    ]);
    expect(resolveProviderAccountUsageSource).toHaveBeenCalledTimes(6);
    expect(getProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(3);
    expect(result.hydration.refreshSources).toEqual([]);
    expect(store.listSnapshots()).toHaveLength(1);
  });

  it('fails the barrier without hydrating when authoritative inventory enumeration fails', async () => {
    const store = createProviderAccountUsageStore();
    const resolveProviderAccountUsageSource = vi.fn();

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => {
          throw new Error('settings unavailable');
        },
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource,
      },
      credentials: createCredentials(),
      store,
      nowMs: 1,
    })).rejects.toThrow('settings unavailable');

    expect(resolveProviderAccountUsageSource).not.toHaveBeenCalled();
    expect(store.listSnapshots()).toEqual([]);
  });

  it('resolves the complete source inventory before mutating the store and fails closed on transport errors', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const getProviderAccountUsageSnapshotPlain = vi.fn(async () => null);
    let resolutions = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work' }, { profileId: 'backup' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => {
          resolutions += 1;
          if (source.profileId === 'backup') throw new Error('source resolver unavailable');
          return {
            source,
            recordId: snapshot.recordId,
            providerAccountId: 'acct-work',
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
          };
        },
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain,
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    })).rejects.toThrow('source resolver unavailable');

    expect(resolutions).toBe(2);
    expect(getProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
    expect(store.listSnapshots()).toEqual([]);
  });

  it('rejects the barrier when source ownership changes while its snapshot is being hydrated', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    let resolutions = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => {
          resolutions += 1;
          return resolutions === 1
            ? {
                source,
                recordId: snapshot.recordId,
                providerAccountId: 'acct-work',
                fetchedAt: snapshot.fetchedAtMs,
                staleAfterMs: snapshot.staleAfterMs,
              }
            : null;
        },
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({
          content: { t: 'plain', v: snapshot },
          sources: [source],
        }),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    })).rejects.toThrow('changed during hydration');

    expect(resolutions).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('rejects without committing when the authoritative source inventory gains a profile before activation', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    let profileReads = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: profileReads++ === 0
            ? [{ profileId: 'work' }]
            : [{ profileId: 'work' }, { profileId: 'backup' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => ({
          source,
          recordId: snapshot.recordId,
          providerAccountId: 'acct-work',
          fetchedAt: snapshot.fetchedAtMs,
          staleAfterMs: snapshot.staleAfterMs,
        }),
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({
          content: { t: 'plain', v: snapshot },
          sources: [{ serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' }],
        }),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    })).rejects.toThrow('inventory changed during hydration');

    expect(profileReads).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('rejects without committing when the authoritative source inventory loses a profile before activation', async () => {
    const store = createProviderAccountUsageStore();
    let profileReads = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: profileReads++ === 0 ? [{ profileId: 'work' }] : [],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
      },
      credentials: createCredentials(),
      store,
      nowMs: 1,
    })).rejects.toThrow('inventory changed during hydration');

    expect(profileReads).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it.each([
    { label: 'member enablement', firstGeneration: 4, firstEnabled: false, secondGeneration: 4, secondEnabled: true },
    { label: 'group generation', firstGeneration: 4, firstEnabled: true, secondGeneration: 5, secondEnabled: true },
  ])('rejects without committing when $label changes before activation', async (scenario) => {
    const store = createProviderAccountUsageStore();
    let groupReads = 0;
    const buildGroup = (generation: number, enabled: boolean): ConnectedServiceAuthGroupV1 => {
      const group = createGroup();
      return ConnectedServiceAuthGroupV1Schema.parse({
        ...group,
        generation,
        members: group.members.map((member) => ({
          ...member,
          enabled: member.profileId === 'work' ? enabled : false,
        })),
      });
    };

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({ serviceId: 'openai-codex', profiles: [] }),
        listConnectedServiceAuthGroups: async () => groupReads++ === 0
          ? [buildGroup(scenario.firstGeneration, scenario.firstEnabled)]
          : [buildGroup(scenario.secondGeneration, scenario.secondEnabled)],
        resolveProviderAccountUsageSource: async () => null,
      },
      credentials: createCredentials(),
      store,
      nowMs: 1,
    })).rejects.toThrow('inventory changed during hydration');

    expect(groupReads).toBe(2);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('does not reject stable source ownership when only quota observation clocks advance', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const source: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    let resolutions = 0;

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => {
          const revision = resolutions++;
          return {
            source,
            recordId: snapshot.recordId,
            providerAccountId: 'acct-work',
            fetchedAt: snapshot.fetchedAtMs + revision * 1_000,
            staleAfterMs: snapshot.staleAfterMs + revision * 1_000,
          };
        },
        getAccountEncryptionMode: async () => 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({
          content: { t: 'plain', v: snapshot },
          sources: [source],
        }),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    })).resolves.toMatchObject({ sources: [source] });

    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });

  it('samples account encryption mode once for a multi-record hydration barrier', async () => {
    const workSnapshot = createUsageSnapshot('acct-work');
    const backupSnapshot = createUsageSnapshot('acct-backup');
    const store = createProviderAccountUsageStore();
    const getAccountEncryptionMode = vi.fn(async () => 'plain' as const);
    const sources = [
      { serviceId: 'openai-codex', profileId: 'work', bindingKind: 'profile' as const },
      { serviceId: 'openai-codex', profileId: 'backup', bindingKind: 'profile' as const },
    ] satisfies readonly ConnectedServiceUsageSourceV1[];

    await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work' }, { profileId: 'backup' }],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => {
          const snapshot = source.profileId === 'work' ? workSnapshot : backupSnapshot;
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
          const index = recordId === workSnapshot.recordId ? 0 : 1;
          const snapshot = index === 0 ? workSnapshot : backupSnapshot;
          return { content: { t: 'plain', v: snapshot }, sources: [sources[index]!] };
        },
      },
      credentials: createCredentials(),
      store,
      nowMs: workSnapshot.fetchedAtMs + 1,
    });

    expect(getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(store.listSnapshots()).toHaveLength(2);
  });

  it('bounds source resolution concurrency while preserving deterministic inventory order', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    let active = 0;
    let maxActive = 0;
    const profileIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];

    const result = await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: profileIds.map((profileId) => ({ profileId })),
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return null;
        },
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs,
    });

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(result.sources.map((source) => source.profileId)).toEqual(profileIds);
    expect(result.hydration.refreshSources.map((source) => source.profileId)).toEqual(profileIds);
  });

  it('stops scheduling after a source-resolution failure and awaits already-started workers', async () => {
    const store = createProviderAccountUsageStore();
    const started: string[] = [];
    const settled: string[] = [];
    const profileIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];

    await expect(hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
      serviceIds: ['openai-codex'],
      api: {
        listConnectedServiceProfiles: async () => ({
          serviceId: 'openai-codex',
          profiles: profileIds.map((profileId) => ({ profileId })),
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async ({ source }) => {
          started.push(source.profileId);
          if (source.profileId === 'p0') {
            await new Promise((resolve) => setTimeout(resolve, 1));
            settled.push(source.profileId);
            throw new Error('resolver failed');
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          settled.push(source.profileId);
          return null;
        },
      },
      credentials: createCredentials(),
      store,
      nowMs: 1,
    })).rejects.toThrow('resolver failed');

    expect(started).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(settled).toEqual(expect.arrayContaining(started));
    expect(settled).toHaveLength(started.length);
    expect(store.listSnapshots()).toEqual([]);
  });
});
