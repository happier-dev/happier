import {
  buildProviderAccountUsageRecordId,
  sealProviderAccountUsageSnapshot,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  readQualifiedProviderAccountUsageRecordV4,
  resolveQualifiedProviderAccountUsageSourceV4,
} from '@/api/client/qualifiedConnectedAccountApi';

import {
  hydrateProviderAccountUsageStoreFromCurrentSources,
  type ProviderAccountUsageHydrationSource,
} from './hydration';
import { createProviderAccountUsageStore } from './store';

const qualifiedService: QualifiedConnectedAccountServiceRef = {
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
};

const localGroupSource: ConnectedServiceUsageSourceV1 = {
  serviceId: 'happier.agent.codex/openai-codex',
  profileId: 'work',
  bindingKind: 'group_member',
  groupId: 'team',
  groupGeneration: 4,
};

const qualifiedGroupSource: QualifiedConnectedServiceUsageSourceV4 = {
  ref: {
    service: qualifiedService,
    accountId: 'work',
  },
  bindingKind: 'group_member',
  groupId: 'team',
  groupGeneration: 4,
};

function createSnapshot(): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: 'acct-work',
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'acct-work' },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 60_000,
    source: 'connectedServiceProbe',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: null,
    accountLabel: null,
    meters: [],
  };
}

function v4HydrationSource(): ProviderAccountUsageHydrationSource {
  return {
    localSource: localGroupSource,
    qualifiedSource: qualifiedGroupSource,
  };
}

describe('hydrateProviderAccountUsageStoreFromCurrentSources', () => {
  it('withdraws an actually refused exact source while preserving accepted siblings and recovers on the next read', async () => {
    const snapshot = createSnapshot();
    const store = createProviderAccountUsageStore();
    const siblingSource: ConnectedServiceUsageSourceV1 = { ...localGroupSource, groupId: 'accepted-team' };
    let refused = false;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).includes('/sources/resolve?')) return refused
        ? { status: 409, data: { error: 'ownership_unproven' } }
        : { status: 200, data: { source: qualifiedGroupSource, recordId: snapshot.recordId,
          providerAccountId: 'acct-work', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs } };
      return { status: 200, data: { content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' }, sources: [qualifiedGroupSource] } };
    });
    const hydrate = () => hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveRecordIdForSource: source => resolveQualifiedProviderAccountUsageSourceV4({ token: 'token', source }),
      api: { getAccountEncryptionMode: async () => 'plain',
        readProviderAccountUsageRecord: ({ recordId }) => readQualifiedProviderAccountUsageRecordV4({ token: 'token', recordId }) },
      credentials: { token: 'token', encryption: null }, store, nowMs: snapshot.fetchedAtMs + 1,
    });
    try {
      expect((await hydrate()).dispositions[0]?.status).toBe('hydrated_fresh');
      store.recordSnapshot(snapshot, { sources: [siblingSource] });
      refused = true;
      await expect(resolveQualifiedProviderAccountUsageSourceV4({ token: 'token', source: qualifiedGroupSource }))
        .rejects.toMatchObject({ code: 'ownership_unproven', status: 409 });
      expect((await hydrate()).dispositions).toEqual([{ source: localGroupSource, status: 'ownership_unproven' }]);
      expect(store.resolveBySource(localGroupSource)).toBeNull();
      expect(store.resolveBySource(siblingSource)?.recordId).toBe(snapshot.recordId);
      expect(store.resolveRecordId(snapshot.recordId)?.recordId).toBe(snapshot.recordId);
      refused = false;
      expect((await hydrate()).dispositions[0]?.status).toBe('hydrated_fresh');
      expect(store.resolveBySource(localGroupSource)?.recordId).toBe(snapshot.recordId);
    } finally {
      get.mockRestore();
    }
  });

  it.each([
    ['plain', undefined, 'org-current', false, undefined, undefined],
    ['e2ee', undefined, 'org-current', false, undefined, undefined],
    ['plain', 'org-old', 'org-current', false, undefined, undefined],
    ['plain', 'org-current', null, false, undefined, undefined],
    ['plain', 'org-current', 'org-current', true, undefined, undefined],
    ['plain', 'org-current', 'org-current', true, 'semantic-provider', 'semantic-provider'],
    ['plain', 'org-current', 'org-current', false, 'semantic-provider', 'happier.agent.codex/openai-codex'],
  ] as const)('admits %s scoped usage only with declared current organization proof (%s, %s)', async (mode, observedOrganization, currentOrganization, expectedHydrated, declaredProvider, observedProvider) => {
    const base = createSnapshot();
    const recordKey = { ...base.recordKey, ...(observedProvider ? { providerId: observedProvider } : {}),
      ...(observedOrganization ? { quotaScope: 'organization' as const, quotaScopeId: observedOrganization } : {}),
    };
    const snapshot = { ...base, providerId: recordKey.providerId, recordKey, recordId: buildProviderAccountUsageRecordId(recordKey) };
    const secret = new Uint8Array(32).fill(9);
    const sealed = sealProviderAccountUsageSnapshot({ snapshot, material: { type: 'legacy', secret },
      randomBytes: (length) => new Uint8Array(length).fill(7) });
    const store = createProviderAccountUsageStore();
    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveUsageIdentity: async () => ({ requiredContext: 'organization', ...(declaredProvider ? { providerId: declaredProvider } : {}) }),
      resolveCurrentProviderAccountIdentityForSource: async () => currentOrganization ? {
        providerAccountId: 'acct-work', providerOrganizationId: currentOrganization,
      } : null,
      resolveRecordIdForSource: async (source) => ({ source, recordId: snapshot.recordId,
        providerAccountId: 'acct-work', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs }),
      api: { getAccountEncryptionMode: async () => mode,
        readProviderAccountUsageRecord: async () => ({
          content: mode === 'plain' ? { t: 'plain' as const, v: snapshot }
            : { t: 'encrypted' as const, c: sealed.ciphertext },
          metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' as const },
          sources: [qualifiedGroupSource],
        }),
      },
      credentials: { token: 'token', encryption: { type: 'legacy', secret } }, store, nowMs: 1_001,
    });
    expect(store.resolveBySource(localGroupSource)?.recordId ?? null).toBe(expectedHydrated ? snapshot.recordId : null);
    expect(result.refreshSources).toEqual(expectedHydrated ? [] : [localGroupSource]);
    expect(result.dispositions[0]?.status).toBe(expectedHydrated ? 'hydrated_fresh' : 'ownership_unproven');
  });

  it('hydrates a V4 record only when the exact qualified source is linked by the owner', async () => {
    const snapshot = createSnapshot();
    const store = createProviderAccountUsageStore();
    const readProviderAccountUsageRecord = vi.fn(async () => ({
      content: { t: 'plain' as const, v: snapshot },
      metadata: {
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status: 'ok' as const,
      },
      sources: [qualifiedGroupSource],
    }));

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveRecordIdForSource: async (source) => ({
        source,
        recordId: snapshot.recordId,
        providerAccountId: 'acct-work',
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
      }),
      api: {
        getAccountEncryptionMode: async () => 'plain' as const,
        readProviderAccountUsageRecord,
      },
      credentials: { token: 'token', encryption: null },
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result).toEqual({
      hydratedRecordIds: [snapshot.recordId],
      dispositions: [{
        source: localGroupSource,
        status: 'hydrated_fresh',
        recordId: snapshot.recordId,
      }],
      refreshSources: [],
    });
    expect(readProviderAccountUsageRecord).toHaveBeenCalledWith({
      recordId: snapshot.recordId,
    });
    expect(store.resolveBySource(localGroupSource)?.recordId).toBe(snapshot.recordId);
  });

  it('refuses a V4 response whose source relation is for another group generation', async () => {
    const snapshot = createSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveRecordIdForSource: async (source) => ({
        source,
        recordId: snapshot.recordId,
        providerAccountId: 'acct-work',
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
      }),
      api: {
        getAccountEncryptionMode: async () => 'plain' as const,
        readProviderAccountUsageRecord: async () => ({
          content: { t: 'plain' as const, v: snapshot },
          metadata: {
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            status: 'ok' as const,
          },
          sources: [{ ...qualifiedGroupSource, groupGeneration: 3 }],
        }),
      },
      credentials: { token: 'token', encryption: null },
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.dispositions).toEqual([{
      source: localGroupSource,
      status: 'ownership_unproven',
    }]);
    expect(result.refreshSources).toEqual([localGroupSource]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('opens the V4 encrypted record envelope through the account-scoped cipher', async () => {
    const snapshot = {
      ...createSnapshot(),
      recoveryCreditDetails: { grant: { remainingCount: 2, appliesToProviderLimitIds: ['weekly'], unavailableReason: 'cooldown' as const } },
      subscription: {
        status: 'subscribed' as const, renewal: 'off' as const,
        observedAtMs: 900, staleAfterMs: 60_000,
        currentPeriodEndAtMs: 1_800_000_000_000,
      },
    };
    const encryption = {
      type: 'dataKey' as const,
      publicKey: new Uint8Array(32).fill(8),
      machineKey: new Uint8Array(32).fill(7),
    };
    const sealed = sealProviderAccountUsageSnapshot({
      material: encryption,
      snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(6),
    });
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveRecordIdForSource: async (source) => ({
        source,
        recordId: snapshot.recordId,
        providerAccountId: 'acct-work',
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
      }),
      api: {
        getAccountEncryptionMode: async () => 'e2ee' as const,
        readProviderAccountUsageRecord: async () => ({
          content: { t: 'encrypted' as const, c: sealed.ciphertext, subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails },
          metadata: {
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            status: 'ok' as const,
          },
          sources: [qualifiedGroupSource],
        }),
      },
      credentials: { token: 'token', encryption },
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.hydratedRecordIds).toEqual([snapshot.recordId]);
    expect(store.resolveBySource(localGroupSource)?.recordId).toBe(snapshot.recordId);
    expect(store.resolveBySource(localGroupSource)?.subscription).toEqual(snapshot.subscription);
    expect(store.resolveBySource(localGroupSource)?.recoveryCreditDetails).toEqual(snapshot.recoveryCreditDetails);
  });

  it('hydrates future-dated evidence as stale and schedules a bounded refresh', async () => {
    const snapshot = {
      ...createSnapshot(),
      observedAtMs: 100_000,
      fetchedAtMs: 100_000,
    };
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [v4HydrationSource()],
      resolveRecordIdForSource: async (source) => ({
        source,
        recordId: snapshot.recordId,
        providerAccountId: 'acct-work',
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
      }),
      api: {
        getAccountEncryptionMode: async () => 'plain' as const,
        readProviderAccountUsageRecord: async () => ({
          content: { t: 'plain' as const, v: snapshot },
          metadata: {
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            status: 'ok' as const,
          },
          sources: [qualifiedGroupSource],
        }),
      },
      credentials: { token: 'token', encryption: null },
      store,
      nowMs: 10_000,
    });

    expect(result.dispositions).toEqual([{
      source: expect.objectContaining({
        profileId: 'work',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      }),
      status: 'hydrated_stale',
      recordId: snapshot.recordId,
    }]);
    expect(result.refreshSources).toEqual([expect.objectContaining({
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    })]);
  });
});
