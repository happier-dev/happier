import { afterEach, describe, expect, it, vi } from 'vitest';

const { createCodexAppServerRuntimeMock } = vi.hoisted(() => ({
  createCodexAppServerRuntimeMock: vi.fn<(params: any) => any>(() => ({
    startOrLoad: async () => undefined,
    getSessionId: () => 'thread_1',
    sendPrompt: async () => undefined,
    startReview: async () => undefined,
    compactContext: async () => undefined,
    cancel: async () => undefined,
    reset: async () => undefined,
  })),
}));

vi.mock('@/backends/codex/appServer/runtime', () => ({
  createCodexAppServerRuntime: createCodexAppServerRuntimeMock,
}));

describe('createCodexAppServerExecutionRunBackend', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('keeps committed assistant streams isolated by exact local-id bytes', async () => {
    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });
    const observed: unknown[] = [];
    backend.onMessage((message) => observed.push(message));

    const runtimeParams = createCodexAppServerRuntimeMock.mock.calls[0]?.[0] as any;
    const commit = runtimeParams.session.sendAgentMessageCommitted as (
      provider: string,
      body: { type: 'message'; message: string },
      opts: { localId: string },
    ) => Promise<void>;
    await commit('codex', { type: 'message', message: 'Hello' }, { localId: 'assistant-1' });
    await commit('codex', { type: 'message', message: 'Separate stream' }, { localId: ' assistant-1' });

    expect(observed).toEqual([
      { type: 'model-output', fullText: 'Hello' },
      { type: 'model-output', fullText: 'Separate stream' },
    ]);
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

  it('delegates setSessionModel + setSessionConfigOption to the app-server runtime', async () => {
    const setSessionModel = vi.fn(async () => undefined);
    const setSessionConfigOption = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: async () => undefined,
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      setSessionModel,
      setSessionConfigOption,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.setSessionModel('thread_1' as any, ' gpt-5.5\t');
    await backend.setSessionConfigOption('thread_1' as any, ' reasoning_effort\t', 'high');

    expect(setSessionModel).toHaveBeenCalledWith(' gpt-5.5\t');
    expect(setSessionConfigOption).toHaveBeenCalledWith(' reasoning_effort\t', 'high');
  });

  it('loads existing execution-run sessions without importing provider history', async () => {
    const startOrLoad = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad,
      getSessionId: () => 'thread_existing',
      sendPrompt: async () => undefined,
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    if (!backend.loadSession) throw new Error('Expected Codex app-server execution backend to support loadSession');
    await expect(backend.loadSession('thread_existing' as any)).resolves.toEqual({ sessionId: 'thread_existing' });

    expect(startOrLoad).toHaveBeenCalledWith({
      existingSessionId: 'thread_existing',
      importHistory: false,
    });
  });

  it('routes /compact to the app-server compaction RPC instead of a normal prompt', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const compactContext = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview: async () => undefined,
      compactContext,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', '/compact');

    expect(compactContext).toHaveBeenCalledWith('/compact');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('reports app-server active turn state through the execution-run liveness probe', async () => {
    let activeProviderTurn = true;
    let turnInFlight = false;
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: async () => undefined,
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => activeProviderTurn,
      isTurnInFlight: () => turnInFlight,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await expect(backend.probeTurnLiveness()).resolves.toEqual({
      active: true,
      activeProviderTurn: true,
      promptInFlight: false,
      source: 'codex-app-server-runtime',
      turnInFlight: false,
    });

    activeProviderTurn = false;
    turnInFlight = true;

    await expect(backend.probeTurnLiveness()).resolves.toEqual({
      active: false,
      activeProviderTurn: false,
      promptInFlight: false,
      source: 'codex-app-server-runtime',
      turnInFlight: true,
    });
  });

  it('keeps local prompt state out of active liveness when the runtime is inactive', async () => {
    let finishTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: vi.fn(() => turnPromise),
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => false,
      isTurnInFlight: () => false,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'hello');

    await expect(backend.probeTurnLiveness()).resolves.toEqual({
      active: false,
      activeProviderTurn: false,
      promptInFlight: true,
      source: 'codex-app-server-runtime',
      turnInFlight: false,
    });

    finishTurn();
    await backend.waitForResponseComplete?.();
  });

  it('ACKs sendPrompt after scheduling the app-server turn and leaves completion to waitForResponseComplete', async () => {
    let finishTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const sendPrompt = vi.fn(() => turnPromise);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => false,
      isTurnInFlight: () => false,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    const sendAck = backend.sendPrompt('thread_1', 'hello').then(() => 'ack' as const);

    await Promise.resolve();
    await Promise.resolve();
    await expect(Promise.race([sendAck, Promise.resolve('pending' as const)])).resolves.toBe('ack');
    expect(sendPrompt).toHaveBeenCalledWith('hello');

    let waitSettled = false;
    const wait = backend.waitForResponseComplete?.().then(() => {
      waitSettled = true;
    });
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    finishTurn();
    await expect(wait).resolves.toBeUndefined();
  });

  it('rejects waitForResponseComplete when the app-server turn exceeds the requested timeout', async () => {
    vi.useFakeTimers();
    let finishTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: vi.fn(() => turnPromise),
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => false,
      isTurnInFlight: () => false,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    const send = backend.sendPrompt('thread_1', 'hello');
    await send;
    await Promise.resolve();
    const wait = backend.waitForResponseComplete?.(250);
    if (!wait) throw new Error('Expected waitForResponseComplete to be defined');
    const waitExpectation = expect(wait).rejects.toMatchObject({
      executionRunErrorCode: 'provider_inactivity_timeout',
      livenessProbe: {
        active: false,
        activeProviderTurn: false,
        promptInFlight: true,
        source: 'codex-app-server-runtime',
        turnInFlight: false,
      },
    });

    await vi.advanceTimersByTimeAsync(250);
    await waitExpectation;

    finishTurn();
    await vi.runAllTimersAsync();
    await Promise.allSettled([send, wait]);
  });

  it('preserves a settled app-server rejection until waitForResponseComplete consumes it', async () => {
    const sendPrompt = vi.fn(async () => {
      throw new Error('runtime rejected before wait');
    });
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => false,
      isTurnInFlight: () => false,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'hello');
    await Promise.resolve();
    await Promise.resolve();

    await expect(backend.waitForResponseComplete?.()).rejects.toThrow(/runtime rejected before wait/);
  });

  it('keeps startSession with an initial prompt pending until the prompt completes', async () => {
    let finishTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: vi.fn(() => turnPromise),
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => true,
      isTurnInFlight: () => true,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    const start = backend.startSession('hello').then(() => 'started' as const);
    await Promise.resolve();
    await Promise.resolve();
    await expect(Promise.race([start, Promise.resolve('pending' as const)])).resolves.toBe('pending');

    finishTurn();
    await expect(start).resolves.toBe('started');
  });

  it('keeps waiting past waitForResponseComplete timeout while the app-server runtime is still active', async () => {
    vi.useFakeTimers();
    let finishTurn!: () => void;
    const turnPromise = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt: vi.fn(() => turnPromise),
      startReview: async () => undefined,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
      hasActiveProviderTurn: () => true,
      isTurnInFlight: () => true,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'hello');
    const wait = backend.waitForResponseComplete?.(250);
    if (!wait) throw new Error('Expected waitForResponseComplete to be defined');

    let waitSettled = false;
    wait.then(() => {
      waitSettled = true;
    }, () => {
      waitSettled = true;
    });
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    finishTurn();
    await expect(wait).resolves.toBeUndefined();
  });

  it('starts native Codex review for the first review prompt', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
      start: {
        intent: 'review',
        intentInput: {
          engineIds: ['codex'],
          changeType: 'uncommitted',
          base: { kind: 'none' },
        },
      },
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'prompt fallback text');
    await backend.waitForResponseComplete?.();

    expect(startReview).toHaveBeenCalledWith({
      target: { type: 'uncommittedChanges' },
      delivery: 'inline',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps review follow-ups on the prompt path', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
      start: {
        intent: 'review',
        intentInput: {
          kind: 'review_follow_up.v1',
          parentRunRef: { runId: 'run_1', callId: 'call_1', backendId: 'codex' },
          threadId: 'thread_1',
          messageMarkdown: 'Can you expand?',
          summary: 'Summary',
          overviewMarkdown: 'Overview',
        },
      },
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'follow-up prompt');
    await backend.waitForResponseComplete?.();

    expect(startReview).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('follow-up prompt');
  });

  it('falls back to the prompt path when native review is unavailable', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_session_runtime_method' as const,
      error: 'unsupported_session_runtime_method:review/start',
    }));
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
      start: {
        intent: 'review',
        intentInput: {
          engineIds: ['codex'],
          changeType: 'uncommitted',
          base: { kind: 'none' },
        },
      },
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'prompt fallback text');
    await backend.waitForResponseComplete?.();

    expect(startReview).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith('prompt fallback text');
  });

  it('falls back to the prompt path when a generic review omits structured review input', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => ({ ok: true as const }));
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
      start: { intent: 'review' },
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'prompt fallback text');
    await backend.waitForResponseComplete?.();

    expect(startReview).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('prompt fallback text');
  });

  it('fails clearly when review input is invalid', async () => {
    const sendPrompt = vi.fn(async () => undefined);
    const startReview = vi.fn(async () => undefined);
    createCodexAppServerRuntimeMock.mockReturnValueOnce({
      startOrLoad: async () => undefined,
      getSessionId: () => 'thread_1',
      sendPrompt,
      startReview,
      compactContext: async () => undefined,
      cancel: async () => undefined,
      reset: async () => undefined,
    });

    const { createCodexAppServerExecutionRunBackend } = await import('./createCodexAppServerExecutionRunBackend');
    const backend = createCodexAppServerExecutionRunBackend({
      cwd: '/tmp/happier-worktree',
      env: {},
      permissionMode: 'read-only' as any,
      permissionHandler: null,
      start: {
        intent: 'review',
        intentInput: {
          engineIds: [],
          changeType: 'uncommitted',
          base: { kind: 'none' },
        },
      },
    });

    await backend.startSession();
    await backend.sendPrompt('thread_1', 'prompt fallback text');
    await expect(backend.waitForResponseComplete?.()).rejects.toThrow(/Invalid review input/);

    expect(startReview).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
