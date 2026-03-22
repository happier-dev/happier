import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCatalogAcpBackendMock,
  createConfiguredAcpBackendMock,
  resolveConfiguredAcpBackendFromAccountSettingsMock,
  materializeConfiguredAcpEnvironmentMock,
} = vi.hoisted(() => ({
  createCatalogAcpBackendMock: vi.fn(),
  createConfiguredAcpBackendMock: vi.fn(),
  resolveConfiguredAcpBackendFromAccountSettingsMock: vi.fn(),
  materializeConfiguredAcpEnvironmentMock: vi.fn(),
}));

vi.mock('@/agent/acp/createCatalogAcpBackend', () => ({
  createCatalogAcpBackend: createCatalogAcpBackendMock,
}));

vi.mock('@/agent/acp/catalog/configured/createConfiguredAcpBackend', () => ({
  createConfiguredAcpBackend: createConfiguredAcpBackendMock,
}));

vi.mock('@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings', () => ({
  resolveConfiguredAcpBackendFromAccountSettings: resolveConfiguredAcpBackendFromAccountSettingsMock,
}));

vi.mock('@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment', () => ({
  materializeConfiguredAcpEnvironment: materializeConfiguredAcpEnvironmentMock,
}));

import { probeAgentModelsBestEffort } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (configured ACP backend)', () => {
  beforeEach(() => {
    createCatalogAcpBackendMock.mockReset();
    createConfiguredAcpBackendMock.mockReset();
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReset();
    materializeConfiguredAcpEnvironmentMock.mockReset();
  });

  it('uses the configured ACP backend backend instead of the built-in catalog backend', async () => {
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
      backendId: 'custom-backend',
      name: 'review-bot',
      title: 'Review Bot',
      command: 'custom-cli',
      args: ['acp'],
      env: {},
      transportProfile: 'generic',
      capabilities: {},
    });
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ API_TOKEN: 'secret' });

    const dispose = vi.fn(async () => undefined);
    createConfiguredAcpBackendMock.mockReturnValue({
      startSession: async () => ({ sessionId: 'sess-1' }),
      getSessionModelState: () => ({
        availableModels: [{ id: 'model-a', name: 'Model A' }],
      }),
      getSessionConfigOptionsState: () => null,
      dispose,
    });

    const credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(1),
        machineKey: new Uint8Array(32).fill(2),
      },
    };

    const result = await probeAgentModelsBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo',
      timeoutMs: 100,
      accountSettings: { acpCatalogSettingsV1: { v: 2, backends: [] } },
      credentials,
    });

    expect(result.source).toBe('dynamic');
    expect(result.provider).toBe('customAcp');
    expect(result.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'model-a', name: 'Model A' },
    ]);
    expect(resolveConfiguredAcpBackendFromAccountSettingsMock).toHaveBeenCalledWith(
      { acpCatalogSettingsV1: { v: 2, backends: [] } },
      'review-bot',
    );
    expect(materializeConfiguredAcpEnvironmentMock).toHaveBeenCalled();
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      launchEnv: { API_TOKEN: 'secret' },
      backend: expect.objectContaining({ backendId: 'custom-backend' }),
    }));
    expect(createCatalogAcpBackendMock).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
  });

  it('invalidates the configured ACP model probe cache when backend settings change', async () => {
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockImplementation((settings: any) => {
      const backend = settings.acpCatalogSettingsV1.backends[0];
      return {
        backendId: 'custom-backend',
        name: backend.name,
        title: backend.title,
        command: backend.command,
        args: backend.args,
        env: backend.env,
        transportProfile: backend.transportProfile,
        capabilities: backend.capabilities,
        defaultModel: backend.defaultModel,
      };
    });
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ API_TOKEN: 'secret' });

    createConfiguredAcpBackendMock.mockImplementation(({ backend }: any) => ({
      startSession: async () => ({ sessionId: 'sess-1' }),
      getSessionModelState: () => ({
        availableModels: [{
          id: backend.command === 'custom-cli-v2' ? 'model-b' : 'model-a',
          name: backend.command === 'custom-cli-v2' ? 'Model B' : 'Model A',
        }],
      }),
      getSessionConfigOptionsState: () => null,
      dispose: vi.fn(async () => undefined),
    }));

    const credentials = {
      token: 'token',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(1),
        machineKey: new Uint8Array(32).fill(2),
      },
    };

    const first = await probeAgentModelsBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo/cache-invalidation-models',
      timeoutMs: 100,
      accountSettings: {
        acpCatalogSettingsV1: {
          v: 2,
          backends: [{
            id: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'custom-cli-v1',
            args: ['acp'],
            env: {},
            transportProfile: 'generic',
            capabilities: {},
            defaultModel: 'model-a',
          }],
        },
      },
      credentials,
    });

    const second = await probeAgentModelsBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo/cache-invalidation-models',
      timeoutMs: 100,
      accountSettings: {
        acpCatalogSettingsV1: {
          v: 2,
          backends: [{
            id: 'review-bot',
            name: 'review-bot',
            title: 'Review Bot',
            command: 'custom-cli-v2',
            args: ['acp'],
            env: {},
            transportProfile: 'generic',
            capabilities: {},
            defaultModel: 'model-b',
          }],
        },
      },
      credentials,
    });

    expect(first.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'model-a', name: 'Model A' },
    ]);
    expect(second.availableModels).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'model-b', name: 'Model B' },
    ]);
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledTimes(2);
  });
});
