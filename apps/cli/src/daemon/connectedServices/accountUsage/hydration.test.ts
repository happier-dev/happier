import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  openProviderAccountUsageSnapshotCiphertext,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

import {
  hydrateProviderAccountUsageStoreFromCurrentSources,
} from './hydration';
import { createProviderAccountUsageStore } from './store';

type HydrationSealedUsageWrite = Parameters<
  NonNullable<
    Parameters<
      typeof hydrateProviderAccountUsageStoreFromCurrentSources
    >[0]['api']['registerProviderAccountUsageSnapshotSealed']
  >
>[0];

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

const groupMemberSource = {
  serviceId: 'openai-codex',
  profileId: 'work',
  bindingKind: 'group_member',
  groupId: 'team',
  groupGeneration: 4,
} as const satisfies ConnectedServiceUsageSourceV1;

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
  it('passively hydrates a fresh canonical record only after exact current-source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const resolveRecordIdForSource = vi.fn(async () => createSourceResolution(snapshot));

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource, groupMemberSource],
      resolveRecordIdForSource,
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [groupMemberSource],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(resolveRecordIdForSource).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      hydratedRecordIds: [snapshot.recordId],
      dispositions: [{
        source: groupMemberSource,
        status: 'hydrated_fresh',
        recordId: snapshot.recordId,
      }],
      refreshSources: [],
    });
    expect(store.resolveBySource(groupMemberSource)?.recordId).toBe(snapshot.recordId);
  });

  it.each([
    {
      name: 'legacy secretbox',
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array(32).fill(7),
        },
      },
    },
    {
      name: 'data-key AES',
      credentials: {
        token: 'happy-token',
        encryption: {
          type: 'dataKey' as const,
          publicKey: new Uint8Array(32).fill(8),
          machineKey: new Uint8Array(32).fill(7),
        },
      },
    },
  ] satisfies ReadonlyArray<Readonly<{
    name: string;
    credentials: Credentials;
  }>>)('hydrates predecessor recovery-credit bytes through $name', async ({ credentials }) => {
    const snapshot = createUsageSnapshot();
    const predecessorSnapshot = {
      ...snapshot,
      recoveryCredits: {
        kind: 'usage_limit_resets',
        availableCount: 1,
        totalCount: 1,
        credits: [{
          providerCreditId: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
          providerResetType: 'five_hour',
        }],
      },
    };
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material: credentials.encryption,
      payload: predecessorSnapshot,
      randomBytes: (length) => new Uint8Array(length).fill(6),
    });
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
        getProviderAccountUsageSnapshotSealed: vi.fn(async () => ({
          sealed: {
            format: 'account_scoped_v1' as const,
            ciphertext,
          },
          sources: [groupMemberSource],
        })),
      },
      credentials,
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.hydratedRecordIds).toEqual([snapshot.recordId]);
    expect(store.resolveBySource(groupMemberSource)?.recoveryCredits)
      .toMatchObject({
        availableCount: 1,
        credits: [{
          id: 'credit-1',
          kind: 'rate_limit_reset',
          status: 'available',
        }],
      });
  });

  it('reseals the frozen Dev-5 PAU alias only after exact source and revision proof', async () => {
    const source = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    } as const satisfies ConnectedServiceUsageSourceV1;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1,
      recordId:
        'paug_v1_D2ZqLYLAeVljfsjZqAF45dBhrB9Dkihcs1x1QuJJZxE',
      recordKey: {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
      },
      providerId: 'codex',
      accountSubject: {
        kind: 'providerSubject',
        id: 'acct_123',
      },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      staleAfterMs: 300_000,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      state: 'loaded_data',
      meters: [],
    });
    const frozenDev5Ciphertext =
      'oQUhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzi6SehvXZ/yz94+M9Vq66Qzu1J0HRw6SZDLxYn3bzyTRESOkGZ0HXs8b6QF9PbRtY6tfWVDhnUrAds7ZUS17itP0ugnzxZH6pplVZRLXQagmgXC2jnWHNdOy3EiXUbRllvb+KVToW8pH9OWTuJ13c+QSMXG9SZFrG4+AySORX5xh9rpmZyfYdvNUU/6gMcZxRowrgYOzB2vWcwbT3N7z4pNj2wA5ciPIvdadMmb3C/RlRsdbH3K3IQ/CxyDaJ7VHOm6l11sSmFihk5ecDivoAkQgu89mWgXVHivhDzCqmnE23p/sfawKFuiXMXbceIDt8k5huaw9yv3edvJ+ISX0LKzYzpqSCxlfqVTUI8ePARx/S7HZCgox7VrOCmwR1kmgGsiuM+ERcVaAqwxLkC4QfW6bKtM7Ml/TRs9BdoG0Masxeyl/bnXXTN9FEAxaKbQB9Uc6yz3DmvgzldLHeC68S2iGWaDORAx1Hrftrv4UPfpadtu2my5uBk9mypyilA8P0+RmKFXSxTClhpVm/K0VOd6QqvQObbXd7ew7mlIbYsgpOPO43PKFUk4lq4=';
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'dataKey',
        publicKey:
          Uint8Array.from({ length: 32 }, (_, index) => index + 33),
        machineKey:
          Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      },
    };
    const register =
      vi.fn(async (_write: HydrationSealedUsageWrite) => {});
    const getSealed = vi.fn(async () => ({
      sealed: {
        format: 'account_scoped_v1' as const,
        ciphertext: frozenDev5Ciphertext,
      },
      metadata: {
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status: 'ok' as const,
        materialFingerprint: 'pau-logical-revision',
      },
      sources: [source],
    }));
    const store = createProviderAccountUsageStore();

    await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [source],
      resolveRecordIdForSource: async () =>
        createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode:
          vi.fn(async () => 'e2ee' as const),
        getProviderAccountUsageSnapshotSealed: getSealed,
        registerProviderAccountUsageSnapshotSealed: register,
      },
      credentials,
      store,
      nowMs: 1_001,
      randomBytes: (length) =>
        new Uint8Array(length).fill(7),
    });

    expect(register).toHaveBeenCalledOnce();
    const write = register.mock.calls[0]?.[0];
    if (!write) {
      throw new Error(
        'Expected the historical PAU alias to be resealed',
      );
    }
    expect(write).toEqual(expect.objectContaining({
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      source,
      metadata: {
        fetchedAt: snapshot.fetchedAtMs,
        staleAfterMs: snapshot.staleAfterMs,
        status: 'ok',
        materialFingerprint: 'pau-logical-revision',
      },
    }));
    expect(openProviderAccountUsageSnapshotCiphertext({
      material: credentials.encryption,
      ciphertext: write.sealed.ciphertext,
    })).toMatchObject({
      kindTag: 'canonical',
      value: snapshot,
    });
  });

  it('does not adopt a record when the authoritative response omits the exact source proof', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();
    const mismatchedGeneration = { ...groupMemberSource, groupGeneration: 3 };

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource],
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

    expect(result.dispositions).toEqual([{
      source: groupMemberSource,
      status: 'ownership_unproven',
    }]);
    expect(result.refreshSources).toEqual([groupMemberSource]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('rejects a source resolution whose provider-account identity does not match the fetched record', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot, {
        providerAccountId: 'acct-other',
      }),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [groupMemberSource],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + 1,
    });

    expect(result.dispositions).toEqual([{
      source: groupMemberSource,
      status: 'ownership_unproven',
    }]);
    expect(store.listSnapshots()).toEqual([]);
  });

  it('hydrates stale evidence for passive display but returns it for bounded refresh scheduling', async () => {
    const snapshot = createUsageSnapshot();
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource],
      resolveRecordIdForSource: async () => createSourceResolution(snapshot),
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getProviderAccountUsageSnapshotPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: snapshot },
          sources: [groupMemberSource],
        })),
      },
      credentials: createCredentials(),
      store,
      nowMs: snapshot.fetchedAtMs + snapshot.staleAfterMs,
    });

    expect(result.dispositions).toEqual([{
      source: groupMemberSource,
      status: 'hydrated_stale',
      recordId: snapshot.recordId,
    }]);
    expect(result.refreshSources).toEqual([groupMemberSource]);
    expect(store.resolveBySource(groupMemberSource)?.recordId).toBe(snapshot.recordId);
  });

  it('returns missing current sources for refresh without mutating the store', async () => {
    const store = createProviderAccountUsageStore();

    const result = await hydrateProviderAccountUsageStoreFromCurrentSources({
      sources: [groupMemberSource],
      resolveRecordIdForSource: async () => null,
      api: {},
      credentials: createCredentials(),
      store,
      nowMs: 1_700_000_000_000,
    });

    expect(result.dispositions).toEqual([{
      source: groupMemberSource,
      status: 'missing',
    }]);
    expect(result.refreshSources).toEqual([groupMemberSource]);
    expect(store.listSnapshots()).toEqual([]);
  });
});
