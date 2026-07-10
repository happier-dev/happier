import { describe, expect, it, vi } from 'vitest';

import { SessionHostBridge } from './SessionHostBridge';

const {
  createSessionRuntimeMock,
  runSessionRuntimePlanMock,
} = vi.hoisted(() => ({
  createSessionRuntimeMock: vi.fn(),
  runSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
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
      agentId: 'claude',
      source: 'built_in',
      engineAdapter: {
        runtimeCore: {
          createSessionRuntime: createSessionRuntimeMock,
        },
      },
    })),
}));

describe('SessionHostBridge (claude runtimeCore)', () => {
  it('runs Claude session commands through the host-owned session-loop plan', async () => {
    runSessionRuntimePlanMock.mockResolvedValue(undefined);
    createSessionRuntimeMock.mockResolvedValue({
      kind: 'hostSessionRuntimePlan',
      agentId: 'claude',
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
      agentId: 'claude',
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
