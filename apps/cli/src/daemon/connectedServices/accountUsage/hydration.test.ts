import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshot,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import {
  hydrateProviderAccountUsageStoreFromCurrentSources,
} from './hydration';
import { createProviderAccountUsageStore } from './store';

function createUsageSnapshot(): ProviderAccountUsageSnapshotV1 {
  const recordKey = {
    providerId: 'codex',
    accountSubjectId: 'acct-work',
    subjectKind: 'account' as const,
    quotaScope: 'account' as const,
  };
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'acct-work' },
    observedAtMs: 1_700_000_000_000,
    fetchedAtMs: 1_700_000_000_000,
    staleAfterMs: 60_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    planLabel: 'Pro',
    accountLabel: 'work@example.com',
    meters: [],
  });
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
  };
}

function createSourceResolution(
  snapshot: ProviderAccountUsageSnapshotV1,
  overrides: Partial<Readonly<{
    providerAccountId: string;
    fetchedAt: number | null;
    staleAfterMs: number | null;
  }>> = {},
) {
  return {
    recordId: snapshot.recordId,
    providerAccountId: snapshot.recordKey.accountSubjectId,
    fetchedAt: snapshot.fetchedAtMs,
    staleAfterMs: snapshot.staleAfterMs,
    ...overrides,
  };
}

describe('hydrateProviderAccountUsageStoreFromCurrentSources', () => {
  const source = {
    serviceId: 'openai-codex',
    profileId: 'work',
    bindingKind: 'group_member',
    groupId: 'team',
    groupGeneration: 4,
  } as const satisfies ConnectedServiceUsageSourceV1;

  it('hydrates independently encrypted subscription observations for the proven current source', async () => {
    const snapshot = {
      ...createUsageSnapshot(),
      subscription: { status: 'none' as const, renewal: 'unknown' as const, observedAtMs: 1_700_000_000_000, staleAfterMs: 60_000 },
    };
    const store = createProviderAccountUsageStore();
    const sealed = sealProviderAccountUsageSnapshot({
      snapshot,
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: async () => 'e2ee',
        getProviderAccountUsageSnapshotSealed: async () => ({ sealed, sources: [source] }),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });
    expect(store.resolveBySource(source)?.subscription).toEqual(snapshot.subscription);
  });

  it('passively hydrates a fresh canonical record only after exact current-source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const resolveRecordIdForSource = vi.fn(async () => createSourceResolution(snapshot));

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source, source],
      resolveRecordIdForSource,
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(resolveRecordIdForSource).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      hydratedRecordIds: [snapshot.recordId],
      dispositions: [{ source, status: 'hydrated_fresh', recordId: snapshot.recordId }],
      refreshSources: [],
    });
    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });

  it('does not adopt a record when the authoritative response omits the exact source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const mismatchedGeneration = { ...source, groupGeneration: 3 };

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [mismatchedGeneration],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.dispositions).toEqual([{ source, status: 'ownership_unproven' }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it.each([false, true])('refreshes legacy Claude account-only records instead of adopting unproven organization scope (encrypted=%s)', async (encrypted) => {
    const recordKey = {
      providerId: 'claude', accountSubjectId: 'acct-user', subjectKind: 'account' as const,
      quotaScope: 'account' as const,
    };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      ...createUsageSnapshot(), recordKey, recordId: buildProviderAccountUsageRecordId(recordKey),
      providerId: 'claude', accountSubject: { kind: 'providerSubject', id: 'acct-user' },
    });
    const claudeSource = { serviceId: 'claude-subscription', profileId: 'work', bindingKind: 'profile' } as const;
    const store = createProviderAccountUsageStore();
    const sealed = sealProviderAccountUsageSnapshot({
      snapshot, material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [claudeSource],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: async () => encrypted ? 'e2ee' : 'plain',
        getProviderAccountUsageSnapshotPlain: async () => ({ content: { t: 'plain', v: snapshot }, sources: [claudeSource] }),
        getProviderAccountUsageSnapshotSealed: async () => ({ sealed, sources: [claudeSource] }),
      },
      credentials: createCredentials(), store, nowMs: snapshot.fetchedAtMs + 1,
    });
    expect(result.dispositions).toEqual([{ source: claudeSource, status: 'ownership_unproven' }]);
    expect(result.refreshSources).toEqual([claudeSource]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('rejects a source resolution whose provider-account identity does not match the fetched record', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot, {
        providerAccountId: 'acct-other',
      }),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.dispositions).toEqual([{ source, status: 'ownership_unproven' }]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('hydrates stale evidence for passive display but returns it for bounded refresh scheduling', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + snapshot.staleAfterMs,
    });

    expect(result.dispositions).toEqual([{
      source,
      status: 'hydrated_stale',
      recordId: snapshot.recordId,
    }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.resolveBySource(source)?.recordId).toBe(snapshot.recordId);
  });

  it('hydrates future-dated evidence as stale and schedules a bounded refresh', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const nowMs = snapshot.fetchedAtMs - 60_000;

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [source],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs,
    });

    expect(result.dispositions).toEqual([{
      source,
      status: 'hydrated_stale',
      recordId: snapshot.recordId,
    }]);
    expect(result.refreshSources).toEqual([source]);
  });

  it('returns missing current sources for refresh without mutating the store', async () => {
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () => null,
      api: {},
      credentials: createCredentials(),
      store,
      nowMs: 1_700_000_000_000,
    });

    expect(result.dispositions).toEqual([{ source, status: 'missing' }]);
    expect(result.refreshSources).toEqual([source]);
    expect(store.listSnapshots()).toEqual([]);
  });
});
