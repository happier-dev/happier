import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createConfiguredAcpBackendMock,
  resolveConfiguredAcpBackendFromAccountSettingsMock,
  materializeConfiguredAcpEnvironmentMock,
} = vi.hoisted(() => ({
  createConfiguredAcpBackendMock: vi.fn(),
  resolveConfiguredAcpBackendFromAccountSettingsMock: vi.fn(),
  materializeConfiguredAcpEnvironmentMock: vi.fn(),
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

import { probeAgentModesBestEffort } from './agentModesProbe';

describe('probeAgentModesBestEffort (configured ACP backend)', () => {
  beforeEach(() => {
    createConfiguredAcpBackendMock.mockReset();
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReset();
    materializeConfiguredAcpEnvironmentMock.mockReset();
  });

  it('uses the configured ACP backend backend for dynamic mode probing', async () => {
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
      getSessionModeState: () => ({
        availableModes: [{ id: 'plan', name: 'Plan' }],
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

    const result = await probeAgentModesBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo',
      timeoutMs: 100,
      accountSettings: { acpCatalogSettingsV1: { v: 2, backends: [] } },
      credentials,
    });

    expect(result.source).toBe('dynamic');
    expect(result.provider).toBe('customAcp');
    expect(result.availableModes).toEqual([{ id: 'plan', name: 'Plan' }]);
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      launchEnv: { API_TOKEN: 'secret' },
      backend: expect.objectContaining({ backendId: 'custom-backend' }),
    }));
    expect(dispose).toHaveBeenCalled();
  });

  it('invalidates the configured ACP mode probe cache when backend settings change', async () => {
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
        defaultMode: backend.defaultMode,
      };
    });
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ API_TOKEN: 'secret' });

    createConfiguredAcpBackendMock.mockImplementation(({ backend }: any) => ({
      startSession: async () => ({ sessionId: 'sess-1' }),
      getSessionModeState: () => ({
        availableModes: [{
          id: backend.command === 'custom-cli-v2' ? 'plan' : 'chat',
          name: backend.command === 'custom-cli-v2' ? 'Plan' : 'Chat',
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

    const first = await probeAgentModesBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo/cache-invalidation-modes',
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
            defaultMode: 'chat',
          }],
        },
      },
      credentials,
    });

    const second = await probeAgentModesBestEffort({
      agentId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      cwd: '/repo/cache-invalidation-modes',
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
            defaultMode: 'plan',
          }],
        },
      },
      credentials,
    });

    expect(first.availableModes).toEqual([{ id: 'chat', name: 'Chat' }]);
    expect(second.availableModes).toEqual([{ id: 'plan', name: 'Plan' }]);
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledTimes(2);
  });
});
