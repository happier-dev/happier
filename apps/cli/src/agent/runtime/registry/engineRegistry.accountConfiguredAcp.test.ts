import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  resolveBackendEngineAdapterResolution,
  resolveCliEngineRegistry,
} from './engineRegistry';

const mocks = vi.hoisted(() => ({
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: mocks.readStoredCredentials,
}));

function createCredentials(): Credentials {
  return {
    token: 'token-1',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

function createEmptyRegistry(): ResolvedContributionRegistry {
  return {
    agents: [],
        actions: [],
    resources: [],
    uiViewsV2: [],
    uiRenderersV2: [],
    uiTranslationsV2: [],
    activationTargets: [],
        catalogEntriesById: {},
    agentDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
  };
}

function setAccountConfiguredAcpBackend(options: Readonly<{
  savedSecret?: string;
}> = {}): void {
  setActiveAccountSettingsSnapshot({
    source: 'network',
    settings: accountSettingsParse({
      schemaVersion: 6,
      ...(options.savedSecret ? {
        secrets: [{
          id: 'secret-acp',
          name: 'ACP token',
          kind: 'token',
          encryptedValue: { _isSecretValue: true, value: options.savedSecret },
          createdAt: 1,
          updatedAt: 1,
        }],
      } : {}),
      acpCatalogSettingsV1: {
        v: 2,
        backends: [{
          id: 'account-configured-acp',
          name: 'account-configured-acp',
          title: 'Account Configured ACP',
          command: 'custom-acp',
          args: ['--stdio'],
          env: {
            ACP_TOKEN: options.savedSecret
              ? { t: 'savedSecret', secretId: 'secret-acp' }
              : { t: 'literal', v: 'token-from-settings' },
          },
          transportProfile: 'generic',
          capabilities: {
            supportsLoadSession: true,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'no',
          },
          createdAt: 1,
          updatedAt: 2,
        }],
      },
    }),
    settingsVersion: 1,
    loadedAtMs: 1,
    settingsSecretsReadKeys: [],
  });
}

describe('engineRegistry account-configured ACP ingestion', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readStoredCredentials.mockReset();
    mocks.readStoredCredentials.mockResolvedValue(createCredentials());
    setActiveAccountSettingsSnapshot({
      source: 'none',
      settings: accountSettingsParse({ schemaVersion: 6 }),
      settingsVersion: 0,
      loadedAtMs: 0,
      settingsSecretsReadKeys: [],
    });
  });

  it('ingests acpCatalogSettingsV1 backends into the engine registry and launches through the ACP runtimeCore', async () => {
    setAccountConfiguredAcpBackend();

    const registry = await resolveCliEngineRegistry({
      contributes: createEmptyRegistry(),
    });

    expect(registry.contributions).not.toHaveProperty('agentRuntimeDefinitionsById');
    const resolution = await registry.resolveForBackendId('account-configured-acp');
    expect(resolution?.backendId).toBe('account-configured-acp');
    expect(resolution?.agentId).toBe('acp:account-configured-acp');
    expect(resolution?.provenance).toBe('configured');
    expect(resolution?.selectedSource).toBe('configured');
    expect(resolution?.backend.source).toEqual({ kind: 'configured' });
    expect(resolution?.agent.source).toEqual({ kind: 'configured' });

    await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: { token: 'token-only', encryption: null },
      cwd: '/workspace',
    })).resolves.toMatchObject({
      kind: 'hostSessionRuntimePlan',
      agentId: 'account-configured-acp',
      config: expect.objectContaining({
        createSessionRuntime: expect.any(Function),
        policyAgentId: 'account-configured-acp',
      }),
    });

    expect(() => resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
      cwd: '/workspace',
      backendId: 'account-configured-acp',
      permissionMode: 'read_only',
      accountSettings: accountSettingsParse({}),
    })).not.toThrow();
  });

  it('resolves account-configured ACP backends through resolveBackendEngineAdapterResolution', async () => {
    setAccountConfiguredAcpBackend();

    await expect(resolveBackendEngineAdapterResolution('account-configured-acp', {
      contributes: createEmptyRegistry(),
    })).resolves.toMatchObject({
      backendId: 'account-configured-acp',
      agentId: 'acp:account-configured-acp',
    });
  });

  it('resolves a plaintext Saved Secret launch environment with token-only credentials', async () => {
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };
    mocks.readStoredCredentials.mockResolvedValue(credentials);
    setAccountConfiguredAcpBackend({ savedSecret: 'plain-runtime-secret' });

    await expect(resolveBackendEngineAdapterResolution('account-configured-acp', {
      contributes: createEmptyRegistry(),
    })).resolves.toMatchObject({
      backendId: 'account-configured-acp',
      engineAdapter: {
        runtimeCore: expect.any(Object),
      },
    });
    expect(mocks.readStoredCredentials).toHaveBeenCalled();
  });
});
