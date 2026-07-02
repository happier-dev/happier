import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCatalogProviderAcpRuntimeMock,
  getAgentCliRuntimeSpecMock,
  runHostSessionRuntimePlanMock,
} = vi.hoisted(() => ({
  createCatalogProviderAcpRuntimeMock: vi.fn(),
  getAgentCliRuntimeSpecMock: vi.fn(),
  runHostSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    getAgentCliRuntimeSpec: getAgentCliRuntimeSpecMock,
  };
});

vi.mock('@/agent/runtime/session/loop/runHostSessionRuntime', () => ({
  runHostSessionRuntime: vi.fn(),
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/runtime/session/loop/lifecycle')>();
  return {
    ...actual,
    runHostSessionRuntimePlan: runHostSessionRuntimePlanMock,
  };
});

vi.mock('@/agent/acp/runtime/createProviderAcpRuntime', () => ({
  createCatalogProviderAcpRuntime: createCatalogProviderAcpRuntimeMock,
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: { host: 'test-host', platform: 'darwin', happyCliVersion: '0.0.0-test', homeDir: '/tmp', happyHomeDir: '/tmp/happy', happyLibDir: '/tmp/happy/lib' },
}));

vi.mock('@/agent/runtime/formatProviderPromptErrorMessage', () => ({
  formatProviderPromptErrorMessage: () => 'prompt-error',
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./ui/TerminalDisplay', () => ({
  BuiltInAcpTerminalDisplay: () => null,
}));

import { runBuiltInAgent } from './run';

describe('runBuiltInAgent', () => {
  beforeEach(() => {
    createCatalogProviderAcpRuntimeMock.mockReset();
    getAgentCliRuntimeSpecMock.mockReset();
    runHostSessionRuntimePlanMock.mockReset();
    getAgentCliRuntimeSpecMock.mockReturnValue({
      title: 'Kiro CLI',
      binaryName: 'kiro',
    });
  });

  type CapturedHostPlan = Readonly<{
    kind: 'hostSessionRuntimePlan';
    providerId: string;
    config: Readonly<{
      createSessionRuntime: (args: any) => unknown;
    }>;
  }>;

  it('forwards machine identity and memory recall guidance to the catalog ACP runtime', async () => {
    let capturedPlan: null | CapturedHostPlan = null;
    runHostSessionRuntimePlanMock.mockImplementation(async (plan: unknown) => {
      capturedPlan = plan as CapturedHostPlan;
    });

    const runtime = { kind: 'runtime' };
    createCatalogProviderAcpRuntimeMock.mockReturnValue(runtime);

    await runBuiltInAgent('kiro', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedPlan) {
      throw new Error('Expected host session runtime plan to be captured');
    }

    const capturedHostPlan = capturedPlan as CapturedHostPlan;
    const runtimeConfig = capturedHostPlan.config;
    const createdRuntime = await runtimeConfig.createSessionRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: { id: 'session-1' },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: true,
    });

    expect(capturedHostPlan).toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'kiro',
      config: expect.objectContaining({
        createSessionRuntime: expect.any(Function),
      }),
    }));
    expect(createdRuntime).toEqual({
      nativeRuntime: runtime,
      operations: runtime,
    });
    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'kiro',
      directory: '/repo',
      session: { id: 'session-1' },
      memoryRecallGuidance: {
        enabled: true,
        machineId: 'machine-123',
      },
    }));
  });

  it('publishes provider session ids for catalog ACP agents that declare a vendor resume metadata field', async () => {
    let capturedPlan: null | CapturedHostPlan = null;
    runHostSessionRuntimePlanMock.mockImplementation(async (plan: unknown) => {
      capturedPlan = plan as CapturedHostPlan;
    });

    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runBuiltInAgent('ohMyPi', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedPlan) {
      throw new Error('Expected host session runtime plan to be captured');
    }

    const capturedHostPlan = capturedPlan as CapturedHostPlan;
    const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      return updater({ existing: true });
    });

    capturedHostPlan.config.createSessionRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: {
        id: 'session-1',
        updateMetadata,
      },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    const runtimeArgs = createCatalogProviderAcpRuntimeMock.mock.calls.at(-1)?.[0];
    expect(runtimeArgs?.provider).toBe('ohMyPi');
    expect(runtimeArgs?.onSessionIdChange).toBeTypeOf('function');

    runtimeArgs?.onSessionIdChange?.('omp-session-1');

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    const updater = updateMetadata.mock.calls[0]?.[0] as ((metadata: Record<string, unknown>) => Record<string, unknown>) | undefined;
    expect(updater?.({ existing: true })).toEqual({
      existing: true,
      ohMyPiSessionId: 'omp-session-1',
    });
  });

});
