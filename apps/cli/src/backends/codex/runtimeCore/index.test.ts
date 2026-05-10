import { describe, expect, it, vi } from 'vitest';

const { createCodexSessionRuntimeMock } = vi.hoisted(() => ({
  createCodexSessionRuntimeMock: vi.fn(),
}));

vi.mock('../runtime/session/createSessionRuntime', () => ({
  createCodexSessionRuntime: (...args: unknown[]) => createCodexSessionRuntimeMock(...args),
}));

import { createCodexRuntimeCore } from './index';

describe('createCodexRuntimeCore', () => {
  it('rejects non-codex backend or provider runtimeCore', () => {
    expect(() => createCodexRuntimeCore({
      backend: {
        id: 'claude',
      } as never,
      provider: {
        id: 'codex',
      } as never,
    })).toThrow('Codex runtimeCore require codex backend/provider contributions');

    expect(() => createCodexRuntimeCore({
      backend: {
        id: 'codex',
      } as never,
      provider: {
        id: 'claude',
      } as never,
    })).toThrow('Codex runtimeCore require codex backend/provider contributions');
  });

  it('constructs a host-owned session lifecycle plan without running the Codex session', async () => {
    const launch = vi.fn(async () => ({ type: 'exit', code: 0 }));
    const runtimeRun = vi.fn(async () => undefined);
    createCodexSessionRuntimeMock.mockReturnValue({
      kind: 'hostSessionRuntimePlan',
      providerId: 'codex',
      opts: {
        credentials: { token: 't' },
        startedBy: 'terminal',
        directory: '/tmp/codex',
      },
      config: {
        agentMessageType: 'codex',
        createSessionRuntime: vi.fn(),
      },
      run: runtimeRun,
    });
    const runtimeCore = createCodexRuntimeCore({
      backend: {
        id: 'codex',
      } as never,
      provider: {
        id: 'codex',
      } as never,
    });

    await expect(runtimeCore.runtimeCore.createSessionRuntime({
      credentials: { token: 't' },
      startedBy: 'terminal',
      directory: '/tmp/codex',
    })).resolves.toEqual({
      kind: 'hostSessionRuntimePlan',
      providerId: 'codex',
      opts: {
        credentials: { token: 't' },
        startedBy: 'terminal',
        directory: '/tmp/codex',
      },
      config: {
        agentMessageType: 'codex',
        createSessionRuntime: expect.any(Function),
      },
      run: runtimeRun,
    });

    expect(createCodexSessionRuntimeMock).toHaveBeenCalledWith({
      credentials: { token: 't' },
      startedBy: 'terminal',
      directory: '/tmp/codex',
    });
    expect(runtimeRun).not.toHaveBeenCalled();
  });

  it('exposes display.title sync through the runtime session-state facet', async () => {
    const runtimeCore = createCodexRuntimeCore({
      backend: {
        id: 'codex',
      } as never,
      provider: {
        id: 'codex',
      } as never,
    });

    expect(runtimeCore.facets?.sessionState?.capabilities).toMatchObject({
      display: {
        title: {
          supported: true,
          happierToProvider: {
            supported: true,
            transport: 'runtime-hook',
          },
        },
      },
    });
  });
});
