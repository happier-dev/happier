import {
  buildProviderAccountUsageRecordId,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedServiceUsageSourceV4,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

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
  serviceId: 'openai-codex',
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
    const snapshot = createSnapshot();
    const encryption = {
      type: 'dataKey' as const,
      publicKey: new Uint8Array(32).fill(8),
      machineKey: new Uint8Array(32).fill(7),
    };
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: encryption,
      payload: snapshot,
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
          content: { t: 'encrypted' as const, c: ciphertext },
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
  });
});
