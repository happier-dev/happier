import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

function createNeedsReauthRefreshHarness(params: Readonly<{
  expiresAt: number | null;
  now?: number;
  onCredentialHealthNotification?: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onCredentialHealthNotification'];
}>): Readonly<{
  coordinator: ConnectedServiceRefreshCoordinator;
  api: ApiClient & Readonly<{
    acquireConnectedServiceRefreshLease: ReturnType<typeof vi.fn>;
    listConnectedServiceProfiles: ReturnType<typeof vi.fn>;
  }>;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  const now = params.now ?? 1_000_000;
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
    expiresAt: params.expiresAt,
    oauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: 'acct',
      providerEmail: null,
    },
  });
  const sealedCiphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret: credentials.encryption.secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });
  const api = {
    listConnectedServiceProfiles: vi.fn(async () => ({
      serviceId: 'openai-codex' as const,
      profiles: [{ profileId: 'work', status: 'needs_reauth' as const }],
    })),
    getConnectedServiceCredentialSealed: vi.fn(async () => ({
      sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
      metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: params.expiresAt },
    })),
    acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
    registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
  } as unknown as ApiClient & Readonly<{
    acquireConnectedServiceRefreshLease: ReturnType<typeof vi.fn>;
    listConnectedServiceProfiles: ReturnType<typeof vi.fn>;
  }>;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return {
    api,
    fetchMock,
    coordinator: new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      ...(params.onCredentialHealthNotification
        ? { onCredentialHealthNotification: params.onCredentialHealthNotification }
        : {}),
    }),
  };
}

describe('ConnectedServiceRefreshCoordinator', () => {
  it('refreshes an expiring openai-codex credential and re-materializes for active spawn targets', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	    } as unknown as ApiClient;

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);

    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('refreshes plaintext credentials for plaintext accounts', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-plain-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-plain-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'plain-new-access',
        refresh_token: 'plain-new-refresh',
        id_token: 'plain-new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain',
    });

    await coordinator.tickOnce();

    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();

    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('plain-new-access');
  });

  it('force-refreshes Codex ChatGPT bridge credentials without a finite expiry', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: null },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'bridge-new-access',
        refresh_token: 'bridge-new-refresh',
        id_token: 'bridge-new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      chatgptPlanType: 'plus',
    })).resolves.toEqual({
      accessToken: 'bridge-new-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('falls back to plaintext credentials when the account-mode probe errors', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-plain-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-plain-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
      }),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-plain-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 456,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-plain-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(typedApi.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
    const oauthRecord = record.kind === 'oauth' ? record.oauth : null;
    if (!oauthRecord) {
      throw new Error('Expected oauth record fixture');
    }
    expect(oauthRecord.accessToken).toBe('new-access');

    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('falls back to sealed credentials when unknown account mode cannot read plaintext during refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-sealed-fallback-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-sealed-fallback-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('plain read failed');
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        id_token: 'new-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-sealed-fallback',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 789,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-sealed-fallback',
    });

    await coordinator.tickOnce();

    const typedApi = api as unknown as {
      getConnectedServiceCredentialPlain: ReturnType<typeof vi.fn>;
      getConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
      registerConnectedServiceCredentialSealed: ReturnType<typeof vi.fn>;
    };
    expect(typedApi.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(typedApi.getConnectedServiceCredentialSealed).toHaveBeenCalled();
    expect(typedApi.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);

    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', 'work', 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-access');
  });

  it('invokes onAuthUpdated callback with affected targets after refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

	    const api = {
	      getConnectedServiceCredentialSealed: vi.fn(async () => ({
	        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
	        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
	      })),
	      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
	      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
	        sealedCiphertext = params.sealed.ciphertext;
	      }),
	    } as unknown as ApiClient;

	    const fetchMock = vi.fn(async () => ({
	      ok: true,
	      json: async () => ({
	        access_token: 'new-access',
	        refresh_token: 'new-refresh',
	        id_token: 'new-id',
	        expires_in: 3600,
	      }),
	    }));
	    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'pi',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'pi' })],
    }));
  });

  it('does not restart affected Claude targets when scheduled refresh rematerialization is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'narrow-access',
        refreshToken: 'narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-narrow-access',
        refresh_token: 'new-narrow-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude',
    });

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await coordinator.tickOnce();
      expect(warn).toHaveBeenCalledWith(
        '[DAEMON RUN] Connected-service rematerialization blocked; skipping auth-update restart',
        expect.objectContaining({
          serviceId: 'claude-subscription',
          profileId: 'work',
          agentId: 'claude',
          materializationCode: 'claude_subscription_missing_claude_code_scope',
        }),
      );
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('narrow-refresh');
  });

  it('does not restart a multi-service target when any scheduled-refresh rematerialized binding is blocking', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-external-update-multi-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-external-update-multi-blocked-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const legacySecret = credentials.encryption.secret;

    const now = 1_000_000;
    const codexRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'codex-acct',
        providerEmail: null,
      },
    });
    const claudeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'claude-narrow-access',
        refreshToken: 'claude-narrow-refresh',
        idToken: null,
        scope: 'user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });
    const seal = (payload: typeof codexRecord | typeof claudeRecord) => sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: legacySecret },
      payload,
      randomBytes: (length) => randomBytes(length),
    });
    const ciphertextByKey = new Map([
      ['openai-codex/work', seal(codexRecord)],
      ['claude-subscription/claude-work', seal(claudeRecord)],
    ]);
    const updateConnectedServiceCredentialHealth = vi.fn(async () => {});
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => {
        const ciphertext = ciphertextByKey.get(`${params.serviceId}/${params.profileId}`);
        if (!ciphertext) return null;
        const record = params.serviceId === 'openai-codex' ? codexRecord : claudeRecord;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: null,
            providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId : null,
            expiresAt: record.expiresAt,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-codex-access',
        refresh_token: 'new-codex-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onAuthUpdated = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
          'claude-subscription': { source: 'connected', profileId: 'claude-work' },
        },
      },
      materializationKey: 'session-claude',
    });

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await coordinator.tickOnce();
    } finally {
      warn.mockRestore();
    }

    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'claude-work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
    expect(JSON.stringify(updateConnectedServiceCredentialHealth.mock.calls)).not.toContain('claude-narrow-refresh');
  });

  it('preserves tracked group selections when refresh rematerializes an active spawn target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const primaryRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-primary-access',
        refreshToken: 'old-primary-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedPrimaryCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: primaryRecord,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { profileId: string }) => (
        params.profileId === 'primary'
          ? {
            sealed: { format: 'account_scoped_v1', ciphertext: sealedPrimaryCiphertext },
            metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
          }
          : null
      )),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedPrimaryCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-primary-access',
        refresh_token: 'new-primary-refresh',
        id_token: 'new-primary-id',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
            profileId: 'backup',
          },
        },
      },
      connectedServiceSelectionsEnvRaw: JSON.stringify([
        {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          activeProfileId: 'primary',
          fallbackProfileId: 'backup',
          generation: 2,
          policy: null,
        },
      ]),
      materializationKey: 'session-1',
    });

    await coordinator.tickOnce();

    const codexHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'openai-codex', '__groups', 'team', 'codex', 'codex-home');
    const auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('new-primary-access');
  });

  it('classifies invalid refresh tokens during spawn preflight refresh', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'invalid-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');
    const sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant', refresh_token: 'secret-refresh-token' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const onCredentialHealthNotification = vi.fn();
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      onCredentialHealthNotification,
    } as unknown as ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]);

    const preflight = coordinator as unknown as Readonly<{
      refreshConnectedServiceCredentialForSpawnPreflight?: (params: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
      }>) => Promise<Readonly<{
        status: string;
        diagnostic: Readonly<{ category?: string }>;
      }>>;
    }>;
    expect(preflight.refreshConnectedServiceCredentialForSpawnPreflight).toEqual(expect.any(Function));

    const targetRegistration = {
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'materialization-identity-1',
      sessionId: 'happy-session-1',
    } as Parameters<ConnectedServiceRefreshCoordinator['registerSpawnTarget']>[0] & {
      sessionId: string;
    };
    coordinator.registerSpawnTarget(targetRegistration);

    const result = await preflight.refreshConnectedServiceCredentialForSpawnPreflight!({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(result.diagnostic.category).toBe('invalid_grant');
    expect(api.updateConnectedServiceCredentialHealth).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: expect.objectContaining({
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'invalid_grant',
        providerHttpStatus: 400,
        providerErrorCode: 'invalid_grant',
      }),
    });
    expect(onCredentialHealthNotification).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        status: 'refresh_failed',
        category: 'invalid_grant',
        providerStatus: 400,
        providerErrorCode: 'invalid_grant',
      }),
      healthStatus: 'reconnect_required',
      affectedTargets: [expect.objectContaining({
        pid: 123,
        agentId: 'codex',
        sessionId: 'happy-session-1',
      })],
    }));
    expect(JSON.stringify(onCredentialHealthNotification.mock.calls)).not.toContain('secret-refresh-token');
  });

  it('warns with a redacted diagnostic when credential health notification dispatch fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { coordinator } = createNeedsReauthRefreshHarness({
      expiresAt: 1_030_000,
      onCredentialHealthNotification: vi.fn(async () => {
        throw new Error('notify failed Authorization: Bearer NOTIFY_SECRET');
      }),
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({
      status: 'refresh_failed',
    }));

    expect(warnSpy).toHaveBeenCalledWith(
      '[DAEMON RUN] Failed to dispatch connected-service credential health notification',
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        status: 'refresh_failed',
        category: 'invalid_grant',
      }),
    );
    expect(JSON.stringify(warnSpy.mock.calls.at(-1)?.[1])).not.toContain('NOTIFY_SECRET');
  });

  it('returns reconnect-required from spawn preflight before the expiry-window shortcut', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(result.diagnostic).toMatchObject({
      reason: 'spawn_preflight',
      category: 'invalid_grant',
      providerErrorCode: 'invalid_grant',
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts profile-health read failures before refresh', async () => {
    const { coordinator, api } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    api.listConnectedServiceProfiles.mockRejectedValueOnce(
      new AxiosError('Request failed with Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
        method: 'get',
        url: 'https://api.example.test/v3/connect/openai-codex/profiles?token=QUERY_SECRET',
        headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
        data: { access_token: 'BODY_SECRET' },
      }),
    );
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    })).resolves.toEqual(expect.objectContaining({ status: 'not_needed' }));

    const payload = JSON.stringify(warnSpy.mock.calls.at(-1)?.[1]);
    expect(payload).toContain('https://api.example.test/v3/connect/openai-codex/profiles');
    expect(payload).not.toContain('MESSAGE_SECRET');
    expect(payload).not.toContain('QUERY_SECRET');
    expect(payload).not.toContain('HEADER_SECRET');
    expect(payload).not.toContain('BODY_SECRET');
    expect(payload).not.toContain('"headers"');
    expect(payload).not.toContain('"data"');
  });

  it('does not retry scheduled refresh for profiles already marked reconnect-required', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 30_000,
    });
    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-health',
    });

    await coordinator.tickOnce();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not quota-bridge refresh cached reconnect-required credentials when forced', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    type QuotaRefreshCoordinator = Readonly<{
      refreshConnectedServiceCredentialForQuota?: (input: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
        force?: boolean;
      }>) => Promise<unknown>;
    }>;
    const quota = coordinator as unknown as QuotaRefreshCoordinator;
    expect(quota.refreshConnectedServiceCredentialForQuota).toEqual(expect.any(Function));

    await expect(quota.refreshConnectedServiceCredentialForQuota!({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns reconnect-required from runtime auth failure without forcing unhealthy credentials', async () => {
    const { coordinator, api, fetchMock } = createNeedsReauthRefreshHarness({
      expiresAt: 1_000_000 + 10 * 60_000,
    });
    type RuntimeAuthRefreshCoordinator = Readonly<{
      refreshConnectedServiceCredentialForRuntimeAuthFailure?: (input: Readonly<{
        serviceId: 'openai-codex';
        profileId: string;
      }>) => Promise<ConnectedServiceRefreshResultShape>;
    }>;
    type ConnectedServiceRefreshResultShape = Readonly<{
      status: string;
      diagnostic: Readonly<{
        reason: string;
        category?: string;
        providerErrorCode?: string | null;
      }>;
    }>;
    const runtimeAuth = coordinator as unknown as RuntimeAuthRefreshCoordinator;
    expect(runtimeAuth.refreshConnectedServiceCredentialForRuntimeAuthFailure).toEqual(expect.any(Function));

    const result = await runtimeAuth.refreshConnectedServiceCredentialForRuntimeAuthFailure!({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('refresh_failed');
    expect(result.diagnostic).toMatchObject({
      reason: 'runtime_auth_failure',
      category: 'invalid_grant',
      providerErrorCode: 'invalid_grant',
    });
    expect(api.listConnectedServiceProfiles).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues refreshing other bindings when one binding refresh fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const openaiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const geminiRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'g-old-access',
        refreshToken: 'g-old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const sealedByServiceId = new Map<string, string>();
    sealedByServiceId.set('openai-codex', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: openaiRecord,
      randomBytes: (length) => randomBytes(length),
    }));
    sealedByServiceId.set('gemini', sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: geminiRecord,
      randomBytes: (length) => randomBytes(length),
    }));

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string }) => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedByServiceId.get(params.serviceId)! },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: null, expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; sealed: { ciphertext: string } }) => {
        sealedByServiceId.set(params.serviceId, params.sealed.ciphertext);
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('auth.openai.com')) {
        return { ok: false, status: 500, statusText: 'fail', text: async () => 'boom' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'g-new-access',
          refresh_token: 'g-new-refresh',
          expires_in: 3600,
        }),
        text: async () => '',
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 1,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-openai',
    });
    coordinator.registerSpawnTarget({
      pid: 2,
      agentId: 'gemini',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { gemini: { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-gemini',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow();

    // Even though OpenAI refresh failed, Gemini should still have been refreshed and registered.
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'gemini' }));
  });

  it('singleflights concurrent refreshes for one credential and uses the daemon owner id for the lease', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-singleflight-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-singleflight-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      await fetchGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      } as any;
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:daemon-a',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const first = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    const second = coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual(['refreshed', 'refreshed']);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
    }));
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('does not satisfy a forced refresh from an in-flight non-forced not-needed refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-force-class-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-force-class-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });

    let releaseCredentialRead: () => void = () => {};
    const credentialReadReleased = new Promise<void>((resolve) => {
      releaseCredentialRead = resolve;
    });
    let resolveCredentialReadStarted: () => void = () => {};
    const credentialReadStarted = new Promise<void>((resolve) => {
      resolveCredentialReadStarted = resolve;
    });
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => {
        resolveCredentialReadStarted();
        await credentialReadReleased;
        return {
          sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
          metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10 * 60_000 },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'forced-access',
        refresh_token: 'forced-refresh',
        expires_in: 3600,
      }),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      activeServerDir,
      baseDir,
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-1',
    });

    const nonForced = coordinator.tickOnce();
    await credentialReadStarted;
    const forced = coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    });
    releaseCredentialRead();

    const [, forcedResult] = await Promise.all([nonForced, forced]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(forcedResult?.oauth?.accessToken).toBe('forced-access');
  });
});
