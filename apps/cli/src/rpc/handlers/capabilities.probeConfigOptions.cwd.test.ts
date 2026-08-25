import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { registerCapabilitiesHandlers } from './capabilities';
import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';

const mocks = vi.hoisted(() => ({
  probeConfigOptions: vi.fn(),
  probePassiveRealtimeSetup: vi.fn(),
  resolveProbeBackendContext: vi.fn(),
  resolvePreflightSessionControlsProbeAdapter: vi.fn(),
  resolveCatalogAgentConnectedServiceIds: vi.fn(),
  resolveConnectedServiceAuthForSpawn: vi.fn(),
  pluginReloadGeneration: 0,
}));

vi.mock('@/capabilities/probes/agentConfigOptionsProbe', () => ({
  probeAgentConfigOptionsBestEffort: mocks.probeConfigOptions,
}));

vi.mock('./capabilitiesProbeContext', () => ({
  resolveProbeBackendContext: mocks.resolveProbeBackendContext,
}));

vi.mock('@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: mocks.resolvePreflightSessionControlsProbeAdapter,
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    codex: { id: 'codex', needsAccountSettingsForProbes: true },
  },
  resolveCatalogAgentConnectedServiceIds: mocks.resolveCatalogAgentConnectedServiceIds,
}));

vi.mock('@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
  resolveConnectedServiceAuthForSpawn: mocks.resolveConnectedServiceAuthForSpawn,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({ generation: mocks.pluginReloadGeneration }),
  },
}));

function createCall(dependencies: Parameters<typeof registerCapabilitiesHandlers>[1] = {}) {
  return createEncryptedRpcTestClient({
    scopePrefix: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    logger: () => undefined,
    registerHandlers: (manager) => registerCapabilitiesHandlers(manager, dependencies),
  }).call;
}

describe('capabilities.invoke(cli.* probeConfigOptions)', () => {
  beforeEach(() => {
    mocks.probeConfigOptions.mockReset();
    mocks.probePassiveRealtimeSetup.mockReset();
    mocks.resolveProbeBackendContext.mockReset();
    mocks.resolvePreflightSessionControlsProbeAdapter.mockReset();
    mocks.resolveCatalogAgentConnectedServiceIds.mockReset();
    mocks.resolveConnectedServiceAuthForSpawn.mockReset();
    mocks.pluginReloadGeneration = 0;
    mocks.resolveCatalogAgentConnectedServiceIds.mockReturnValue([]);
    mocks.resolvePreflightSessionControlsProbeAdapter.mockResolvedValue({
      probePassiveRealtimeSetupRaw: mocks.probePassiveRealtimeSetup,
    });
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

  it('invokes the declared passive realtime setup probe through the existing CLI capability', async () => {
    mocks.resolveCatalogAgentConnectedServiceIds.mockReturnValue(['openai-codex']);
    mocks.resolvePreflightSessionControlsProbeAdapter.mockResolvedValue({
      connectedServiceAuth: 'materialized-env',
      probePassiveRealtimeSetupRaw: mocks.probePassiveRealtimeSetup,
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token', encryption: null },
      accountSettings: null,
    });
    mocks.resolveConnectedServiceAuthForSpawn.mockResolvedValue({ env: {} });
    mocks.probePassiveRealtimeSetup.mockResolvedValue({ v: 1, status: 'ready' });

    const result = await createCall({ createApiClient: async () => ({} as never) })(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probePassiveRealtimeSetup',
      params: {
        timeoutMs: 12_345,
        cwd: '/tmp/happier-passive-setup',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-profile',
            },
          },
        },
      },
    });

    expect(result).toEqual({ ok: true, result: { v: 1, status: 'ready' } });
    expect(mocks.probePassiveRealtimeSetup).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/happier-passive-setup',
      timeoutMs: 12_345,
      probeKind: 'passiveRealtimeSetup',
      accountSettings: null,
    }));
  });

  it('fails closed without invoking passive setup when the selected Connected Service binding is absent', async () => {
    mocks.resolveCatalogAgentConnectedServiceIds.mockReturnValue(['openai-codex']);
    mocks.probePassiveRealtimeSetup.mockResolvedValue({ v: 1, status: 'ready' });

    const result = await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probePassiveRealtimeSetup',
      params: { cwd: '/tmp/happier-passive-setup' },
    });

    expect(result).toEqual({ ok: true, result: { v: 1, status: 'unavailable' } });
    expect(mocks.probePassiveRealtimeSetup).not.toHaveBeenCalled();
  });

  it('fails closed when the plugin registry retires while passive setup is in flight', async () => {
    mocks.resolveCatalogAgentConnectedServiceIds.mockReturnValue(['openai-codex']);
    mocks.resolvePreflightSessionControlsProbeAdapter.mockResolvedValue({
      connectedServiceAuth: 'materialized-env',
      probePassiveRealtimeSetupRaw: mocks.probePassiveRealtimeSetup,
    });
    mocks.resolveProbeBackendContext.mockResolvedValue({
      backendTarget: undefined,
      credentials: { token: 'token', encryption: null },
      accountSettings: null,
    });
    mocks.resolveConnectedServiceAuthForSpawn.mockResolvedValue({ env: {} });
    const passiveSetupSettlement: { resolve: ((result: { v: 1; status: 'ready' }) => void) | null } = {
      resolve: null,
    };
    mocks.probePassiveRealtimeSetup.mockImplementation(() => new Promise((resolve) => {
      passiveSetupSettlement.resolve = resolve;
    }));

    const result = createCall({ createApiClient: async () => ({} as never) })(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.codex',
      method: 'probePassiveRealtimeSetup',
      params: {
        cwd: '/tmp/happier-passive-setup',
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-profile',
            },
          },
        },
      },
    });
    await vi.waitFor(() => {
      expect(mocks.probePassiveRealtimeSetup).toHaveBeenCalledTimes(1);
    });
    mocks.pluginReloadGeneration += 1;
    passiveSetupSettlement.resolve?.({ v: 1, status: 'ready' });

    await expect(result).resolves.toEqual({ ok: true, result: { v: 1, status: 'unavailable' } });
  });
});
