import { describe, expect, it, vi } from 'vitest';

const {
  createSessionRuntimeMock,
  runSessionRuntimePlanMock,
} = vi.hoisted(() => ({
  createSessionRuntimeMock: vi.fn(),
  runSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@/agent/runtime/sessionLoop/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    runHostSessionRuntimePlan: runSessionRuntimePlanMock,
  };
});

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces: vi.fn(),
  resolveBackendEngineAdapterResolution: vi.fn(async (backendId: string) => ({
      backendId,
      providerId: 'claude',
      source: 'built_in',
      engineAdapter: {
        bindings: {
          createSessionRuntime: createSessionRuntimeMock,
        },
      },
    })),
}));

describe('SessionHostBridge (claude bindings)', () => {
  it('runs Claude session commands through the host-owned session-loop plan', async () => {
    runSessionRuntimePlanMock.mockResolvedValue(undefined);
    createSessionRuntimeMock.mockResolvedValue({
      kind: 'hostSessionRuntimePlan',
      providerId: 'claude',
      opts: {
        credentials: {
          token: 't',
          encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
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
    });

    const { SessionHostBridge } = await import('./SessionHostBridge');
    const bridge = new SessionHostBridge();
    const credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };

    await bridge.runSessionCommand('claude', {
      credentials,
      startedBy: 'terminal',
      terminalRuntime: null,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    });

    expect(runSessionRuntimePlanMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'claude',
      opts: expect.objectContaining({
        credentials,
        existingSessionId: 'sid-1',
        resume: 'resume-1',
        startingMode: 'remote',
      }),
    }));
    expect(createSessionRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials,
      existingSessionId: 'sid-1',
      resume: 'resume-1',
      startingMode: 'remote',
    }));
  });
});
