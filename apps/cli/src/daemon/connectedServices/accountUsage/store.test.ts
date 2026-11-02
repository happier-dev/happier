import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeProviderAccountUsageSnapshotFingerprint } from './fingerprint';

type ProviderAccountUsageStore = Readonly<{
  recordSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    observation?: Readonly<{
      sources?: readonly ConnectedServiceUsageSourceV1[];
    }>,
  ): Readonly<{
    status: 'snapshot_advanced' | 'source_linked' | 'duplicate' | 'older';
    recordId: string;
    snapshotAdvanced: boolean;
    sourceLinked: boolean;
  }>;
  resolveRecordId(recordId: string): ProviderAccountUsageSnapshotV1 | null;
  resolveBySource(source: ConnectedServiceUsageSourceV1): ProviderAccountUsageSnapshotV1 | null;
  listSnapshots(): readonly ProviderAccountUsageSnapshotV1[];
}>;

type StoreModule = Readonly<{
  createProviderAccountUsageStore(): ProviderAccountUsageStore;
  isProviderAccountUsageStoreMutationAccepted(result: Readonly<{
    status: 'snapshot_advanced' | 'source_linked' | 'duplicate' | 'older';
    recordId: string;
    snapshotAdvanced: boolean;
    sourceLinked: boolean;
  }>): boolean;
}>;

async function loadStoreModule(): Promise<StoreModule | null> {
  return await import('./store').catch(() => null) as StoreModule | null;
}

function createKey(accountSubjectId: string): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'claude',
    accountSubjectId,
    subjectKind: accountSubjectId.startsWith('provisional:') ? 'unknown' : 'subscription',
    quotaScope: 'account',
  };
}

function createSnapshot(overrides: Partial<ProviderAccountUsageSnapshotV1> = {}): ProviderAccountUsageSnapshotV1 {
  const recordKey = overrides.recordKey ?? createKey('sub_stable_1');
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: {
      kind: recordKey.accountSubjectId.startsWith('provisional:')
        ? 'provisionalLocalSubject'
        : 'providerSubject',
      id: recordKey.accountSubjectId,
    },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Team',
    accountLabel: 'same visible label',
    meters: [],
    ...overrides,
  };
}

describe('provider account usage store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies a later refresh failure without replacing newer meter observations or accepting an older outcome', async () => {
    const { createProviderAccountUsageStore } = await import('./store');
    const store = createProviderAccountUsageStore();
    const current = createSnapshot({ fetchedAtMs: 2_000, observedAtMs: 2_000, planLabel: 'New usage' });
    store.recordSnapshot(current);
    const failure = createSnapshot({ fetchedAtMs: 1_000, observedAtMs: 3_000, state: 'error_last_known_good',
      diagnostics: [{ kind: 'provider_http', status: 429, observedAtMs: 3_000 }] });
    expect(store.recordSnapshot(failure).snapshotAdvanced).toBe(true);
    expect(store.resolveRecordId(current.recordId)).toMatchObject({ fetchedAtMs: 2_000, observedAtMs: 3_000,
      planLabel: 'New usage', state: 'error_last_known_good', diagnostics: failure.diagnostics });
    store.recordSnapshot({ ...current, observedAtMs: 2_500 });
    expect(store.resolveRecordId(current.recordId)?.state).toBe('error_last_known_good');
    store.recordSnapshot({ ...current, observedAtMs: 4_000 });
    expect(store.resolveRecordId(current.recordId)).toMatchObject({ state: 'loaded_data', observedAtMs: 4_000 });
  });

  it('merges subscription observations independently without re-aging or replacing newer usage', async () => {
    const module = await loadStoreModule();
    const store = module!.createProviderAccountUsageStore();
    const subscription = { status: 'subscribed', renewal: 'on', observedAtMs: 1_000, staleAfterMs: 300_000,
      currentPeriodEndAtMs: 50_000 } as const;
    const initial = createSnapshot({ subscription });
    store.recordSnapshot(initial);
    store.recordSnapshot(createSnapshot({ fetchedAtMs: 3_000, observedAtMs: 3_000, planLabel: 'Latest usage' }));
    expect(store.resolveRecordId(initial.recordId)?.subscription).toEqual(subscription);
    const refreshed = { ...subscription, observedAtMs: 4_000, renewal: 'off' } as const;
    expect(store.recordSnapshot(createSnapshot({ fetchedAtMs: 2_000, observedAtMs: 2_000, subscription: refreshed }))
      .snapshotAdvanced).toBe(true);
    expect(store.resolveRecordId(initial.recordId)).toMatchObject({ fetchedAtMs: 3_000, observedAtMs: 3_000,
      planLabel: 'Latest usage', subscription: refreshed });
    const other = createSnapshot({ recordKey: createKey('another-account'), fetchedAtMs: 5_000 });
    store.recordSnapshot(other);
    expect(store.resolveRecordId(other.recordId)?.subscription).toBeUndefined();
  });

  it('retains last good subscription through failure and clears it only on an explicit newer none observation', async () => {
    const module = await loadStoreModule();
    const store = module!.createProviderAccountUsageStore();
    const initial = createSnapshot({ subscription: { status: 'subscribed', renewal: 'off',
      observedAtMs: 1_000, staleAfterMs: 300_000, currentPeriodEndAtMs: 50_000 } });
    store.recordSnapshot(initial);
    const lastRefreshError = { code: 'network', observedAtMs: 2_000 } as const;
    store.recordSnapshot(createSnapshot({ subscription: { status: 'unavailable', renewal: 'unknown',
      observedAtMs: 2_000, staleAfterMs: 300_000, lastRefreshError } }));
    expect(store.resolveRecordId(initial.recordId)?.subscription).toEqual({ ...initial.subscription, lastRefreshError });
    const none = { status: 'none', renewal: 'unknown', observedAtMs: 3_000, staleAfterMs: 300_000 } as const;
    store.recordSnapshot(createSnapshot({ subscription: none }));
    expect(store.resolveRecordId(initial.recordId)?.subscription).toEqual(none);
  });

  it('publishes subscription freshness and refresh failure changes even when quota content is unchanged', () => {
    const key = new Uint8Array(32);
    const initial = createSnapshot({ subscription: { status: 'subscribed', renewal: 'on',
      observedAtMs: 1_000, staleAfterMs: 300_000, currentPeriodEndAtMs: 50_000 } });
    const fingerprint = computeProviderAccountUsageSnapshotFingerprint(initial, key);
    expect(computeProviderAccountUsageSnapshotFingerprint({ ...initial,
      subscription: { ...initial.subscription!, observedAtMs: 2_000 } }, key)).not.toBe(fingerprint);
    expect(computeProviderAccountUsageSnapshotFingerprint({ ...initial,
      subscription: { ...initial.subscription!, lastRefreshError: { code: 'network', observedAtMs: 2_000 } } }, key))
      .not.toBe(fingerprint);
  });

  it('uses the typed status as the only mutation-acceptance authority', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const recordId = createSnapshot().recordId;
    expect(module!.isProviderAccountUsageStoreMutationAccepted({
      status: 'duplicate',
      recordId,
      snapshotAdvanced: true,
      sourceLinked: true,
    })).toBe(false);
    expect(module!.isProviderAccountUsageStoreMutationAccepted({
      status: 'snapshot_advanced',
      recordId,
      snapshotAdvanced: false,
      sourceLinked: false,
    })).toBe(true);
  });

  it('records one stable provider-subject snapshot and resolves explicit sources without exposing alias lookup', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const stableSnapshot = createSnapshot();
    const firstProvisionalKey = createKey('provisional:native');
    const secondProvisionalKey = createKey('provisional:connected');

    expect(store.recordSnapshot(stableSnapshot, {
      sources: [{
        serviceId: 'anthropic',
        profileId: 'work',
        bindingKind: 'profile',
      }],
    })).toEqual({
      status: 'snapshot_advanced',
      recordId: stableSnapshot.recordId,
      snapshotAdvanced: true,
      sourceLinked: true,
    });
    store.recordSnapshot(createSnapshot({
      recordKey: firstProvisionalKey,
      recordId: buildProviderAccountUsageRecordId(firstProvisionalKey),
      accountSubject: { kind: 'provisionalLocalSubject', id: firstProvisionalKey.accountSubjectId },
      accountLabel: 'same@example.com',
    }));
    store.recordSnapshot(createSnapshot({
      recordKey: secondProvisionalKey,
      recordId: buildProviderAccountUsageRecordId(secondProvisionalKey),
      accountSubject: { kind: 'provisionalLocalSubject', id: secondProvisionalKey.accountSubjectId },
      accountLabel: 'same@example.com',
    }));

    expect('resolveByAlias' in store).toBe(false);
    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'profile',
    })?.recordId).toBe(stableSnapshot.recordId);
    expect(store.listSnapshots().map((snapshot) => snapshot.recordKey.accountSubjectId).sort()).toEqual([
      'provisional:connected',
      'provisional:native',
      'sub_stable_1',
    ]);
  });

  it('uses connected-service group generation when resolving group-member sources for policy', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const snapshot = createSnapshot();
    store.recordSnapshot(snapshot, {
      sources: [{
        serviceId: 'anthropic',
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 7,
      }],
    });

    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    })?.recordId).toBe(snapshot.recordId);
    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 6,
    })).toBeNull();
  });

  it('does not derive source lookup authority without an explicit source link', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const snapshot = createSnapshot();

    store.recordSnapshot(snapshot);

    expect(store.resolveBySource({
      serviceId: 'anthropic',
      profileId: 'alias-only',
      bindingKind: 'profile',
    })).toBeNull();
  });

  it('classifies effective snapshot revisions, new source edges, duplicates, and older delivery', async () => {
    const module = await loadStoreModule();
    expect(module).not.toBeNull();
    const store = module!.createProviderAccountUsageStore();
    const sourceA: ConnectedServiceUsageSourceV1 = {
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const sourceB: ConnectedServiceUsageSourceV1 = {
      serviceId: 'anthropic',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 7,
    };
    const initial = createSnapshot({ fetchedAtMs: 2_000, observedAtMs: 2_000 });

    expect(store.recordSnapshot(initial, { sources: [sourceA] })).toEqual({
      status: 'snapshot_advanced',
      recordId: initial.recordId,
      snapshotAdvanced: true,
      sourceLinked: true,
    });
    expect(store.recordSnapshot(initial, { sources: [sourceA] })).toEqual({
      status: 'duplicate',
      recordId: initial.recordId,
      snapshotAdvanced: false,
      sourceLinked: false,
    });
    expect(store.recordSnapshot(createSnapshot({
      fetchedAtMs: 1_000,
      observedAtMs: 1_000,
      planLabel: 'outdated',
    }))).toEqual({
      status: 'older',
      recordId: initial.recordId,
      snapshotAdvanced: false,
      sourceLinked: false,
    });
    expect(store.recordSnapshot(createSnapshot({
      fetchedAtMs: 1_000,
      observedAtMs: 1_000,
      planLabel: 'outdated',
    }), { sources: [sourceB] })).toEqual({
      status: 'source_linked',
      recordId: initial.recordId,
      snapshotAdvanced: false,
      sourceLinked: true,
    });
    expect(store.resolveBySource(sourceB)).toEqual(initial);

    const correctedAtSameTimestamp = createSnapshot({
      fetchedAtMs: 2_000,
      observedAtMs: 2_000,
      planLabel: 'Enterprise',
    });
    expect(store.recordSnapshot(correctedAtSameTimestamp, { sources: [sourceA, sourceB] })).toEqual({
      status: 'snapshot_advanced',
      recordId: initial.recordId,
      snapshotAdvanced: true,
      sourceLinked: false,
    });
    expect(store.resolveRecordId(initial.recordId)?.planLabel).toBe('Enterprise');
  });

  it('replaces a retained future-dated usage observation with a current observation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const module = await loadStoreModule();
    const store = module!.createProviderAccountUsageStore();
    const future = createSnapshot({ fetchedAtMs: 100_000, observedAtMs: 100_000, planLabel: 'Poisoned' });
    const current = createSnapshot({ fetchedAtMs: 10_000, observedAtMs: 10_000, planLabel: 'Recovered' });

    store.recordSnapshot(future);
    expect(store.recordSnapshot(current).status).toBe('snapshot_advanced');
    expect(store.resolveRecordId(current.recordId)).toMatchObject({
      fetchedAtMs: 10_000,
      planLabel: 'Recovered',
    });
  });

});
