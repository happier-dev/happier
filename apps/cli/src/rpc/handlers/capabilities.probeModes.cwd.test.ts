import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

const mocks = vi.hoisted(() => ({
  probeModes: vi.fn(),
  resolveProbeBackendContext: vi.fn(),
}));

vi.mock('@/capabilities/probes/agentModesProbe', () => ({
  probeAgentModesBestEffort: mocks.probeModes,
}));

vi.mock('./capabilitiesProbeContext', () => ({
  resolveProbeBackendContext: mocks.resolveProbeBackendContext,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    opencode: { id: 'opencode' },
    codex: { id: 'codex', needsAccountSettingsForProbes: true },
    customAcp: { id: 'customAcp' },
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

describe('capabilities.invoke(cli.* probeModes)', () => {
  beforeEach(() => {
    mocks.probeModes.mockReset();
    mocks.resolveProbeBackendContext.mockReset();
    mocks.resolveProbeBackendContext.mockImplementation(async (params: Record<string, unknown>) => ({
      backendTarget: params.backendTarget,
      credentials: null,
      accountSettings: null,
    }));
  });

  it('passes params.cwd through to probeAgentModesBestEffort when provided', async () => {
    mocks.probeModes.mockResolvedValue({
      provider: 'opencode',
      availableModes: [{ id: 'plan', name: 'Plan' }],
      source: 'dynamic',
    });

    const cwd = '/tmp/happier-probe-cwd';
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModes',
      params: { timeoutMs: 1234, cwd },
    });

    expect(mocks.probeModes).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      cwd,
      timeoutMs: 1234,
    }));
  });

  it('does not forward connected-service selections to the mode probe', async () => {
    mocks.probeModes.mockResolvedValue({ provider: 'opencode', availableModes: [], source: 'static' });
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModes',
      params: { connectedServices: { v: 1, bindingsByServiceId: {} } },
    });
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.not.objectContaining({ connectedServices: expect.anything() }));
  });

  it('uses a long enough default timeout when timeoutMs is omitted', async () => {
    mocks.probeModes.mockResolvedValue({
      provider: 'opencode',
      availableModes: [{ id: 'plan', name: 'Plan' }],
      source: 'dynamic',
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModes',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.probeModes).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it('forwards backendTarget to probeAgentModesBestEffort for cli.configuredAcp', async () => {
    mocks.probeModes.mockResolvedValue({
      provider: 'customAcp',
      availableModes: [{ id: 'plan', name: 'Plan' }],
      source: 'dynamic',
    });
    const backendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.configuredAcp',
      method: 'probeModes',
      params: { cwd: '/tmp/happier-probe-cwd', backendTarget },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'customAcp',
      backendTarget,
    }));
  });

  it('supports probeModes for ACP-backed catalog entries', async () => {
    mocks.probeModes.mockResolvedValue({
      provider: 'codex',
      availableModes: [{ id: 'default', name: 'Default' }],
      source: 'dynamic',
    });

    const result = await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModes',
      params: { timeoutMs: 12_345, cwd: '/tmp/happier-probe-cwd' },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        provider: 'codex',
        availableModes: [{ id: 'default', name: 'Default' }],
        source: 'dynamic',
      },
    });
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd: '/tmp/happier-probe-cwd',
      timeoutMs: 12_345,
    }));
  });

  it('forwards resolved Codex backend-mode settings to the probe once', async () => {
    mocks.probeModes.mockResolvedValue({
      provider: 'codex',
      availableModes: [{ id: 'default', name: 'Default' }],
      source: 'static',
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token', encryption: null },
      accountSettings: { codexBackendMode: 'appServer' },
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModes',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledTimes(1);
    expect(mocks.probeModes).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token', encryption: null },
    }));
  });
});
