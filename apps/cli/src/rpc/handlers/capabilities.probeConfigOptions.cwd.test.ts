import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

const mocks = vi.hoisted(() => ({
  probeConfigOptions: vi.fn(),
  resolveProbeBackendContext: vi.fn(),
}));

vi.mock('@/capabilities/probes/agentConfigOptionsProbe', () => ({
  probeAgentConfigOptionsBestEffort: mocks.probeConfigOptions,
}));

vi.mock('./capabilitiesProbeContext', () => ({
  resolveProbeBackendContext: mocks.resolveProbeBackendContext,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    codex: { id: 'codex', needsAccountSettingsForProbes: true },
  },
}));

function createCall() {
  return createEncryptedRpcTestClient({
    scopePrefix: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    logger: () => undefined,
    registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
  }).call;
}

describe('capabilities.invoke(cli.* probeConfigOptions)', () => {
  beforeEach(() => {
    mocks.probeConfigOptions.mockReset();
    mocks.resolveProbeBackendContext.mockReset();
    mocks.resolveProbeBackendContext.mockImplementation(async (params: Record<string, unknown>) => ({
      backendTarget: params.backendTarget,
      credentials: null,
      accountSettings: null,
    }));
  });

  it('passes params.cwd through to probeAgentConfigOptionsBestEffort when provided', async () => {
    mocks.probeConfigOptions.mockResolvedValue({
      provider: 'codex',
      configOptions: [],
      source: 'static',
    });

    const cwd = '/tmp/happier-probe-cwd';
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeConfigOptions',
      params: { timeoutMs: 1234, cwd },
    });

    expect(mocks.probeConfigOptions).toHaveBeenCalledTimes(1);
    expect(mocks.probeConfigOptions).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd,
      timeoutMs: 1234,
    }));
  });

  it('does not forward connected-service selections to the config-options probe', async () => {
    mocks.probeConfigOptions.mockResolvedValue({ provider: 'codex', configOptions: [], source: 'static' });
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex', method: 'probeConfigOptions',
      params: { connectedServices: { v: 1, bindingsByServiceId: {} } },
    });
    expect(mocks.probeConfigOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ connectedServices: expect.anything() }),
    );
  });

  it('supports probeConfigOptions for ACP-backed catalog entries', async () => {
    mocks.probeConfigOptions.mockResolvedValue({
      provider: 'codex',
      configOptions: [{ id: 'reasoning_effort', name: 'Thinking' }],
      source: 'dynamic',
    });

    const result = await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeConfigOptions',
      params: { timeoutMs: 12_345, cwd: '/tmp/happier-probe-cwd' },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        provider: 'codex',
        configOptions: [{ id: 'reasoning_effort', name: 'Thinking' }],
        source: 'dynamic',
      },
    });
    expect(mocks.probeConfigOptions).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd: '/tmp/happier-probe-cwd',
      timeoutMs: 12_345,
    }));
  });

  it('forwards resolved Codex backend-mode settings to config-option probing once', async () => {
    mocks.probeConfigOptions.mockResolvedValue({
      provider: 'codex',
      configOptions: [],
      source: 'static',
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token', encryption: null },
      accountSettings: { codexBackendMode: 'appServer' },
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeConfigOptions',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeConfigOptions).toHaveBeenCalledTimes(1);
    expect(mocks.probeConfigOptions).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token', encryption: null },
    }));
  });
});
