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

describe('appServerBackend', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('passes the isolated execution-run env through to the app-server runtime (no process.env fallback)', async () => {
    const { appServerBackend } = await import('./appServerBackend');

    const runtime = appServerBackend({
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
    await expect(runtime.readResumeSupport()).resolves.toBe(true);
    await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'thread_1' });
    expect(typeof runtime.subscribeMessages).toBe('function');
    expect(runtime).not.toHaveProperty('startSession');
  });

  it('rejects waitForTurnCompletion when the prompt exceeds timeoutMs', async () => {
    vi.useFakeTimers();

    let resolvePrompt!: () => void;
    const pendingPrompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });

    createCodexAppServerRuntimeMock.mockImplementationOnce(() => ({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_timeout',
      sendPrompt: async () => await pendingPrompt,
      cancel: async () => undefined,
      reset: async () => undefined,
    }));

    const { appServerBackend } = await import('./appServerBackend');
    const runtime = appServerBackend({
      cwd: '/tmp/happier-worktree',
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    const started = await runtime.provisionSession();
    const promptPromise = runtime.sendPrompt(started.sessionId, 'hang');
    await Promise.resolve();

    if (!runtime.waitForTurnCompletion) {
      throw new Error('Expected waitForTurnCompletion to be defined');
    }

    const waiting = runtime.waitForTurnCompletion(250).then(
      () => 'resolved' as const,
      (error: unknown) => error instanceof Error ? error.message : 'rejected',
    );

    await vi.advanceTimersByTimeAsync(250);
    const marker = new Promise<'marker'>((resolve) => setTimeout(() => resolve('marker'), 0));
    await vi.advanceTimersByTimeAsync(0);

    await expect(Promise.race([waiting, marker])).resolves.toBe('Codex app-server response timeout after 250ms');

    resolvePrompt();
    await expect(promptPromise).resolves.toBeUndefined();
    await runtime.dispose();
  });
});
