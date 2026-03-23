import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

describe('capabilities.invoke(cli.* probeModels)', () => {
  it('passes params.cwd through to probeAgentModelsBestEffort when provided', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const cwd = '/tmp/happier-probe-cwd';
    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { timeoutMs: 1234, cwd },
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'opencode', cwd, timeoutMs: 1234 }));
  });

  it('uses a long enough default timeout when timeoutMs is omitted', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 15_000 }));
  });

  it('forwards backendTarget to probeAgentModelsBestEffort for cli.customAcp', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'customAcp',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        customAcp: { id: 'customAcp' },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    const backendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.customAcp',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd', backendTarget },
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'customAcp',
      backendTarget,
    }));
  });

  it('loads account settings for probes when the agent catalog entry requires them', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));
    const readCredentialsMock = vi.fn(async () => ({ token: 'token' }));
    const bootstrapAccountSettingsContextMock = vi.fn(async () => ({
      settings: { example: true },
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));
    vi.doMock('@/persistence', () => ({
      readCredentials: readCredentialsMock,
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
    }));
    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode', needsAccountSettingsForProbes: true },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(bootstrapAccountSettingsContextMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token' },
      mode: 'blocking',
      refresh: 'auto',
    }));
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      accountSettings: { example: true },
      credentials: { token: 'token' },
    }));
  });

  it('loads account settings for cli.codex probes so backend-mode aware probing can run', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'codex',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));
    const readCredentialsMock = vi.fn(async () => ({ token: 'token' }));
    const bootstrapAccountSettingsContextMock = vi.fn(async () => ({
      settings: { codexBackendMode: 'appServer' },
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));
    vi.doMock('@/persistence', () => ({
      readCredentials: readCredentialsMock,
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
    }));
    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex', needsAccountSettingsForProbes: true },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(bootstrapAccountSettingsContextMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token' },
      mode: 'blocking',
      refresh: 'auto',
    }));
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token' },
    }));
  });

  it('prefers an explicit runtime-kind override over the cached account settings', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'codex',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    }));
    const readCredentialsMock = vi.fn(async () => ({ token: 'token' }));
    const bootstrapAccountSettingsContextMock = vi.fn(async () => ({
      settings: { codexBackendMode: 'mcp' },
    }));

    vi.doMock('@/capabilities/probes/agentModelsProbe', () => ({
      probeAgentModelsBestEffort: (params: any) => probeSpy(params),
    }));
    vi.doMock('@/persistence', () => ({
      readCredentials: readCredentialsMock,
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
    }));
    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex', needsAccountSettingsForProbes: true },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await call(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd', runtimeKindOverride: 'appServer' },
    });

    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(bootstrapAccountSettingsContextMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token' },
      mode: 'blocking',
      refresh: 'auto',
    }));
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token' },
    }));
  });
});
