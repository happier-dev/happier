import {
  buildProviderAccountUsageRecordId,
  openProviderAccountUsageSnapshotCiphertext,
  type SealedProviderAccountUsageSnapshotV1,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

type AccountUsageApi = Readonly<{
  getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: string;
    source?: ConnectedServiceUsageSourceV1;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: string;
    source?: ConnectedServiceUsageSourceV1;
    sealed: { format: 'account_scoped_v1'; ciphertext: string };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
}>;

type PersistenceModule = Readonly<{
  buildProviderAccountUsageSnapshotRoute(params: Readonly<{
    version: 'v2' | 'v3';
    recordId: string;
  }>): string;
  createProviderAccountUsagePersistenceScheduler(params: Readonly<{
    api: AccountUsageApi;
    now: () => number;
    fingerprintKey?: Uint8Array;
    credentials?: Credentials;
    randomBytes?: (length: number) => Uint8Array;
    minFreshnessMs?: number;
  }>): Readonly<{
    recordInBandSnapshot(
      snapshot: ProviderAccountUsageSnapshotV1,
      options?: Readonly<{
        source?: ConnectedServiceUsageSourceV1;
        sources?: readonly ConnectedServiceUsageSourceV1[];
        onPersisted?: () => void;
      }>,
    ): Promise<
      | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
      | Readonly<{ status: 'already_persisted'; reason: string }>
    >;
    flush(timeoutMs: number): Promise<unknown>;
    dispose(): void;
  }>;
}>;

async function loadPersistenceModule(): Promise<PersistenceModule | null> {
  return await import('./persistence').catch(() => null) as PersistenceModule | null;
}

function createKey(accountSubjectId = 'acct_123'): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
}

function createSnapshot(recordKey = createKey()): ProviderAccountUsageSnapshotV1 {
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [],
  };
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
  };
}

describe('provider account usage persistence', () => {
  it('carries failure completion in sealed metadata without re-aging retained usage', async () => {
    const { createProviderAccountUsagePersistenceScheduler } = await import('./persistence');
    const write = vi.fn(async () => {});
    const scheduler = createProviderAccountUsagePersistenceScheduler({
      api: { getAccountEncryptionMode: async () => 'e2ee', registerProviderAccountUsageSnapshotSealed: write },
      credentials: createCredentials(), randomBytes: (length) => new Uint8Array(length).fill(8),
      now: () => 5_000,
    });
    try {
      await scheduler.recordInBandSnapshot({ ...createSnapshot(), observedAtMs: 4_000, state: 'error_last_known_good',
        diagnostics: [{ kind: 'provider_http', status: 429, observedAtMs: 3_000 },
          { kind: 'provider_http', status: 503, observedAtMs: 4_000 }] });
      await scheduler.flush(1_000);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ fetchedAt: 1_000, status: 'error', refreshErrorAt: 4_000 }),
      }));
    } finally { scheduler.dispose(); }
  });

  it('omits subscription but preserves usage when the server subscription decision is absent', async () => {
    const { createProviderAccountUsagePersistenceScheduler } = await import('./persistence');
    const base = createSnapshot();
    let persisted: ProviderAccountUsageSnapshotV1 | undefined;
    const scheduler = createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async ({ content }) => { persisted = content.v; },
      },
      fingerprintKey: new Uint8Array(32).fill(4),
      now: () => 1_000,
    });
    try {
      await scheduler.recordInBandSnapshot({
        ...base,
        subscription: { status: 'none', renewal: 'unknown', observedAtMs: 900, staleAfterMs: 60_000 },
      });
      await scheduler.flush(1_000);
      expect(persisted).toEqual(base);
    } finally {
      scheduler.dispose();
    }
  });
  it('seals subscription separately so released usage readers retain their strict base snapshot', async () => {
    const { createProviderAccountUsagePersistenceScheduler } = await import('./persistence');
    const credentials = createCredentials();
    const base = createSnapshot();
    const snapshot = { ...base, subscription: { status: 'none' as const, renewal: 'unknown' as const, observedAtMs: 900, staleAfterMs: 60_000 } };
    let persisted: SealedProviderAccountUsageSnapshotV1 | undefined;
    const scheduler = createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'e2ee',
        registerProviderAccountUsageSnapshotSealed: async ({ sealed }) => { persisted = sealed; },
      },
      credentials,
      isSubscriptionEnabled: () => true,
      now: () => 1_000,
      randomBytes: (length) => new Uint8Array(length).fill(8),
    });
    try {
      await scheduler.recordInBandSnapshot(snapshot);
      await scheduler.flush(1_000);
      expect(persisted).toHaveProperty('subscription');
      expect(openProviderAccountUsageSnapshotCiphertext({
        material: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
        ciphertext: persisted!.ciphertext,
      })?.value).toEqual(base);
    } finally {
      scheduler.dispose();
    }
  });
  it('builds canonical provider-account-usage snapshot routes by record id', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();

    expect(module!.buildProviderAccountUsageSnapshotRoute({
      version: 'v3',
      recordId: snapshot.recordId,
    })).toBe(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`);
    expect(module!.buildProviderAccountUsageSnapshotRoute({
      version: 'v2',
      recordId: snapshot.recordId,
    })).toBe(`/v2/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`);
  });

  it('persists plaintext snapshots through the provider-account-usage API interface, not connected-service profile quota keys', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
      status: 'enqueued',
      enqueue: 'accepted',
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({
      recordId: snapshot.recordId,
      content: { t: 'plain', v: snapshot },
      metadata: expect.objectContaining({
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        status: 'ok',
        materialFingerprint: expect.any(String),
      }),
    });
    expect(api.registerProviderAccountUsageSnapshotSealed).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
  });

  it('reports an identical snapshot as already persisted after the first write drains', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async () => {},
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 60_000,
    });
    const snapshot = createSnapshot();
    try {
      await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
        status: 'enqueued',
        enqueue: 'accepted',
      });
      await scheduler.flush(1_000);

      await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
        status: 'already_persisted',
        reason: 'unchanged',
      });
    } finally {
      scheduler.dispose();
    }
  });

  it('confirms a queued in-band write once the server accepts it', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const serverWrite: { accept: (() => void) | null } = { accept: null };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: () => new Promise<void>((resolve) => { serverWrite.accept = resolve; }),
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
    });
    const onPersisted = vi.fn();
    try {
      await expect(scheduler.recordInBandSnapshot(createSnapshot(), { onPersisted }))
        .resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
      await vi.waitFor(() => expect(serverWrite.accept).not.toBeNull());
      expect(onPersisted).not.toHaveBeenCalled();

      serverWrite.accept?.();
      await scheduler.flush(1_000);
      expect(onPersisted).toHaveBeenCalledOnce();
    } finally {
      scheduler.dispose();
    }
  });

  it('confirms a queued in-band write that lands on a retry after the server first fails', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    let attempts = 0;
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('server unavailable');
        },
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
    });
    const onPersisted = vi.fn();
    try {
      await scheduler.recordInBandSnapshot(createSnapshot(), { onPersisted });
      await vi.waitFor(async () => {
        await scheduler.flush(1_000);
        expect(attempts).toBeGreaterThanOrEqual(2);
      }, { timeout: 10_000 });
      expect(onPersisted).toHaveBeenCalledOnce();
    } finally {
      scheduler.dispose();
    }
  });

  it('does not let a future-dated observation suppress a later current persistence write', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 10_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 60_000,
    });
    const future = { ...createSnapshot(), fetchedAtMs: 100_000, observedAtMs: 100_000 };
    const current = { ...createSnapshot(), fetchedAtMs: 10_000, observedAtMs: 10_000 };
    try {
      await expect(scheduler.recordInBandSnapshot(future)).resolves.toEqual({
        status: 'already_persisted',
        reason: 'future',
      });
      await expect(scheduler.recordInBandSnapshot(current)).resolves.toEqual({
        status: 'enqueued',
        enqueue: 'accepted',
      });
      await scheduler.flush(1_000);
      expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(1);
      expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ fetchedAt: 10_000 }),
      }));
    } finally {
      scheduler.dispose();
    }
  });

  it('rejects intake when the persistence scheduler cannot take custody', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async () => {},
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
    });
    scheduler.dispose();

    await expect(scheduler.recordInBandSnapshot(createSnapshot()))
      .rejects.toThrow('provider_account_usage_persistence_disposed');
  });

  it('passes explicit connected-service source context through plaintext provider-account usage persistence', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    }));
  });

  it('persists every connected-service source relation for a provider-account usage record', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const profileSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const groupSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      sources: [profileSource, groupSource],
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(1, expect.objectContaining({
      recordId: snapshot.recordId,
      source: profileSource,
    }));
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(2, expect.objectContaining({
      recordId: snapshot.recordId,
      source: groupSource,
    }));
  });

  it('seals e2ee snapshots through the provider-account-usage API interface when account storage is encrypted', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      credentials: createCredentials(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot);
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith({
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      sealed: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
      metadata: expect.objectContaining({
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        status: 'ok',
        materialFingerprint: expect.any(String),
      }),
    });
    expect(api.registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
  });

  it('passes explicit connected-service source context through sealed provider-account usage persistence', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      credentials: createCredentials(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    }));
  });
});
