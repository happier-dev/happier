import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
  computeClaudeSubscriptionAccessTokenFingerprint,
} from '@happier-dev/plugins-claude/agent/auth/services/cloud/refreshBridge';
import { writeClaudeCodeCredentialsFile } from '@happier-dev/plugins-claude/agent/auth/services/native/credentials';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceGroupHomeDir, resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import {
  classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh,
  ConnectedServiceRefreshCoordinator,
} from './ConnectedServiceRefreshCoordinator';

const {
  getConnectedServicesMaterializerOverride,
  getConnectedServiceMaterializedHomeFreshnessOverride,
} = vi.hoisted(() => ({
  getConnectedServicesMaterializerOverride: vi.fn(),
  getConnectedServiceMaterializedHomeFreshnessOverride: vi.fn(),
}));

vi.mock('@/daemon/connectedServices/catalogHooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/connectedServices/catalogHooks')>();
  return {
    ...actual,
    getConnectedServicesMaterializer: vi.fn(async (agentId: Parameters<typeof actual.getConnectedServicesMaterializer>[0]) => {
      const override = getConnectedServicesMaterializerOverride(agentId);
      if (override !== undefined) return override;
      return await actual.getConnectedServicesMaterializer(agentId);
    }),
    getConnectedServiceMaterializedHomeFreshness: vi.fn(async (agentId: Parameters<typeof actual.getConnectedServicesMaterializer>[0]) => {
      const override = getConnectedServiceMaterializedHomeFreshnessOverride(agentId);
      if (override !== undefined) return override;
      return await actual.getConnectedServiceMaterializedHomeFreshness(agentId);
    }),
  };
});

afterEach(() => {
  getConnectedServicesMaterializerOverride.mockReset();
  getConnectedServiceMaterializedHomeFreshnessOverride.mockReset();
});

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
  it('classifies materialization diagnostics without turning local runtime-home failures into provider 403', () => {
    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_missing_claude_code_scope',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_required_scope',
      credentialRefreshFailure: {
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      },
    })).toEqual({
      category: 'provider_403',
      providerStatus: 403,
      providerErrorCode: 'claude_subscription_missing_claude_code_scope',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'credential_file_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_access_token',
      credentialRefreshFailure: {
        category: 'missing_access_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_access_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_materialization_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'missing_refresh_token',
      credentialRefreshFailure: {
        category: 'missing_refresh_token',
        providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
      },
    })).toEqual({
      category: 'missing_refresh_token',
      providerErrorCode: 'claude_subscription_native_auth_materialization_failed',
    });

    expect(classifyConnectedServiceMaterializationDiagnosticForCredentialRefresh({
      code: 'claude_subscription_native_auth_keychain_write_failed',
      providerId: 'claude',
      severity: 'blocking',
      serviceId: 'claude-subscription',
      reason: 'keychain_write_failed',
    })).toEqual({
      category: 'unknown',
      providerErrorCode: 'claude_subscription_native_auth_keychain_write_failed',
    });
  });

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
      forceRefresh: true,
    })).resolves.toEqual({
      accessToken: 'bridge-new-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledTimes(1);
  });

  it('F6: returns the current Codex access token WITHOUT a rotation when not forced and the token is still valid', async () => {
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
      // Far from expiry (well outside the refresh window) so a non-forced refresh is not needed.
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'current-valid-access',
        refreshToken: 'current-refresh',
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
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 3_600_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn();
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

    const result = await coordinator.refreshOpenAiCodexChatGptTokensForBridge({
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
      chatgptPlanType: 'plus',
      forceRefresh: false,
    });

    expect(result).toEqual({
      accessToken: 'current-valid-access',
      chatgptAccountId: 'acct',
      chatgptPlanType: 'plus',
    });
    // No provider call, no lease, no rotation when the current token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialSealed).not.toHaveBeenCalled();
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

  it('rematerializes a stale Claude home when the store credential is still fresh but the home token differs', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-stale-claude-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-stale-claude-home-'));
    const materializationKey = 'session-claude-stale-home';
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'claude',
      materializationKey,
    });
    await mkdir(materializedRoot, { recursive: true });
    await writeFile(join(materializedRoot, '.credentials.json'), `${JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-home-access',
        expiresAt: 1_000_000 + 3_600_000,
        scopes: ['user:inference'],
      },
    })}\n`);

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
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
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
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CLAUDE_CONFIG_DIR: materializedRoot },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    getConnectedServicesMaterializerOverride.mockImplementation((agentId) =>
      agentId === 'claude' ? materializer : undefined,
    );
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
      materializationKey,
      sessionId: 'happy-session-1',
    });

    await coordinator.tickOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(materializer).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: expect.any(String),
      recordsByServiceId: expect.any(Map),
    }));
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'claude' })],
    }));
  });

  async function buildClaudeGroupHomeOwnershipHarness() {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-group-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-group-home-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-group-home-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const buildProfileRecord = (profileId: string, accessToken: string) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: now + 60 * 60_000,
      oauth: {
        accessToken,
        refreshToken: `${profileId}-refresh`,
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: `acct-${profileId}`,
        providerEmail: `${profileId}@example.test`,
      },
    });
    const sealedByProfileId = new Map<string, string>([
      ['workA', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: buildProfileRecord('workA', 'active-access'),
        randomBytes: (length) => randomBytes(length),
      })],
      ['workB', sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: credentials.encryption.secret },
        payload: buildProfileRecord('workB', 'member-access'),
        randomBytes: (length) => randomBytes(length),
      })],
    ]);
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (input: { profileId: string }) => {
        const ciphertext = sealedByProfileId.get(input.profileId);
        if (!ciphertext) return null;
        return {
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: {
            kind: 'oauth',
            providerEmail: `${input.profileId}@example.test`,
            providerAccountId: `acct-${input.profileId}`,
            expiresAt: now + 60 * 60_000,
          },
        };
      }),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'claude-subscription',
        groupId: 'pool',
        activeProfileId: 'workA',
        generation: 4,
      })),
    } as unknown as ApiClient;
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('store refresh should not run');
    }) as unknown as typeof fetch);

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
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });
    const selectionA = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workA',
      fallbackProfileId: 'workB',
      generation: 4,
      policy: null,
    };
    coordinator.registerSpawnTarget({
      pid: 127,
      agentId: 'claude',
      sessionId: 'happy-group-a',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'workA',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionA]),
      },
      materializationKey: 'session-claude-group-a',
    });
    const selectionB = {
      kind: 'group' as const,
      serviceId: 'claude-subscription' as const,
      groupId: 'pool',
      activeProfileId: 'workB',
      fallbackProfileId: 'workA',
      generation: 3,
      policy: null,
    };
    coordinator.registerSpawnTarget({
      pid: 128,
      agentId: 'claude',
      sessionId: 'happy-group-b',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'workB',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([selectionB]),
      },
      materializationKey: 'session-claude-group-b',
    });

    const groupConfigDir = join(resolveConnectedServiceGroupHomeDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'pool',
      agentId: 'claude',
    }), 'claude-config');

    return { coordinator, onAuthUpdated, groupConfigDir, now, api };
  }

  it('keeps a shared Claude group home stable across divergent-snapshot member sessions', async () => {
    const harness = await buildClaudeGroupHomeOwnershipHarness();
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'active-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    await harness.coordinator.tickOnce();
    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('repairs a stale shared Claude group home with the canonical active credential once', async () => {
    const harness = await buildClaudeGroupHomeOwnershipHarness();
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'dead-old-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('active-access');
    expect(harness.onAuthUpdated).toHaveBeenCalledTimes(1);

    harness.onAuthUpdated.mockClear();
    await harness.coordinator.tickOnce();
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('fails closed when canonical Claude group state is unreadable during stale-home repair', async () => {
    const harness = await buildClaudeGroupHomeOwnershipHarness();
    vi.mocked(harness.api.getConnectedServiceAuthGroup).mockRejectedValue(new Error('group reader unavailable'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: harness.groupConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'dead-old-access',
          expiresAt: harness.now + 60 * 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    await harness.coordinator.tickOnce();

    const credential = JSON.parse(await readFile(join(harness.groupConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('dead-old-access');
    expect(harness.onAuthUpdated).not.toHaveBeenCalled();
  });

  it('uses provider-owned materialized-home freshness checks instead of daemon service-specific logic', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-contributed-stale-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-contributed-stale-home-'));
    const materializationKey = 'session-codex-stale-home';

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
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
        idToken: null,
        scope: null,
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
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CODEX_HOME: join(baseDir, 'materialized') },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    const isMaterializedHomeStale = vi.fn(async () => true);
    getConnectedServicesMaterializerOverride.mockImplementation((agentId) =>
      agentId === 'codex' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale }
        : undefined,
    );
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
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey,
      sessionId: 'happy-session-1',
    });

    await coordinator.tickOnce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(isMaterializedHomeStale).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      materializedRootDir: join(resolveConnectedServiceHomeDir({
        activeServerDir,
        serviceId: 'openai-codex',
        profileId: 'work',
        agentId: 'codex',
      }), 'codex-home'),
      record: expect.objectContaining({
        kind: 'oauth',
        oauth: expect.objectContaining({ accessToken: 'fresh-store-access' }),
      }),
      now,
      refreshWindowMs: 60_000,
    });
    expect(materializer).toHaveBeenCalledWith(expect.objectContaining({
      rootDir: expect.any(String),
      recordsByServiceId: expect.any(Map),
    }));
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 123, agentId: 'codex' })],
    }));
  });

  it('repairs a stale materialized home once during spawn preflight when the store credential is fresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-stale-home-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-preflight-stale-home-'));
    const materializationKey = 'session-codex-preflight-stale-home';

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
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'fresh-store-access',
        refreshToken: 'fresh-store-refresh',
        idToken: null,
        scope: null,
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
    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: null,
          providerAccountId: 'acct',
          expiresAt: now + 3_600_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
    } as unknown as ApiClient;
    vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);
    const materializer = vi.fn(async () => ({
      env: { CODEX_HOME: join(baseDir, 'materialized') },
      diagnostics: [],
      cleanupOnFailure: true,
      cleanupOnExit: true,
    }));
    getConnectedServicesMaterializerOverride.mockImplementation((agentId) =>
      agentId === 'codex' ? materializer : undefined,
    );
    getConnectedServiceMaterializedHomeFreshnessOverride.mockImplementation((agentId) =>
      agentId === 'codex'
        ? { isMaterializedHomeStale: vi.fn(async () => true) }
        : undefined,
    );
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
      pid: 124,
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } },
      },
      materializationKey,
      sessionId: 'happy-session-preflight',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(result.status).toBe('not_needed');
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(materializer).toHaveBeenCalledTimes(1);
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 124, agentId: 'codex' })],
    }));
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
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'primary',
        generation: 2,
      })),
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

    const codexHome = join(resolveConnectedServiceGroupHomeDir({
      activeServerDir,
      serviceId: 'openai-codex',
      groupId: 'team',
      agentId: 'codex',
    }), 'codex-home');
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

  it('rematerializes active Claude homes after a runtime-auth forced refresh', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-'));

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
      // Far outside the scheduled refresh window: provider 401 proof must override source expiry.
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access',
        refresh_token: 'runtime-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

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
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('runtime-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile', 'user:sessions:claude_code']);
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 125, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
    });
  });

  it('distributes a spawn-preflight rotation to registered targets by construction (RR-1)', async () => {
    // A spawn-preflight refresh that ROTATES (the store credential is near expiry) must distribute the
    // fresh token to every already-registered target for the binding — not only when the caller
    // remembers to. This is the 13:27 murder-window shape: a sibling session holding the superseded
    // token after another entry point rotated it. Distribution belongs to the single 'refreshed'
    // completion path, so no rotation entry can leave a materialized target behind.
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-rotate-distribute-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-preflight-rotate-distribute-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-preflight-rotate-source-home-'));

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
      // Within the refresh window: a NON-forced spawn-preflight refresh rotates the single-use token.
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 30_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

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
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    // A sibling session already registered for the same binding — it must receive the rotated token
    // even though the spawn-preflight caller is a DIFFERENT (not-yet-registered) session.
    coordinator.registerSpawnTarget({
      pid: 321,
      agentId: 'claude',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-preflight-sibling',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'claude-subscription',
      profileId: 'work',
    });

    expect(result.status).toBe('refreshed');
    const stableConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'work',
      'claude',
      'claude-config',
    );
    const credential = JSON.parse(await readFile(join(stableConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('rotated-access');
    expect(onAuthUpdated).toHaveBeenCalledWith({
      binding: { serviceId: 'claude-subscription', profileId: 'work' },
      affectedTargets: [expect.objectContaining({ pid: 321, agentId: 'claude' })],
      trigger: 'refresh_triggered_restart',
    });
  });

  it('reports runtime-auth refresh as failed when the failing active Claude home cannot be rematerialized', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-remat-blocked-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-remat-blocked-'));
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-source-home-blocked-'));

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
      expiresAt: now + 10 * 60_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
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
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now + 10 * 60_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'runtime-access-without-claude-code',
        refresh_token: 'runtime-refresh',
        scope: 'user:inference user:profile',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

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
      processEnv: { HOME: sourceHomeDir },
      onAuthUpdated,
    });

    coordinator.registerSpawnTarget({
      pid: 125,
      agentId: 'claude',
      sessionId: 'sess_1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      sessionId: 'sess_1',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'claude-subscription',
        profileId: 'work',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'provider_403',
        providerStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    }));
    expect(onAuthUpdated).not.toHaveBeenCalled();
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'claude-subscription',
      profileId: 'work',
      health: expect.objectContaining({
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'claude_subscription_missing_claude_code_scope',
      }),
    });
  });

  it('reports runtime-auth refresh as failed when the requested live session has no registered rematerialization target', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-runtime-auth-missing-target-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-runtime-auth-missing-target-'));

    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    if (credentials.encryption.type !== 'legacy') throw new Error('fixture');

    const now = 1_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: now - 1_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: 'user@example.com',
      },
    });

    let sealedCiphertext = sealAccountScopedBlobCiphertext({
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
          providerEmail: 'user@example.com',
          providerAccountId: 'acct',
          expiresAt: now - 1_000,
        },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth,
    } as unknown as ApiClient;

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    })) as unknown as typeof fetch);

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
      pid: 125,
      agentId: 'codex',
      sessionId: 'sess_other',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'primary' } },
      },
      materializationKey: 'session-codex-runtime-refresh',
    });

    const result = await coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'openai-codex',
      profileId: 'primary',
      sessionId: 'sess_missing',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'refresh_failed',
      diagnostic: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'primary',
        reason: 'runtime_auth_failure',
        status: 'refresh_failed',
        category: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    }));
    // RR-1: the requested session (sess_missing) has no registered target, so its runtime-auth refresh
    // still reports failure — but the rotation is a single by-construction transaction, so the OTHER
    // registered sibling (sess_other) is rematerialized AND notified. It must not be left holding the
    // superseded token just because a different session's target was absent.
    expect(onAuthUpdated).toHaveBeenCalledWith(expect.objectContaining({
      binding: { serviceId: 'openai-codex', profileId: 'primary' },
      affectedTargets: [expect.objectContaining({ pid: 125, sessionId: 'sess_other' })],
      trigger: 'refresh_triggered_restart',
    }));
    expect(updateConnectedServiceCredentialHealth).toHaveBeenLastCalledWith({
      serviceId: 'openai-codex',
      profileId: 'primary',
      health: expect.objectContaining({
        v: 1,
        status: 'refresh_failed_retryable',
        reconnectRequired: false,
        lastRefreshFailureKind: 'unknown',
        providerErrorCode: 'runtime_auth_target_not_registered',
      }),
    });
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
    const backupRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'backup',
      kind: 'oauth',
      expiresAt: now + 30_000,
      oauth: {
        accessToken: 'backup-old-access',
        refreshToken: 'backup-old-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const sealedByServiceId = new Map<string, string>();
    const credentialKey = (serviceId: string, profileId: string) => `${serviceId}/${profileId}`;
    sealedByServiceId.set(credentialKey('openai-codex', 'work'), sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: openaiRecord,
      randomBytes: (length) => randomBytes(length),
    }));
    sealedByServiceId.set(credentialKey('openai-codex', 'backup'), sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: backupRecord,
      randomBytes: (length) => randomBytes(length),
    }));

    const api = {
      getConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string }) => ({
        sealed: { format: 'account_scoped_v1', ciphertext: sealedByServiceId.get(credentialKey(params.serviceId, params.profileId))! },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: null, expiresAt: now + 30_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { serviceId: string; profileId: string; sealed: { ciphertext: string } }) => {
        sealedByServiceId.set(credentialKey(params.serviceId, params.profileId), params.sealed.ciphertext);
      }),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async (input: any, init?: { body?: unknown }) => {
      const url = String(input);
      const refreshToken = init?.body instanceof URLSearchParams
        ? init.body.get('refresh_token')
        : typeof init?.body === 'string'
          ? new URLSearchParams(init.body).get('refresh_token')
          : null;
      if (url.includes('auth.openai.com') && refreshToken === 'old-refresh') {
        return { ok: false, status: 500, statusText: 'fail', text: async () => 'boom' } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'backup-new-access',
          refresh_token: 'backup-new-refresh',
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
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'backup' } },
      },
      materializationKey: 'session-openai-backup',
    });

    await expect(coordinator.tickOnce()).rejects.toThrow();

    // Even though one binding refresh failed, the other binding should still have been refreshed and registered.
    expect(api.registerConnectedServiceCredentialSealed).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'openai-codex',
      profileId: 'backup',
    }));
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

  it('coalesces post-refresh rematerialization and auth-updated restart notification per binding', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-refresh-coalesce-remat-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-refresh-coalesce-remat-'));

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
      expiresAt: now + 10_000,
      oauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        idToken: null,
        scope: 'user:inference user:profile user:sessions:claude_code',
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
        sealed: { format: 'account_scoped_v1' as const, ciphertext: sealedCiphertext },
        metadata: { kind: 'oauth', providerEmail: null, providerAccountId: 'acct', expiresAt: now + 10_000 },
      })),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialSealed: vi.fn(async (params: { sealed: { ciphertext: string } }) => {
        sealedCiphertext = params.sealed.ciphertext;
      }),
      updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 'user:inference user:profile user:sessions:claude_code',
          expires_in: 3600,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    let materializerCalls = 0;
    let releaseFirstMaterialization: () => void = () => {};
    const firstMaterializationStarted = new Promise<void>((resolve) => {
      getConnectedServicesMaterializerOverride.mockImplementation(() => async (params: Readonly<{ rootDir: string }>) => {
        materializerCalls += 1;
        const callNumber = materializerCalls;
        await mkdir(params.rootDir, { recursive: true });
        if (callNumber === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstMaterialization = release;
          });
        }
        await writeFile(join(params.rootDir, 'materialized.txt'), `${callNumber}\n`, 'utf8');
        return {
          env: { MATERIALIZED_ROOT: params.rootDir },
          targetMaterializedRoot: params.rootDir,
          cleanupOnFailure: null,
          cleanupOnExit: null,
        };
      });
    });
    let releaseAuthNotification: () => void = () => {};
    const authNotificationReleased = new Promise<void>((resolve) => {
      releaseAuthNotification = resolve;
    });
    const onAuthUpdated = vi.fn(async () => {
      await authNotificationReleased;
    });
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
      sessionId: 'sess_1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: { 'claude-subscription': { source: 'connected', profileId: 'work' } },
      },
      materializationKey: 'session-claude-refresh-race',
    });

    const scheduled = coordinator.tickOnce();
    const forced = coordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
      serviceId: 'claude-subscription',
      profileId: 'work',
      sessionId: 'sess_1',
    });

    await firstMaterializationStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirstMaterialization();
    await vi.waitFor(() => expect(onAuthUpdated).toHaveBeenCalledTimes(1));
    releaseAuthNotification();

    const [, forcedResult] = await Promise.all([scheduled, forced]);

    expect(forcedResult.status).toBe('refreshed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.acquireConnectedServiceRefreshLease).toHaveBeenCalledTimes(1);
    expect(materializerCalls).toBe(1);
    expect(onAuthUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectedServiceRefreshCoordinator Claude subscription bridge', () => {
  it('returns a setup-token credential as-is without refreshing (access-only, no rotation)', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: { token: 'sk-ant-oat01-setup-secret', providerAccountId: 'anthropic-acct', providerEmail: null },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-setup',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'setup' },
    });

    expect(result).toEqual({
      accessToken: 'sk-ant-oat01-setup-secret',
      anthropicAccountId: 'anthropic-acct',
      expiresAt: null,
    });
    // Setup-tokens are non-rotating: no refresh request is made.
    expect(fetchMock).not.toHaveBeenCalled();
    // Access-only response carries no refresh token.
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('refreshes an OAuth credential and returns the rotated access token only (refresh stays in the store)', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    let record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: now + 1_000,
      oauth: {
        accessToken: 'old-claude-access',
        refreshToken: 'old-claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'rotated-claude-access',
        refresh_token: 'rotated-claude-refresh',
        expires_in: 3600,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async (params: { content: { v: typeof record } }) => {
        record = params.content.v;
      }),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
    });

    expect(result.accessToken).toBe('rotated-claude-access');
    expect(result.anthropicAccountId).toBe('claude-acct');
    // No refresh token in the bridge response.
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('rotated-claude-refresh');
    expect(JSON.stringify(result)).not.toContain('old-claude-refresh');
    // The rotated refresh token is persisted in the store (never returned).
    expect(api.registerConnectedServiceCredentialPlain).toHaveBeenCalledTimes(1);
    expect(record.oauth?.refreshToken).toBe('rotated-claude-refresh');
  });

  it('adopts a fresh stored Claude OAuth access token before forced bridge rotation when the failed token differs', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'store-already-rotated-access',
        refreshToken: 'store-current-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const failingAccessTokenFingerprint = computeClaudeSubscriptionAccessTokenFingerprint('old-failed-access');
    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      forceRefresh: true,
      shouldAdoptCurrentAccessToken: (accessToken) =>
        computeClaudeSubscriptionAccessTokenFingerprint(accessToken) !== failingAccessTokenFingerprint,
    });

    expect(result.accessToken).toBe('store-already-rotated-access');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
  });

  it('F6: returns the current Claude OAuth access token WITHOUT a rotation when not forced and the token is still valid', async () => {
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    const now = 2_000_000;
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      // Far from expiry so a non-forced refresh returns the current token without rotating.
      expiresAt: now + 3_600_000,
      oauth: {
        accessToken: 'current-valid-claude-access',
        refreshToken: 'current-claude-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'claude-acct',
        providerEmail: null,
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain'),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({ acquired: true, leaseUntil: now + 60_000 })),
      registerConnectedServiceCredentialPlain: vi.fn(async () => {}),
    } as unknown as ApiClient;

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-claude-oauth',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
    });

    const result = await coordinator.refreshClaudeSubscriptionTokensForBridge({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'oauth' },
      forceRefresh: false,
    });

    expect(result.accessToken).toBe('current-valid-claude-access');
    expect(result.anthropicAccountId).toBe('claude-acct');
    expect(result.expiresAt).toBe(now + 3_600_000);
    // No provider call, no lease, no rotation when the current token is still valid.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    // No refresh token in the bridge response.
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toContain('current-claude-refresh');
  });
});
