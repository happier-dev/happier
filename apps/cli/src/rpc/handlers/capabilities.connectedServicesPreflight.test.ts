import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

const envKeys = [
  'HAPPIER_CODEX_APP_SERVER_BIN',
  'HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS',
  'HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE',
  'HAPPIER_HOME_DIR',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
] as const;

let envScope = createEnvKeyScope(envKeys);
let tempDir: string | null = null;

afterEach(() => {
  vi.doUnmock('@/api/api');
  vi.doUnmock('@/persistence');
  vi.doUnmock('@/settings/accountSettings/bootstrapAccountSettingsContext');
  vi.resetModules();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('capabilities.invoke connected-service preflight', () => {
  it('materializes a selected Codex auth group through the canonical spawn resolver without a legacy stable home', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.HAPPIER_CODEX_APP_SERVER_BIN = fileURLToPath(
      new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url),
    );
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_DELAY_MS = '1';
    const captureFile = join(tempDir, 'captured-env.json');
    process.env.HAPPIER_FAKE_CODEX_APP_SERVER_ENV_CAPTURE_FILE = captureFile;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SQLITE_HOME;

    const credentials: Credentials = {
      token: 'test-happier-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    const credentialRecord = buildConnectedServiceCredentialRecord({
      now: 1_800_000_000_000,
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      kind: 'oauth',
      expiresAt: 1_900_000_000_000,
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
    const getConnectedServiceAuthGroup = vi.fn(async () => ({
      v: 1 as const,
      serviceId: 'openai-codex' as const,
      groupId: 'happier',
      activeProfileId: 'leeroy',
      generation: 1340,
      policy: { autoSwitch: true, strategy: 'priority' as const },
      members: [{ profileId: 'leeroy', enabled: true, priority: 0 }],
    }));
    const getConnectedServiceCredentialPlain = vi.fn(async () => ({
      content: { t: 'plain' as const, v: credentialRecord },
      revisionSemantics: 'legacy_unfenced' as const,
      credentialRevision: null,
    }));
    const updateConnectedServiceAuthGroupActiveProfile = vi.fn();
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceAuthGroup,
      getConnectedServiceCredentialPlain,
      updateConnectedServiceAuthGroupActiveProfile,
      listConnectedServiceProfiles: async () => ({
        serviceId: 'openai-codex' as const,
        profiles: [{ profileId: 'leeroy', status: 'healthy' as const }],
      }),
    } as unknown as ApiClient;

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readCredentials: vi.fn(async () => credentials),
    }));
    vi.doMock('@/api/api', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/api/api')>();
      return {
        ...actual,
        ApiClient: { create: vi.fn(async () => api) },
      };
    });
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: vi.fn(async () => ({
        settings: { codexBackendMode: 'appServer' },
      })),
    }));

    const { configuration, reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    const legacyGroupHome = join(
      configuration.activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'openai-codex',
      '__groups',
      'happier',
      'codex',
      'codex-home',
    );
    expect(existsSync(legacyGroupHome)).toBe(false);

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
        timeoutMs: 2_000,
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'leeroy',
            },
          },
        },
      },
    });

    expect(response).toMatchObject({ ok: true, result: { source: 'dynamic' } });
    expect(getConnectedServiceAuthGroup).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'happier',
    });
    expect(getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'leeroy',
    });
    expect(updateConnectedServiceAuthGroupActiveProfile).not.toHaveBeenCalled();
    const captured = JSON.parse(readFileSync(captureFile, 'utf8')) as Record<string, unknown>;
    expect(captured.CODEX_AUTH_FILE_PRESENT).toBe(true);
    const materializedBase = join(tempDir, 'daemon', 'connected-services', 'materialized');
    expect(relative(materializedBase, String(captured.CODEX_HOME))).not.toMatch(/^\.\.(?:[\\/]|$)/u);
    // Connected auth stays isolated while the default state-sharing policy keeps
    // Codex's SQLite/session state rooted in the configured native home.
    expect(relative(materializedBase, String(captured.CODEX_SQLITE_HOME))).toMatch(/^\.\.(?:[\\/]|$)/u);
    expect(String(captured.CODEX_HOME)).not.toBe(legacyGroupHome);
    expect(existsSync(String(captured.CODEX_HOME))).toBe(false);
  }, 90_000);

  it('fails closed instead of probing ambient auth when selected connected-service credentials are unavailable', async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'happier-capability-connected-preflight-no-credentials-'));
    process.env.HAPPIER_HOME_DIR = tempDir;
    process.env.OPENAI_API_KEY = 'ambient-key-must-not-be-used';

    vi.doMock('@/persistence', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/persistence')>()),
      readCredentials: vi.fn(async () => null),
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
              profileId: 'leeroy',
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
