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
});
