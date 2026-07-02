import { describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import { isRuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const createGeminiBackend = vi.fn();
const createGeminiAcpRuntime = vi.fn();
const resolveBackendIsolationBundle = vi.fn();
const createExecutionRunHostRuntimeFromAgentBackend = vi.fn(() => {
  throw new Error('Gemini execution-run runtime must not use the central AgentBackend retirement adapter');
});

vi.mock('@/backends/gemini/acp/backend', () => ({
  createGeminiBackend: (opts: unknown) => createGeminiBackend(opts),
}));

vi.mock('@/backends/gemini/acp/runtime', () => ({
  createGeminiAcpRuntime: (opts: unknown) => createGeminiAcpRuntime(opts),
}));

vi.mock('@/packagedRuntime/managedTools/requireProviderCliLaunchSpec', () => ({
  requireProviderCliLaunchSpec: vi.fn(),
}));

vi.mock('@/packagedRuntime/isolation/resolveBackendIsolationBundle', () => ({
  resolveBackendIsolationBundle: (opts: unknown) => resolveBackendIsolationBundle(opts),
}));

vi.mock('@/agent/runtime/bridges/executionRun/testkit', () => ({
  createExecutionRunHostRuntimeFromAgentBackend,
}));

describe('gemini runtimeCore', () => {
  it('exposes the host-owned Gemini session and execution-run entrypoints', async () => {
    const { createGeminiRuntimeCore } = await import('../runtimeCore/index');
    const runtimeCore = createGeminiRuntimeCore();

    expect(runtimeCore.runtimeCore.createSessionRuntime).toBeTypeOf('function');
    expect(runtimeCore.runtimeCore.createExecutionRunBackend).toBeTypeOf('function');
  });

  it('does not seed the initial displayed model from inherited GEMINI_MODEL', async () => {
    const envScope = createEnvKeyScope(['GEMINI_MODEL']);
    envScope.patch({ GEMINI_MODEL: 'host-model' });
    try {
      const { createGeminiSessionRuntimePlan } = await import('../runtimeCore/session');
      const credentials: Credentials = {
        token: 't',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      };

      const plan = createGeminiSessionRuntimePlan({ credentials });
      const lifecycleHooks = plan.config.lifecycleHooks;
      expect(lifecycleHooks).toBeDefined();

      const selection = lifecycleHooks?.resolveInitialModelSelection?.({
        opts: { credentials },
        accountSettings: null,
        nowMs: 1,
      });
      expect(selection).not.toMatchObject({ modelId: 'host-model' });
    } finally {
      envScope.restore();
    }
  });

  it('creates execution-run backend with isolation env + normalized permission mode', async () => {
    const cleanup = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const backend = {
      readResumeSupport: vi.fn(async () => true),
      provisionSession: vi.fn(async () => ({ sessionId: 'gemini-run-session' })),
      startSession: vi.fn(async () => ({ sessionId: 'gemini-run-session' })),
      sendPrompt: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      onMessage: vi.fn(() => undefined),
      subscribeMessages: vi.fn(() => () => undefined),
      offMessage: vi.fn(() => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      dispose,
    } as any;
    createGeminiBackend.mockReturnValue({ backend });
    resolveBackendIsolationBundle.mockReturnValue({
      env: { PATH: '/bin', HAPPIER_ISOLATION_ID: 'run_gemini_123' },
      settingsPath: '/tmp/settings.json',
      cleanup,
    });

    const { createGeminiRuntimeCore } = await import('../runtimeCore/index');
    const runtimeCore = createGeminiRuntimeCore();

    const runtime = runtimeCore.runtimeCore.createExecutionRunBackend({
      cwd: '/repo',
      runId: '123',
      backendId: 'gemini',
      permissionMode: 'read_only',
      accountSettings: null,
      start: { retentionPolicy: 'ephemeral' },
    });

    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'gemini-run-session' });
    await runtime.dispose();
    expect(resolveBackendIsolationBundle).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'gemini',
      isolationId: expect.stringContaining('123'),
      scope: 'execution_run',
      cwd: '/repo',
    }));
    expect(createGeminiBackend).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      env: expect.objectContaining({ PATH: '/bin' }),
      permissionMode: 'read-only',
    }));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('uses the Gemini native runtime as the shared lower-operation surface', async () => {
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
      startOrLoadSession: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: 'gemini-session' })),
      respondToPermission: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    createGeminiAcpRuntime.mockReturnValue(nativeRuntime);

    const { createGeminiRuntimeCore } = await import('../runtimeCore/index');
    const runtimeCore = createGeminiRuntimeCore();

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    const plan = await runtimeCore.runtimeCore.createSessionRuntime({ credentials });
    const createdRuntime = await (
      plan as {
        config: {
          createSessionRuntime: (params: unknown) => Promise<{
            operations: unknown;
            nativeRuntime: unknown;
          }>;
        };
      }
    ).config.createSessionRuntime({
      directory: '/repo',
      metadata: { path: '/repo' },
      machineId: 'machine-1',
      session: {},
      transcriptSession: {},
      messageBuffer: {},
      mcpServers: {},
      permissionHandler: {},
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createdRuntime.nativeRuntime).toBe(nativeRuntime);
    expect(createdRuntime.operations).toBe(nativeRuntime);
    expect(isRuntimeTurnOperations(createdRuntime.operations)).toBe(true);
  });
});
