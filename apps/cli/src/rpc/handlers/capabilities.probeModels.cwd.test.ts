import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

const mocks = vi.hoisted(() => ({
  probeModels: vi.fn(),
  resolveProbeBackendContext: vi.fn(),
}));

vi.mock('@/capabilities/probes/agentModelsProbe', () => ({
  probeAgentModelsBestEffort: mocks.probeModels,
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

describe('capabilities.invoke(cli.* probeModels)', () => {
  beforeEach(() => {
    mocks.probeModels.mockReset();
    mocks.resolveProbeBackendContext.mockReset();
    mocks.resolveProbeBackendContext.mockImplementation(async (params: Record<string, unknown>) => ({
      backendTarget: params.backendTarget,
      credentials: null,
      accountSettings: null,
    }));
  });

  it('passes params.cwd through to probeAgentModelsBestEffort when provided', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });

    const cwd = '/tmp/happier-probe-cwd';
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { timeoutMs: 1234, cwd },
    });

    expect(mocks.probeModels).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'opencode', cwd, timeoutMs: 1234 }));
  });

  it('uses a long enough default timeout when timeoutMs is omitted', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.probeModels).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it('supports probeModels for ACP-backed catalog entries', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'codex',
      availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
      supportsFreeform: false,
      source: 'dynamic',
    });

    const result = await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { timeoutMs: 12_345, cwd: '/tmp/happier-probe-cwd' },
    });

    expect(result).toEqual({
      ok: true,
      result: {
        provider: 'codex',
        availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
        supportsFreeform: false,
        source: 'dynamic',
      },
    });
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd: '/tmp/happier-probe-cwd',
      timeoutMs: 12_345,
    }));
  });

  it('forwards backendTarget to probeAgentModelsBestEffort for cli.configuredAcp', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'customAcp',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });

    const backendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' } as const;
    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.configuredAcp',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd', backendTarget },
    });

    expect(mocks.probeModels).toHaveBeenCalledTimes(1);
    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'customAcp',
      backendTarget,
    }));
  });

  it('forwards resolved account settings and credentials to the probe once', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token' },
      accountSettings: { example: true },
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      accountSettings: { example: true },
      credentials: { token: 'token' },
    }));
  });

  it('forwards resolved Codex backend-mode settings to the probe', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'codex',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token' },
      accountSettings: { codexBackendMode: 'appServer' },
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd' },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledTimes(1);
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token' },
    }));
  });

  it('passes an explicit runtime-kind override through the canonical context owner', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'codex',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token' },
      accountSettings: { codexBackendMode: 'appServer' },
    });

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probeModels',
      params: { cwd: '/tmp/happier-probe-cwd', runtimeKindOverride: 'appServer' },
    });

    expect(mocks.resolveProbeBackendContext).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      runtimeKindOverride: 'appServer',
    }));
    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      accountSettings: { codexBackendMode: 'appServer' },
      credentials: { token: 'token' },
    }));
  });
});
