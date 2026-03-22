import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';

const createConfiguredAcpBackendMock = vi.fn();
const materializeConfiguredAcpEnvironmentMock = vi.fn();
const resolveConfiguredAcpBackendFromAccountSettingsMock = vi.fn();
const readCredentialsMock = vi.fn();
const readSettingsMock = vi.fn();
const bootstrapAccountSettingsContextMock = vi.fn();
const resolveCustomHappierToolsContextMock = vi.fn();

vi.mock('@/agent/acp/catalog/configured/createConfiguredAcpBackend', () => ({
  createConfiguredAcpBackend: createConfiguredAcpBackendMock,
}));

vi.mock('@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment', () => ({
  materializeConfiguredAcpEnvironment: materializeConfiguredAcpEnvironmentMock,
}));

vi.mock('@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings', () => ({
  resolveConfiguredAcpBackendFromAccountSettings: resolveConfiguredAcpBackendFromAccountSettingsMock,
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
  readSettings: readSettingsMock,
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
}));

vi.mock('@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext', () => ({
  resolveCustomHappierToolsContext: resolveCustomHappierToolsContextMock,
}));

function createStubBackend(): AgentBackend {
  let handler: AgentMessageHandler | null = null;
  return {
    async startSession() {
      return { sessionId: 'configured-session-1' as SessionId };
    },
    async sendPrompt() {
      handler?.({ type: 'model-output', fullText: 'configured ok' });
    },
    async cancel() {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  };
}

describe('createExecutionRunBackend (configured ACP)', () => {
  beforeEach(() => {
    createConfiguredAcpBackendMock.mockReset();
    materializeConfiguredAcpEnvironmentMock.mockReset();
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReset();
    readCredentialsMock.mockReset();
    readSettingsMock.mockReset();
    bootstrapAccountSettingsContextMock.mockReset();
    resolveCustomHappierToolsContextMock.mockReset();
  });

  it('materializes the configured ACP backend when the execution run targets one', async () => {
    const backend = createStubBackend();
    createConfiguredAcpBackendMock.mockReturnValue(backend);
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
      backendId: 'review-bot',
      name: 'review-bot',
      title: 'Review Bot',
      command: 'review-bot',
      args: ['--stdio'],
      env: {},
      transportProfile: { kind: 'stdio' },
      capabilities: {},
      defaultModel: 'review-model',
    });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    bootstrapAccountSettingsContextMock.mockResolvedValue({
      settings: {
        acpCatalog: {
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-bot',
              args: ['--stdio'],
              env: {},
              capabilities: {},
              transportProfile: { kind: 'stdio' },
            },
          ],
        },
      },
    });
    resolveCustomHappierToolsContextMock.mockResolvedValue({
      mcpServers: {
        github: { command: 'github-mcp', args: ['--stdio'] },
      },
    });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');

    const configuredBackend = createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      modelId: 'override-model',
    });

    await expect(configuredBackend.startSession()).resolves.toEqual({ sessionId: 'configured-session-1' });
    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(bootstrapAccountSettingsContextMock).toHaveBeenCalledWith({
      credentials: { token: 'cred-1' },
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    });
    expect(resolveConfiguredAcpBackendFromAccountSettingsMock).toHaveBeenCalledWith(
      {
        acpCatalog: {
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-bot',
              args: ['--stdio'],
              env: {},
              capabilities: {},
              transportProfile: { kind: 'stdio' },
            },
          ],
        },
      },
      'review-bot',
    );
    expect(materializeConfiguredAcpEnvironmentMock).toHaveBeenCalledWith({
      backend: expect.objectContaining({ backendId: 'review-bot' }),
      accountSettings: {
        acpCatalog: {
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-bot',
              args: ['--stdio'],
              env: {},
              capabilities: {},
              transportProfile: { kind: 'stdio' },
            },
          ],
        },
      },
      credentials: { token: 'cred-1' },
    });
    expect(resolveCustomHappierToolsContextMock).toHaveBeenCalledWith({
      credentials: { token: 'cred-1' },
      accountSettings: {
        acpCatalog: {
          backends: [
            {
              id: 'review-bot',
              name: 'review-bot',
              title: 'Review Bot',
              command: 'review-bot',
              args: ['--stdio'],
              env: {},
              capabilities: {},
              transportProfile: { kind: 'stdio' },
            },
          ],
        },
      },
      machineId: 'machine-1',
      directory: '/tmp/workspace',
    });
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith({
      cwd: '/tmp/workspace',
      backend: expect.objectContaining({ backendId: 'review-bot' }),
      launchEnv: { ACP_TOKEN: 'token-1' },
      mcpServers: {
        github: { command: 'github-mcp', args: ['--stdio'] },
      },
      permissionHandler: expect.any(Object),
    });
  });

  it('does not advertise resumability before the configured ACP backend proves it', async () => {
    const backend = createStubBackend();
    createConfiguredAcpBackendMock.mockReturnValue(backend);
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
      backendId: 'review-bot',
      name: 'review-bot',
      title: 'Review Bot',
      command: 'review-bot',
      args: ['--stdio'],
      env: {},
      transportProfile: { kind: 'stdio' },
      capabilities: {},
    });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
    resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    const configuredBackend = createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
    }) as AgentBackend & { loadSession?: unknown; loadSessionWithReplayCapture?: unknown };

    expect(configuredBackend.loadSession).toBeUndefined();
    expect(configuredBackend.loadSessionWithReplayCapture).toBeUndefined();
  });

  it('rejects disabled configured ACP backends when account settings are passed directly', async () => {
    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    expect(() => createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
      accountSettings: {
        backendEnabledByTargetKey: {
          'acpBackend:review-bot': false,
        },
      },
    })).toThrow(/review-bot/i);
  });

  it('rejects disabled configured ACP backends after bootstrapping account settings for the lazy path', async () => {
    bootstrapAccountSettingsContextMock.mockResolvedValue({
      settings: {
        backendEnabledByTargetKey: {
          'acpBackend:review-bot': false,
        },
      },
    });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    const backend = createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
    });

    await expect(backend.startSession()).rejects.toThrow(/review-bot/i);
    expect(createConfiguredAcpBackendMock).not.toHaveBeenCalled();
  });

  it('registers queued onMessage handlers only once when the lazy backend resolves', async () => {
    const onMessage = vi.fn();
    const backend = createStubBackend();
    backend.onMessage = onMessage;
    createConfiguredAcpBackendMock.mockReturnValue(backend);
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ ACP_TOKEN: 'token-1' });
    resolveConfiguredAcpBackendFromAccountSettingsMock.mockReturnValue({
      backendId: 'review-bot',
      name: 'review-bot',
      title: 'Review Bot',
      command: 'review-bot',
      args: ['--stdio'],
      env: {},
      transportProfile: { kind: 'stdio' },
      capabilities: {},
    });
    readCredentialsMock.mockResolvedValue({ token: 'cred-1' });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    bootstrapAccountSettingsContextMock.mockResolvedValue({ settings: { acpCatalog: { backends: [] } } });
    resolveCustomHappierToolsContextMock.mockResolvedValue({ mcpServers: {} });

    const { createExecutionRunBackend } = await import('./createExecutionRunBackend');
    const configuredBackend = createExecutionRunBackend({
      cwd: '/tmp/workspace',
      backendId: 'customAcp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      permissionMode: 'read_only',
    });
    const handler = vi.fn();
    configuredBackend.onMessage(handler);

    await configuredBackend.startSession();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(handler);
  });

});
