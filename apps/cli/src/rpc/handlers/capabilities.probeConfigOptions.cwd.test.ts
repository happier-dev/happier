import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

describe('capabilities.invoke(cli.* probeConfigOptions)', () => {
  it('passes params.cwd through to probeAgentConfigOptionsBestEffort when provided', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'codex',
      configOptions: [],
      source: 'static',
    }));

    vi.doMock('@/capabilities/probes/agentConfigOptionsProbe', () => ({
      probeAgentConfigOptionsBestEffort: (params: any) => probeSpy(params),
    }));

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
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
      id: 'cli.codex',
      method: 'probeConfigOptions',
      params: { timeoutMs: 1234, cwd },
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(probeSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', cwd, timeoutMs: 1234 }));
  });

  it('loads account settings for cli.codex probes so backend-mode aware config option probing can run', async () => {
    vi.resetModules();

    const probeSpy = vi.fn(async (_params: any) => ({
      provider: 'codex',
      configOptions: [],
      source: 'static',
    }));
    const readCredentialsMock = vi.fn(async () => ({ token: 'token' }));
    const bootstrapAccountSettingsContextMock = vi.fn(async () => ({
      settings: { codexBackendMode: 'appServer' },
    }));

    vi.doMock('@/capabilities/probes/agentConfigOptionsProbe', () => ({
      probeAgentConfigOptionsBestEffort: (params: any) => probeSpy(params),
    }));
    vi.doMock('@/persistence', () => ({
      readCredentials: readCredentialsMock,
    }));
    vi.doMock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
      bootstrapAccountSettingsContext: bootstrapAccountSettingsContextMock,
    }));
    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: { id: 'codex' },
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
      method: 'probeConfigOptions',
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
});
