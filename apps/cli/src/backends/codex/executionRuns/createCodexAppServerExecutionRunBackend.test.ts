import { afterEach, describe, expect, it, vi } from 'vitest';

const { createCodexAppServerRuntimeMock } = vi.hoisted(() => ({
  createCodexAppServerRuntimeMock: vi.fn<(params: any) => any>(() => ({
    startOrLoad: async () => undefined,
    getSessionId: () => 'thread_1',
    sendPrompt: async () => undefined,
    cancel: async () => undefined,
    reset: async () => undefined,
  })),
}));

vi.mock('@/backends/codex/appServer/runtime', () => ({
  createCodexAppServerRuntime: createCodexAppServerRuntimeMock,
}));

describe('createCodexAppServerExecutionRunBackend', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('passes the isolated execution-run env through to the app-server runtime (no process.env fallback)', async () => {
    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');

    createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {
        PATH: '/tmp/isolated-bin:/usr/bin',
        HAPPIER_CODEX_APP_SERVER_BIN: '/tmp/fake-codex-app-server',
      } as any,
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    expect(createCodexAppServerRuntimeMock).toHaveBeenCalledTimes(1);
    const params = createCodexAppServerRuntimeMock.mock.calls[0]?.[0] as any;
    expect(params?.processEnv?.HAPPIER_CODEX_APP_SERVER_BIN).toBe('/tmp/fake-codex-app-server');
    expect(params?.processEnv?.PATH).toBe('/tmp/isolated-bin:/usr/bin');
  });
});
