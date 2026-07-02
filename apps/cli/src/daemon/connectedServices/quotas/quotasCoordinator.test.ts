import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceQuotaSnapshotV1Schema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import { createHttpStatusError } from '@/api/client/httpStatusError';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { createDaemonServerWorkBudget, createDaemonServerWorkScheduler } from '@/daemon/serverWork';
import type { Credentials } from '@/persistence';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
type RegisterArgs = Parameters<QuotaApi['registerConnectedServiceQuotaSnapshotSealed']>[0];
type FetchArgs = Parameters<ConnectedServiceQuotaFetcher['loadQuota']>[0];
type SealedCredentialResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceCredentialSealed']>>>;
type SealedQuotaSnapshotResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>>;

describe('ConnectedServiceQuotasCoordinator', () => {
  function createJwtWithSub(sub: string, marker: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub, marker })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches and uploads plaintext quota snapshots for plaintext accounts', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialPlain).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
    expect((api as any).registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(0);
  });

  it('defers in-band durable persistence while account mode is unknown', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'unknown' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    const result = await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });

    expect(result).toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await (coordinator as any).flushInBandQuotaPersistence(100);
    expect((api as any).registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(0);
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(0);
  });

  it('suppresses in-band quota snapshots whose embedded service id does not match the write key', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      runtimeQuotaSnapshots,
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    })).resolves.toEqual({ status: 'suppressed', reason: 'service_id_mismatch' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(0);
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(0);
    expect(runtimeQuotaSnapshots.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      capturedAtMs: now,
    }).size).toBe(0);
  });

  it('does not persist unchanged in-band quota snapshots every five seconds by default', async () => {
    let now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    now += 6_000;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'suppressed', reason: 'unchanged_fresh' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('keeps a server refresh marker material after a background read so the next in-band snapshot persists', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });
    const oldSnapshot = makeSnapshot(now);
    const refreshRequestedAt = now + 500;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: oldSnapshot },
        metadata: {
          fetchedAt: oldSnapshot.fetchedAt,
          staleAfterMs: oldSnapshot.staleAfterMs,
          status: 'ok' as const,
          refreshRequestedAt,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => null),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: oldSnapshot,
    });
    await coordinator.flushInBandQuotaPersistence(1_000);

    await coordinator.tickOnce();

    now = refreshRequestedAt + 1;
    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(2);
  });

  it('moves in-band quota persistence to the hydrated account scope after credentials gain a JWT', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: '',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });
    const makeSnapshot = (fetchedAt: number): ConnectedServiceQuotaSnapshotV1 => ({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [{
        meterId: 'primary',
        label: 'Primary',
        used: 50,
        limit: 100,
        unit: 'requests',
        utilizationPct: 50,
        remainingPct: 50,
        resetsAt: 10_000,
        status: 'ok',
        details: {},
      }],
    });

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    credentials.token = createJwtWithSub('quota-account', 'hydrated');
    now += 1_000;

    await expect(coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: makeSnapshot(now),
    })).resolves.toEqual({ status: 'enqueued', enqueue: 'accepted' });
    await coordinator.flushInBandQuotaPersistence(1_000);

    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(2);
  });

  it('does not pause same-fingerprint in-band persistence after account mode recovers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const now = 1_000_000;
    let modeUnavailable = true;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        if (modeUnavailable) throw new Error('mode unavailable');
        return 'plain' as const;
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 0,
      quotaPersistenceFailureBackoffBaseMs: 10,
      quotaPersistenceFailureBackoffMaxMs: 10,
      quotaPersistenceFailureBackoffJitterRatio: 0,
      quotaPersistenceMaxConsecutiveFailures: 1,
    });
    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'pro',
      accountLabel: null,
      meters: [],
    };

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot,
    });
    const failedFlush = coordinator.flushInBandQuotaPersistence(1);
    await vi.advanceTimersByTimeAsync(1);
    await failedFlush;

    modeUnavailable = false;
    const resumed = await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot,
    });
    expect(resumed.status).toBe('enqueued');
    const recoveryFlush = coordinator.flushInBandQuotaPersistence(100);
    await vi.advanceTimersByTimeAsync(100);
    await recoveryFlush;

    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('refreshes account mode at in-band flush time before choosing quota storage mode', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn()
        .mockResolvedValueOnce('plain' as const)
        .mockResolvedValueOnce('e2ee' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    await expect(resolveConnectedServiceAccountMode(api)).resolves.toBe('plain');

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      },
    });

    await (coordinator as any).flushInBandQuotaPersistence(100);

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalledTimes(2);
    expect((api as any).registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(1);
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(0);
  });

  it('does not double-count server-work retries for failed in-band quota writes', async () => {
    const now = 1_000_000;
    const serverWorkScheduler = createDaemonServerWorkScheduler({
      budget: createDaemonServerWorkBudget({ maxConcurrentWrites: 1 }),
      now: () => now,
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {
        throw createHttpStatusError(503, 'server unavailable');
      }),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      serverWorkScheduler,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });

    await (coordinator as any).flushInBandQuotaPersistence(100);

    expect(serverWorkScheduler.getSnapshot().purposes.connectedServiceQuotaPersistence.counters).toMatchObject({
      accepted: 1,
      failed: 1,
      retried: 1,
    });
  });

  it('coalesces in-band quota snapshots and writes the latest payload on flush', async () => {
    const now = 1_000_000;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      },
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      quotaPersistenceMinIntervalMs: 5_000,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [],
      },
    });
    await coordinator.recordInBandQuotaSnapshot({
      serviceId: 'openai-codex',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now + 1,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      },
    });

    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(0);
    await (coordinator as any).flushInBandQuotaPersistence(100);
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        v: expect.objectContaining({ fetchedAt: now + 1, planLabel: 'Pro' }),
      }),
      metadata: expect.objectContaining({ materialFingerprint: expect.any(String) }),
    }));
  });

  it('defers polling quota work when the account-mode probe errors', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect((api as any).getAccountEncryptionMode).toHaveBeenCalled();
    expect((api as any).getConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect((api as any).getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(fetcher.loadQuota).not.toHaveBeenCalled();
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
    expect((api as any).registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(0);
  });

  it('routes polling quota snapshot writes through daemon server work', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const serverWorkScheduler = {
      enqueue: vi.fn(async (request) => {
        await request.run(request.payload);
        return { status: 'written' as const };
      }),
      flushAll: vi.fn(async () => ({ timedOut: false })),
      recordEvent: vi.fn(),
      getSnapshot: vi.fn(() => ({
        pendingKeyCount: 0,
        pendingPayloadBytes: 0,
        purposes: {},
        keys: {},
      })),
    } satisfies NonNullable<ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['serverWorkScheduler']>;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      serverWorkScheduler,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(serverWorkScheduler.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      key: expect.any(String),
      payload: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        materialFingerprint: expect.any(String),
      }),
    }));
    expect((api as any).registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('fetches and uploads sealed quota snapshots for active bindings', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedCiphertext: string | null = null;
    let uploadedStatus: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async (params: RegisterArgs) => {
        uploadedCiphertext = params.sealed.ciphertext;
        uploadedStatus = params.metadata?.status ?? null;
      }),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: 1,
            limit: 10,
            unit: 'count',
            utilizationPct: 10,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');
    expect(uploadedStatus).toBe('ok');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      ciphertext: uploadedCiphertext ?? '',
    });
    expect(opened?.value).toBeTruthy();
    const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(opened?.value);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.serviceId).toBe('openai-codex');
      expect(parsed.data.profileId).toBe('work');
    }
  });

  it('uses resolved group active profiles from child selections when registering spawn targets', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'work',
          fallbackProfileId: 'fallback',
          generation: 7,
          policy: {},
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(fetcher.loadQuota).toHaveBeenCalledWith(expect.objectContaining({
      record: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    }));
  });

  it('asks the auth-group switch coordinator to re-evaluate an active group after refreshing its active profile quota', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 95,
            remainingPct: 5,
            resetsAt: now + 60_000,
            status: 'ok',
            details: {},
          },
        ],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinatorParams = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
    };
    const coordinator = new ConnectedServiceQuotasCoordinator(coordinatorParams);

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('dedupes active-group soft switch cadence by group and active profile across sessions', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 60_000,
    });
    const target = (pid: number, sessionId: string) => ({
      pid,
      sessionId,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    } as const);

    coordinator.registerSpawnTarget(target(123, 'session-1'));
    await coordinator.tickOnce();
    coordinator.registerSpawnTarget(target(124, 'session-2'));
    now += 1_000;
    await coordinator.tickOnce();

    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
  });

  it('suppresses proactive soft-threshold switching while matching recovery is still pending', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const softSwitchRecoveryGuard = vi.fn(async () => ({
      status: 'suppress' as const,
      reason: 'quota_soft_switch_suppressed_recovery_pending',
    }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      softSwitchRecoveryGuard,
    } satisfies ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      authGroupSwitchCoordinator: { switchBeforeTurn: typeof switchBeforeTurn };
      groupSwitchCheckMinIntervalMs: number;
      softSwitchRecoveryGuard: typeof softSwitchRecoveryGuard;
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(softSwitchRecoveryGuard).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'active',
      reason: 'soft_threshold',
    });
    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });

  it('does not request active-group soft switching while the quota work gate is closed', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'active',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [{
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        }],
      })),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const recordDiagnostic = vi.fn();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length),
      discoveryEnabled: false,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
      quotaWorkGate: () => ({ status: 'suppressed' as const, reason: 'local_server_storm' }),
      recordDiagnostic,
    } as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0] & {
      quotaWorkGate: () => { status: 'suppressed'; reason: string };
      recordDiagnostic: (event: unknown) => void;
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(switchBeforeTurn).not.toHaveBeenCalled();
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quota_work_suppressed',
      phase: 'soft_switch',
      reason: 'local_server_storm',
    }));
  });

  it('keeps active-group soft switching independent from quota persistence failures', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'active',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {
        throw new Error('server timeout');
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'active',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 95,
          remainingPct: 5,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => snapshot),
    };
    const switchBeforeTurn = vi.fn(async () => ({ status: 'switched' as const, activeProfileId: 'backup', generation: 2 }));
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: false,
      runtimeQuotaSnapshots,
      authGroupSwitchCoordinator: { switchBeforeTurn },
      groupSwitchCheckMinIntervalMs: 0,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      sessionId: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'active',
          fallbackProfileId: 'backup',
          generation: 1,
        }]),
      },
    });

    await coordinator.tickOnce();

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'active',
    })).toBe(snapshot);
    expect(switchBeforeTurn).toHaveBeenCalledTimes(1);
    expect(switchBeforeTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'team',
      reason: 'soft_threshold',
      observedProfileId: 'active',
    });
  });

  it('probes requested group member quota snapshots for auth-group candidate selection', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'backup',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 0,
          remainingPct: 100,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => snapshot),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      runtimeQuotaSnapshots,
      discoveryEnabled: false,
    });
    const probeGroupQuotaSnapshots = (coordinator as unknown as {
      probeGroupQuotaSnapshots?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: readonly string[];
      }>) => Promise<void>;
    }).probeGroupQuotaSnapshots?.bind(coordinator);
    expect(typeof probeGroupQuotaSnapshots).toBe('function');
    if (!probeGroupQuotaSnapshots) return;

    await probeGroupQuotaSnapshots({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
    })).toStrictEqual(snapshot);
    expect(api.registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
  });

  it('hydrates requested group member quota snapshots from persisted storage', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const snapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'backup',
      fetchedAt: now,
      staleAfterMs: 300_000,
      planLabel: 'Pro',
      accountLabel: 'backup@example.com',
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: 20,
          remainingPct: 80,
          resetsAt: now + 60_000,
          status: 'ok',
          details: {},
        },
      ],
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: snapshot },
        metadata: {
          fetchedAt: now,
          staleAfterMs: 300_000,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } as unknown as QuotaApi;

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      runtimeQuotaSnapshots,
      discoveryEnabled: false,
    });
    const hydratePersistedQuotaSnapshotsForGroup = (coordinator as unknown as {
      hydratePersistedQuotaSnapshotsForGroup?: (input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
        profileIds: readonly string[];
      }>) => Promise<void>;
    }).hydratePersistedQuotaSnapshotsForGroup?.bind(coordinator);
    expect(typeof hydratePersistedQuotaSnapshotsForGroup).toBe('function');
    if (!hydratePersistedQuotaSnapshotsForGroup) return;

    await hydratePersistedQuotaSnapshotsForGroup({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileIds: ['backup'],
    });

    expect(runtimeQuotaSnapshots.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
    })).toStrictEqual(snapshot);
    expect(api.getConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'backup',
    });
  });

  it('derives a non-ok metadata status when all meters are unavailable', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedStatus: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async (params: RegisterArgs) => {
        uploadedStatus = params.metadata?.status ?? null;
      }),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: inputRecord.serviceId,
        profileId: inputRecord.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [
          {
            meterId: 'weekly',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: null,
            resetsAt: null,
            status: 'unavailable',
            details: {},
          },
        ],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(uploadedStatus).toBe('unavailable');
  });

  it('supports profile ids that contain ":"', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work:us',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (
        args: Parameters<QuotaApi['getConnectedServiceCredentialSealed']>[0],
      ): Promise<SealedCredentialResponse | null> => {
        if (args.profileId !== 'work:us') return null;
        return sealedCredential;
      }),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (_args: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: 'user@example.com',
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work:us' } },
      },
    });

    await coordinator.tickOnce();
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work:us' });
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
  });

  it('does not wedge the tick if a fetcher ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (_args: FetchArgs) => new Promise<null>(() => {})),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      fetchTimeoutMs: 10,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    let settled = false;
    const tick = coordinator.tickOnce().finally(() => {
      settled = true;
    });
    void tick;

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(settled).toBe(true);
    expect(api.registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(0);
    vi.useRealTimers();
  });

  it('supports dataKey credentials when sealing and opening snapshots', async () => {
    const now = 1_000_000;

    const machineKey = new Uint8Array(32).fill(7);
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'dataKey', machineKey },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

	    let uploadedCiphertext: string | null = null;
	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async (params: RegisterArgs) => {
	        uploadedCiphertext = params.sealed.ciphertext;
	      }),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      loadQuota: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
	        v: 1,
	        serviceId: inputRecord.serviceId,
	        profileId: inputRecord.profileId,
	        fetchedAt: now,
	        staleAfterMs: 300_000,
	        planLabel: 'Pro',
	        accountLabel: 'user@example.com',
	        meters: [],
	      })),
	    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();

    expect(api.registerConnectedServiceQuotaSnapshotSealed).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_quota_snapshot',
      material: { type: 'dataKey', machineKey },
      ciphertext: uploadedCiphertext ?? '',
    });
    expect(opened?.value).toBeTruthy();
  });

  it('forces a refresh when the server reports refreshRequestedAt newer than fetchedAt', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });
    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async () => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', loadQuota: vi.fn(async (_args: FetchArgs) => null) };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
  });

  it('aborts quota fetchers that exceed the timeout', async () => {
    vi.useFakeTimers();
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

	    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
	      kind: 'connected_service_credential',
	      material: { type: 'legacy', secret: credentials.encryption.secret },
	      payload: record,
	      randomBytes: (length) => randomBytes(length),
	    });
	    const sealedCredential: SealedCredentialResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
	      metadata: { kind: 'oauth' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	      registerConnectedServiceQuotaSnapshotSealed: vi.fn(),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      loadQuota: vi.fn(async ({ signal }: FetchArgs) => {
	        await new Promise<void>((_resolve, reject) => {
	          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
	        });
	        return null;
	      }),
	    };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	      fetchTimeoutMs: 5,
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    const pending = coordinator.tickOnce();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBeUndefined();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
  });

  it('skips fetching when the server snapshot is still fresh', async () => {
    const now = 1_000_000;
	    const credentials: Credentials = {
	      token: 'happy-token',
	      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
	    };
	    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

	    const existingSnapshot: SealedQuotaSnapshotResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
	      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
	      getConnectedServiceCredentialSealed: vi.fn(async () => null),
	      registerConnectedServiceQuotaSnapshotSealed: vi.fn(),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', loadQuota: vi.fn(async (_args: FetchArgs) => null) };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    expect(fetcher.loadQuota).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
  });

  it('uses a shared lease so contending daemons do not duplicate stale quota fetches', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const staleSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: now - 60_000,
      staleAfterMs: 1_000,
      planLabel: 'Pro',
      accountLabel: 'user@example.com',
      meters: [],
    };
    const freshSnapshot: ConnectedServiceQuotaSnapshotV1 = {
      ...staleSnapshot,
      fetchedAt: now,
      meters: [{
        meterId: 'weekly',
        label: 'Weekly',
        used: 1,
        limit: 10,
        unit: 'count',
        utilizationPct: 10,
        resetsAt: now + 60_000,
        status: 'ok',
        details: {},
      }],
    };

    let serverSnapshot: ConnectedServiceQuotaSnapshotV1 = staleSnapshot;
    let leaseOwner: string | null = null;
    let releaseFirstFetch: () => void = () => {};
    let releaseSleep: () => void = () => {};

    const apiWithLease = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: serverSnapshot },
        metadata: {
          fetchedAt: serverSnapshot.fetchedAt,
          staleAfterMs: serverSnapshot.staleAfterMs,
          status: 'ok' as const,
        },
      })),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async (params) => {
        serverSnapshot = params.content.v;
      }),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      acquireConnectedServiceRefreshLease: vi.fn(async (params: Readonly<{ ownerId?: string; leaseMs: number }>) => {
        const ownerId = params.ownerId ?? 'legacy-owner';
        if (!leaseOwner || leaseOwner === ownerId) {
          leaseOwner = ownerId;
          return { acquired: true, leaseUntil: now + params.leaseMs };
        }
        return { acquired: false, leaseUntil: now + 50 };
      }),
    };
    const api = apiWithLease as unknown as QuotaApi;

    let loadCallCount = 0;
    const loadQuotaMock = vi.fn(async () => {
      loadCallCount += 1;
      if (loadCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstFetch = resolve;
        });
      }
      return freshSnapshot;
    });
    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: loadQuotaMock,
    };

    const sleepMs = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSleep = resolve;
      });
    });

    const common = {
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      machineIdProvider: () => 'machine-1',
      quotaFetchLeaseMs: 10_000,
      quotaFetchLeaseContentionWaitMaxMs: 100,
      sleepMs,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0];

    const coordinatorA = new ConnectedServiceQuotasCoordinator({
      ...common,
      ownerIdProvider: () => 'machine-1:daemon-a',
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);
    const coordinatorB = new ConnectedServiceQuotasCoordinator({
      ...common,
      ownerIdProvider: () => 'machine-1:daemon-b',
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    for (const coordinator of [coordinatorA, coordinatorB]) {
      coordinator.registerSpawnTarget({
        pid: coordinator === coordinatorA ? 123 : 456,
        connectedServicesBindingsRaw: {
          v: 1,
          bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
        },
      });
    }

    const tickA = coordinatorA.tickOnce();
    await vi.waitFor(() => expect(loadQuotaMock).toHaveBeenCalledTimes(1));

    const tickB = coordinatorB.tickOnce();
    await vi.waitFor(() => {
      if (sleepMs.mock.calls.length === 0 && loadQuotaMock.mock.calls.length < 2) {
        throw new Error('waiting for quota lease contention');
      }
    });

    releaseFirstFetch();
    await tickA;
    releaseSleep();
    await tickB;

    expect(loadQuotaMock).toHaveBeenCalledTimes(1);
    expect(apiWithLease.registerConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(1);
    expect(apiWithLease.getConnectedServiceQuotaSnapshotPlain).toHaveBeenCalledTimes(3);
    expect(sleepMs).toHaveBeenCalledWith(50);
  });

  it('backs off instead of fetching provider quotas when lease acquisition fails', async () => {
    let now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const apiWithFailingLease = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
      acquireConnectedServiceRefreshLease: vi.fn(async () => {
        throw new Error('lease service unavailable');
      }),
    };
    const api = apiWithFailingLease as unknown as QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();

    expect(fetcher.loadQuota).not.toHaveBeenCalled();
    expect(apiWithFailingLease.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(apiWithFailingLease.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(apiWithFailingLease.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the fetcher fails', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

	    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
	      kind: 'connected_service_credential',
	      material: { type: 'legacy', secret: credentials.encryption.secret },
	      payload: record,
	      randomBytes: (length) => randomBytes(length),
	    });
	    const sealedCredential: SealedCredentialResponse = {
	      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
	      metadata: { kind: 'oauth' },
	    };

	    const api = {
	      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
	      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
	      registerConnectedServiceQuotaSnapshotSealed: vi.fn(),
	    } satisfies QuotaApi;

	    const fetcher: ConnectedServiceQuotaFetcher = {
	      serviceId: 'openai-codex',
	      loadQuota: vi.fn(async (_args: FetchArgs) => {
	        throw new Error('boom');
	      }),
	    };

	    const coordinator = new ConnectedServiceQuotasCoordinator({
	      api,
	      credentials,
	      quotaFetchers: [fetcher],
	      now: () => now,
	      randomBytes: (length: number) => randomBytes(length),
	    });

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await expect(coordinator.tickOnce()).resolves.toBeUndefined();
    expect(api.registerConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
  });

  it('applies a failure backoff window per binding', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } satisfies QuotaApi;
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      discoveryEnabled: false,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();

    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(2);
  });

  it('applies failure backoff even when refreshRequestedAt remains newer than fetchedAt', async () => {
    let now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };
    const existingSnapshot: SealedQuotaSnapshotResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: 'sealed' },
      metadata: { fetchedAt: now, staleAfterMs: 300_000, status: 'ok', refreshRequestedAt: now + 1 },
    };

    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async (): Promise<SealedQuotaSnapshotResponse | null> => existingSnapshot),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async () => {}),
    } satisfies QuotaApi;

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => new Uint8Array(length).fill(1),
      failureBackoffMinMs: 10_000,
      failureBackoffMaxMs: 60_000,
      failureBackoffJitterPct: 0,
      discoveryEnabled: false,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    coordinator.registerSpawnTarget({
      pid: 123,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
    });

    await coordinator.tickOnce();
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);

    now += 10_000;
    await coordinator.tickOnce();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(2);
  });

  it('can discover connected profiles when enabled', async () => {
    const now = 1_000_000;

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 60_000,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    const sealedCredentialCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const sealedCredential: SealedCredentialResponse = {
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCredentialCiphertext },
      metadata: { kind: 'oauth' },
    };

    let uploadedCiphertext: string | null = null;
    const api = {
      getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async (): Promise<SealedCredentialResponse | null> => sealedCredential),
      registerConnectedServiceQuotaSnapshotSealed: vi.fn(async (params: RegisterArgs) => {
        uploadedCiphertext = params.sealed.ciphertext;
      }),
    } satisfies QuotaApi;
    (api as unknown as { listConnectedServiceProfiles: unknown }).listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected' }],
    }));

    const fetcher: ConnectedServiceQuotaFetcher = {
      serviceId: 'openai-codex',
      loadQuota: vi.fn(async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'work',
        fetchedAt: now,
        staleAfterMs: 300_000,
        planLabel: 'Pro',
        accountLabel: null,
        meters: [],
      })),
    };

    const coordinator = new ConnectedServiceQuotasCoordinator({
      api,
      credentials,
      quotaFetchers: [fetcher],
      now: () => now,
      randomBytes: (length: number) => randomBytes(length),
      discoveryEnabled: true,
      discoveryIntervalMs: 1,
      failureBackoffJitterPct: 0,
    } as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]);

    await coordinator.tickOnce();

    expect((api as any).listConnectedServiceProfiles).toHaveBeenCalled();
    expect(fetcher.loadQuota).toHaveBeenCalledTimes(1);
    expect(typeof uploadedCiphertext).toBe('string');
  });
});
