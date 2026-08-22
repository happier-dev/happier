import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createConfiguredAcpBackendMock,
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
  materializeConfiguredAcpEnvironmentMock,
} = vi.hoisted(() => ({
  createConfiguredAcpBackendMock: vi.fn(),
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock: vi.fn(),
  materializeConfiguredAcpEnvironmentMock: vi.fn(),
}));

vi.mock('@/agent/acp/catalog/configured/createConfiguredAcpBackend', () => ({
  createConfiguredAcpBackend: createConfiguredAcpBackendMock,
}));

vi.mock('@/agent/acp/catalog/configured/resolveBackend', () => ({
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins: resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
}));

vi.mock('@/agent/acp/catalog/configured/materializeEnvironment', () => ({
  materializeConfiguredAcpEnvironment: materializeConfiguredAcpEnvironmentMock,
}));

import { createConfiguredAcpProbeBackend } from './configuredAcpProbeBackend';

describe('createConfiguredAcpProbeBackend', () => {
  beforeEach(() => {
    createConfiguredAcpBackendMock.mockReset();
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockReset();
    materializeConfiguredAcpEnvironmentMock.mockReset();
  });

  it('creates a probe backend for literal-env configured ACP targets without account credentials', async () => {
    const backend = { dispose: vi.fn(async () => undefined) };
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
      backendId: 'plugin-review-bot',
      name: 'plugin-review-bot',
      title: 'Plugin Review Bot',
      command: 'plugin-acp-cli',
      args: ['acp'],
      env: {
        ACP_REGION: { t: 'literal', v: 'eu' },
      },
      transportProfile: 'generic',
      capabilities: {},
    });
    createConfiguredAcpBackendMock.mockReturnValue(backend);

    await expect(
      createConfiguredAcpProbeBackend({
        agentId: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-review-bot' },
        cwd: '/repo',
        credentials: { token: 'token-only', encryption: null },
      }),
    ).resolves.toBe(backend);

    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith({
      settings: {},
      backendId: 'plugin-review-bot',
      happyHomeDir: expect.any(String),
    });
    expect(materializeConfiguredAcpEnvironmentMock).not.toHaveBeenCalled();
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      launchEnv: {
        ACP_REGION: 'eu',
      },
    }));
  });

  it('materializes saved-secret environment for token-only plaintext account settings', async () => {
    const backend = { dispose: vi.fn(async () => undefined) };
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
      backendId: 'plugin-review-bot',
      name: 'plugin-review-bot',
      title: 'Plugin Review Bot',
      command: 'plugin-acp-cli',
      args: ['acp'],
      env: {
        ACP_TOKEN: { t: 'savedSecret', secretId: 'secret-1' },
      },
      transportProfile: 'generic',
      capabilities: {},
    });
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({
      ACP_TOKEN: 'plain-account-secret',
    });
    createConfiguredAcpBackendMock.mockReturnValue(backend);

    await expect(
      createConfiguredAcpProbeBackend({
        agentId: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-review-bot' },
        cwd: '/repo',
        accountSettings: { connectedServices: {} },
        credentials: { token: 'token-only', encryption: null },
      }),
    ).resolves.toBe(backend);

    expect(materializeConfiguredAcpEnvironmentMock).toHaveBeenCalledWith({
      backend: expect.objectContaining({ backendId: 'plugin-review-bot' }),
      accountSettings: { connectedServices: {} },
      credentials: { token: 'token-only', encryption: null },
    });
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      launchEnv: { ACP_TOKEN: 'plain-account-secret' },
    }));
  });

  it('does not materialize a saved-secret environment when credentials are unavailable', async () => {
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
      backendId: 'plugin-review-bot',
      name: 'plugin-review-bot',
      title: 'Plugin Review Bot',
      command: 'plugin-acp-cli',
      args: ['acp'],
      env: {
        ACP_TOKEN: { t: 'savedSecret', secretId: 'secret-1' },
      },
      transportProfile: 'generic',
      capabilities: {},
    });

    await expect(
      createConfiguredAcpProbeBackend({
        agentId: 'customAcp',
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-review-bot' },
        cwd: '/repo',
        accountSettings: { connectedServices: {} },
      }),
    ).resolves.toBeNull();

    expect(materializeConfiguredAcpEnvironmentMock).not.toHaveBeenCalled();
    expect(createConfiguredAcpBackendMock).not.toHaveBeenCalled();
  });
});
