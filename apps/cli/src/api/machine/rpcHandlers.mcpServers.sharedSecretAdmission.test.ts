import axios from 'axios';
import {
  AccountSettingsSchema,
  formatSavedSecretCatalogReferenceV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';

import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';

// Only true boundaries are simulated: the Home HTTP transport, the stored
// credential file and the Home features read. The catalog refresh, its
// admission decision and the MCP materializer all run for real.
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), isAxiosError: () => false } }));
const persistence = vi.hoisted(() => ({ readStoredCredentials: vi.fn() }));
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: persistence.readStoredCredentials,
}));
vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: vi.fn(async () => ({
    status: 'ready' as const,
    features: {
      features: { teams: { enabled: true, credentialResources: { enabled: true } } },
      capabilities: {},
    },
  })),
}));

describe('rpcHandlers.mcpServers (shared Saved Secret admission)', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    vi.mocked(axios.get).mockReset();
  });
  afterEach(() => {
    resetInMemoryAccountSettingsContextForTests();
  });

  it('refuses a Machine MCP Test whose shared secret the Home revoked after a missed change hint', async () => {
    const token = 'account-token';
    const resourceId = 'resource-revoked';
    const ref = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: resourceId });
    const staleResource = {
      resourceId,
      ownerAccountId: 'owner-account',
      displayName: 'Revoked key',
      kind: 'apiKey' as const,
      encryptionMode: 'plain' as const,
      revision: 4,
      storedContent: sealSavedSecretResourceStoredContentV1({
        resourceId,
        mode: 'plain',
        content: { v: 1, name: 'Revoked key', kind: 'apiKey', value: 'stale-value' },
      }),
      materialStatus: 'ready' as const,
    };
    const settings = AccountSettingsSchema.parse({});
    // The daemon's hydrated snapshot still holds the row: the revocation's
    // AccountChange never arrived.
    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token),
      savedSecretCatalogState: 'ready',
      savedSecretResources: [staleResource],
    });
    persistence.readStoredCredentials.mockResolvedValue({ token, encryption: null });
    // The Home's current authorized answer no longer contains the resource.
    let observedRevokedCatalog = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/saved-secrets/resources/materials') {
        observedRevokedCatalog = true;
        return { status: 200, data: { resources: [] } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
      } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      // Unrelated optional history maintenance is unavailable in this fixture.
      throw new Error(`History transport unavailable: ${path}`);
    });
    const probeMcpStdioServerTools = vi.fn(async () => [{ name: 'echo' }]);
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();

    registerMachineMcpServersRpcHandlers({
      rpcHandlerManager: {
        registerHandler: (method: string, handler: (raw: unknown) => Promise<unknown>) => {
          handlers.set(method, handler);
        },
      } as never,
      deps: {
        readCredentials: async () => ({ token, encryption: null }),
        bootstrapAccountSettingsContext: input => bootstrapAccountSettingsContext({ ...input,
          honorAccountSettingsModeEnv: false, deps: { resolveCachePath: resolveAccountSettingsCachePath,
            readCache: async () => null, writeCache: async () => undefined,
            fetchFromServer: async () => ({ settingsVersion: 1, settingsContent: { t: 'plain', v: {} } }),
          },
        }),
        probeMcpStdioServerTools,
      },
    });

    const out = await handlers.get(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)!({
      t: 'draft',
      machineId: 'm1',
      directory: '/',
      server: {
        id: 'srv_remote',
        name: 'remote_fixture',
        transport: 'http',
        remote: {
          url: 'https://mcp.example.com',
          headers: { Authorization: { t: 'savedSecret', secretId: ref } },
        },
        env: {},
        createdAt: 1,
        updatedAt: 1,
      },
      binding: null,
    });

    expect(out).toMatchObject({ ok: false, errorCode: 'materialization_failed' });
    // The revoked value never reached the MCP server.
    expect(probeMcpStdioServerTools).not.toHaveBeenCalled();
    expect(observedRevokedCatalog).toBe(true);
  });
});
