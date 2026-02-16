import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceQuotaSnapshotV1Schema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { randomBytes } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from './types';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];
type RegisterArgs = Parameters<QuotaApi['registerConnectedServiceQuotaSnapshotSealed']>[0];
type FetchArgs = Parameters<ConnectedServiceQuotaFetcher['fetch']>[0];
type SealedCredentialResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceCredentialSealed']>>>;
type SealedQuotaSnapshotResponse = NonNullable<Awaited<ReturnType<QuotaApi['getConnectedServiceQuotaSnapshotSealed']>>>;

describe('ConnectedServiceQuotasCoordinator', () => {
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
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
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

    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
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
      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
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
      fetch: vi.fn(async (_args: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
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
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
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
      fetch: vi.fn(async (_args: FetchArgs) => new Promise<null>(() => {})),
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
	      fetch: vi.fn(async ({ record: inputRecord }: FetchArgs): Promise<ConnectedServiceQuotaSnapshotV1 | null> => ({
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

    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', fetch: vi.fn(async (_args: FetchArgs) => null) };

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
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
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
	      fetch: vi.fn(async ({ signal }: FetchArgs) => {
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
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
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

	    const fetcher: ConnectedServiceQuotaFetcher = { serviceId: 'openai-codex', fetch: vi.fn(async (_args: FetchArgs) => null) };

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
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceQuotaSnapshotSealed).not.toHaveBeenCalled();
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
	      fetch: vi.fn(async (_args: FetchArgs) => {
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
});
