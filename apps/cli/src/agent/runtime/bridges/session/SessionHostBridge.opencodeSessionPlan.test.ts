import { describe, expect, it, vi } from 'vitest';

const { createSessionRuntimeMock } = vi.hoisted(() => ({
  createSessionRuntimeMock: vi.fn(),
}));

const {
  resolveBackendEngineAdapterResolutionMock,
  resolveBackendExecutionSurfacesMock,
} = vi.hoisted(() => ({
  resolveBackendEngineAdapterResolutionMock: vi.fn(),
  resolveBackendExecutionSurfacesMock: vi.fn(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces: (...args: unknown[]) => resolveBackendExecutionSurfacesMock(...args),
  resolveBackendEngineAdapterResolution: (...args: unknown[]) => resolveBackendEngineAdapterResolutionMock(...args),
}));

describe('SessionHostBridge (opencode session plan)', () => {
  it('returns a host-owned OpenCode session plan through runtimeCore', async () => {
    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backendId: 'opencode',
      agentId: 'opencode',
      source: 'built_in',
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime: createSessionRuntimeMock,
        },
      },
    });
    resolveBackendExecutionSurfacesMock.mockResolvedValue({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const createdPlan = {
      kind: 'hostSessionRuntimePlan',
      agentId: 'opencode',
      opts: {
        credentials: {
          token: 't',
          encryption: {
            type: 'legacy' as const,
            secret: new Uint8Array(32).fill(1),
          },
        },
        startedBy: 'terminal' as const,
        terminalRuntime: null,
        existingSessionId: 'sid-1',
        resume: 'resume-1',
        startingMode: 'remote' as const,
      },
      config: {
        createSessionRuntime: vi.fn(),
      },
    };

    createSessionRuntimeMock.mockImplementation(async () => createdPlan);

    const { SessionHostBridge } = await import('./SessionHostBridge');
    const bridge = new SessionHostBridge();

    const plan = await bridge.createSessionRuntime('opencode', {
      credentials: createdPlan.opts.credentials,
      startedBy: 'terminal',
      terminalRuntime: null,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    });

    expect(plan).toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      agentId: 'opencode',
      opts: createdPlan.opts,
    }));
    expect(plan.config.createSessionRuntime).toBeTypeOf('function');
    expect(createSessionRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials: createdPlan.opts.credentials,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    }));
  });
});
