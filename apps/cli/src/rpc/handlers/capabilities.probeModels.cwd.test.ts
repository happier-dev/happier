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
    claude: { id: 'claude' },
    customAcp: { id: 'customAcp' },
  },
}));

function createClient(dependencies: Parameters<typeof registerCapabilitiesHandlers>[1] = {}) {
  return createEncryptedRpcTestClient({
    scopePrefix: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    logger: () => undefined,
    registerHandlers: (manager) => registerCapabilitiesHandlers(manager, dependencies),
  });
}

function createCall(dependencies: Parameters<typeof registerCapabilitiesHandlers>[1] = {}) {
  return createClient(dependencies).call;
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

  it('preserves connectedServices for the non-native model probe fallback', async () => {
    mocks.probeModels.mockResolvedValue({
      provider: 'opencode',
      availableModels: [{ id: 'default', name: 'Default' }],
      supportsFreeform: false,
      source: 'static',
    });
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        example: { source: 'connected', selection: 'profile', profileId: 'account-selected' },
      },
    } as const;

    await createCall()(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.opencode',
      method: 'probeModels',
      params: { connectedServices },
    });

    expect(mocks.probeModels).toHaveBeenCalledWith(expect.objectContaining({ connectedServices }));
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
  it('uses only the selected Claude binding for the injected native model observation', async () => {
    const observe = vi.fn(async () => ({
      source: 'dynamic' as const,
      stale: false,
      models: [{ id: 'claude-account-model', name: 'Account model' }],
    }));
    const result = await createCall({
      getAgentCatalogObservation: () => ({ machineId: 'machine-test', service: { observe } }),
    })(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.claude',
      method: 'probeModels',
      params: {
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'account-selected' },
          },
        },
      },
    });

    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-test',
      binding: expect.objectContaining({
        target: expect.objectContaining({
          kind: 'account',
          account: expect.objectContaining({ accountId: 'account-selected' }),
        }),
      }),
    }));
    expect(JSON.stringify(observe.mock.calls[0])).not.toContain('selected-account-token');
    expect(JSON.stringify(observe.mock.calls[0])).not.toContain('accessToken');
    expect(result).toEqual({
      ok: true,
      result: {
        agentId: 'claude',
        availableModels: [
          { id: 'default', name: 'Default' },
          { id: 'claude-account-model', name: 'Account model' },
        ],
        supportsFreeform: true,
        source: 'dynamic',
      },
    });
    expect(mocks.probeModels).not.toHaveBeenCalled();
  });


  it('threads exact RPC request currentness into the native model observation', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let captured: Readonly<{ isCurrent(): boolean; signal?: AbortSignal }> | null = null;
    const observe = vi.fn(async (request) => {
      captured = request;
      started.resolve();
      await release.promise;
      if (!request.isCurrent()) throw new Error('cancelled');
      return { source: 'dynamic' as const, stale: false, models: [] };
    });
    const client = createClient({
      getAgentCatalogObservation: () => ({ machineId: 'machine-test', service: { observe } }),
    });
    const controller = new AbortController();
    const pending = client.manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, {
      id: 'cli.claude', method: 'probeModels',
      params: {
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'account-selected' },
          },
        },
      },
    }, { signal: controller.signal });

    await started.promise;
    expect(captured?.isCurrent()).toBe(true);
    expect(captured?.signal).toBe(controller.signal);
    controller.abort();
    expect(captured?.isCurrent()).toBe(false);
    release.resolve();
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

});
