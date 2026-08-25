import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';

const originalEnv = { ...process.env };
let tempDir: string | null = null;

afterEach(() => {
  vi.doUnmock('@/persistence');
  vi.doUnmock('@/settings/accountSettings/bootstrapAccountSettingsContext');
  vi.resetModules();
  process.env = { ...originalEnv };
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('capabilities.invoke connected-service preflight', () => {
  it('materializes the authoritative Codex group selection before the provider probe', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-'));
    const fixture = fileURLToPath(new URL('./__fixtures__/fakeCodexPreflightAppServer.mjs', import.meta.url));
    chmodSync(fixture, 0o755);
    const captureFile = join(tempDir, 'captured-env.json');
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      HAPPIER_CODEX_PATH: fixture,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      CODEX_HOME: undefined,
      CODEX_SQLITE_HOME: undefined,
    };

    const credentials: StoredCredentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const record = buildConnectedServiceCredentialRecord({
      now: 1_800_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'selected-access-token',
        refreshToken: 'selected-refresh-token',
        idToken: null,
        scope: null,
        tokenType: 'Bearer',
        providerAccountId: 'acct_selected',
        providerEmail: null,
      },
    });
    if (credentials.encryption.type !== 'legacy') throw new Error('test expects legacy credentials');
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: credentials.encryption.secret },
      payload: record,
      randomBytes: (length) => randomBytes(length),
    });
    const getConnectedServiceCredentialSealed = vi.fn(async () => ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      sealed: { format: 'account_scoped_v1' as const, ciphertext },
      metadata: {
        kind: 'oauth' as const,
        providerEmail: null,
        providerAccountId: 'acct_selected',
        expiresAt: null,
      },
    }));
    const api = {
      getServerFeaturesSnapshot: async () => undefined,
      getAccountEncryptionMode: async () => 'e2ee' as const,
      getConnectedServiceCredentialSealed,
      listConnectedServiceProfiles: async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'leeroy', status: 'connected' as const }],
      }),
    } as unknown as ApiClient;

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => credentials),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        settings: { codexBackendMode: 'appServer' },
      })),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager, {
        createApiClient: async () => api,
      } as never),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probePassiveRealtimeSetup',
      params: {
        cwd: tempDir,
        timeoutMs: 5_000,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toEqual({ ok: true, result: { v: 1, status: 'ready' } });
    expect(getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'leeroy',
    });
    const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
    expect(captured.CODEX_HOME).toEqual(expect.any(String));
    const methods = JSON.parse(readFileSync(join(tempDir, 'captured-methods.json'), 'utf8')) as string[];
    expect(methods).toEqual(['initialize', 'account/read', 'experimentalFeature/list']);
    expect(methods.some((method) => method.startsWith('thread/') || method.startsWith('realtime/'))).toBe(false);
  }, 90_000);

  it('fails closed instead of probing ambient auth when selected credentials are unavailable', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-no-credentials-'));
    process.env = {
      ...originalEnv,
      HAPPIER_HOME_DIR: tempDir,
      OPENAI_API_KEY: 'ambient-key-must-not-be-used',
    };
    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readStoredCredentials: vi.fn(async () => null),
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => null),
    }));

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');
    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: {
        cwd: tempDir,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
            },
          },
        },
      },
    });

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'connected-service-preflight-failed',
        message: 'Could not prepare the selected connected-service account for this probe.',
      },
    });
  }, 90_000);
});
