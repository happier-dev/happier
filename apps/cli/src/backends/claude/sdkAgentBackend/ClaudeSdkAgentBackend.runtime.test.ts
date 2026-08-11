import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

function noToolsPermissionHandler() {
  return createExecutionRunPermissionHandler({ backendId: 'claude', permissionMode: 'no_tools' });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const queryMock = vi.fn();
const ensureJavaScriptRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');

vi.mock('@/backends/claude/sdk/query', () => ({
  query: queryMock,
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/agent/runtime/subprocessArtifacts', () => ({
  createSubprocessStderrAppender: vi.fn(async () => null),
}));

function createQueryResult(): ReturnType<typeof queryMock> {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn(async () => {}),
  };
}

describe('ClaudeSdkAgentBackend runtime bootstrap', () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    queryMock.mockReturnValue(createQueryResult());
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK query', async () => {
    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      await backend.startSession();
    } finally {
      await backend.dispose();
    }

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          executable: '/managed/js-runtime',
        }),
      }),
    );
  });

  it('prefers query.stopTask(taskId) over query.interrupt() when cancelling a turn with an active task id', async () => {
    const taskStartedProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_1', session_id: 'sess_1' };
          taskStartedProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await taskStartedProcessed.promise;

      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_1');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('uses no-session operational task evidence as the exact cancellation target', async () => {
    const taskStartedProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_without_session' };
          taskStartedProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await taskStartedProcessed.promise;
      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_without_session');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('uses operational task evidence from an async launch user event as the exact cancellation target', async () => {
    const taskLaunchProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield {
            type: 'user',
            tool_use_result: {
              status: 'async_launched',
              task_id: 'task_from_user_launch',
            },
          };
          taskLaunchProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await taskLaunchProcessed.promise;
      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_from_user_launch');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('replaces a terminal latest task with another active blocker before cancellation', async () => {
    const terminalProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_1',
            task_type: 'local_bash',
            session_id: 'sess_1',
          };
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_2',
            task_type: 'local_bash',
            session_id: 'sess_1',
          };
          yield {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task_2',
            status: 'completed',
            session_id: 'sess_1',
          };
          terminalProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await terminalProcessed.promise;
      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_1');
      expect(stopTask).not.toHaveBeenCalledWith('task_2');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the active cancel target when a different task reports a terminal progress status', async () => {
    const interleavedTaskProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_1', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_2', session_id: 'sess_1' };
          yield {
            type: 'system',
            subtype: 'task_progress',
            task_id: 'task_1',
            session_id: 'sess_1',
            patch: { status: 'succeeded' },
          };
          interleavedTaskProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await interleavedTaskProcessed.promise;

      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_2');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the active cancel target when a different task reports a terminal task_updated status', async () => {
    const interleavedTaskProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const signal: AbortSignal | undefined = params?.options?.abort;
      const aborted = new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_1', session_id: 'sess_1' };
          yield { type: 'system', subtype: 'task_started', task_id: 'task_2', session_id: 'sess_1' };
          yield {
            type: 'system',
            subtype: 'task_updated',
            task_id: 'task_1',
            session_id: 'sess_1',
            patch: { status: 'completed' },
          };
          interleavedTaskProcessed.resolve();
          await aborted;
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess_1' };
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });

    try {
      const { sessionId } = await backend.startSession();
      await interleavedTaskProcessed.promise;

      await backend.sendPrompt(sessionId, 'hi');
      await backend.cancel(sessionId);

      expect(stopTask).toHaveBeenCalledWith('task_2');
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('keeps the backend working but accepts another prompt after a result with a background task', async () => {
    const resultProcessed = createDeferred<void>();
    const releaseBackgroundTask = createDeferred<void>();
    const firstPromptAccepted = createDeferred<void>();
    const secondPromptAccepted = createDeferred<void>();

    queryMock.mockImplementation((params: any) => {
      const prompt = params?.prompt as AsyncIterable<unknown>;
      const promptIterator = prompt[Symbol.asyncIterator]();

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_1' };
          await promptIterator.next();
          firstPromptAccepted.resolve();
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_1',
            task_type: 'local_bash',
            session_id: 'sess_1',
          };
          yield {
            type: 'user',
            session_id: 'sess_1',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Background task started' }],
            },
            tool_use_result: {
              assistantAutoBackgrounded: true,
              backgroundTaskId: 'task_1',
            },
          };
          yield {
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            session_id: 'sess_1',
            result: 'Background task is still running',
            is_error: false,
          };
          resultProcessed.resolve();
          await promptIterator.next();
          secondPromptAccepted.resolve();
          await releaseBackgroundTask.promise;
          yield {
            type: 'system',
            subtype: 'task_updated',
            task_id: 'task_1',
            patch: { status: 'killed' },
            session_id: 'sess_1',
          };
          yield {
            type: 'result',
            subtype: 'success',
            num_turns: 2,
            session_id: 'sess_1',
            result: 'Follow-up done',
            is_error: false,
          };
        },
        interrupt: vi.fn(async () => {}),
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });
    const statuses: string[] = [];
    backend.onMessage((message: any) => {
      if (message?.type === 'status') statuses.push(String(message.status));
    });

    try {
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, 'hi');
      await firstPromptAccepted.promise;
      const completion = backend.waitForResponseComplete();
      let completed = false;
      completion.then(() => {
        completed = true;
      }).catch(() => undefined);

      await resultProcessed.promise;
      await Promise.resolve();

      await completion;
      expect(completed).toBe(true);
      expect(statuses.at(-1)).not.toBe('idle');

      await backend.sendPrompt(sessionId, 'follow-up while background task is running');
      await secondPromptAccepted.promise;

      releaseBackgroundTask.resolve();

      await backend.waitForResponseComplete();
      expect(statuses.at(-1)).toBe('idle');
    } finally {
      releaseBackgroundTask.resolve();
      await backend.dispose();
    }
  });

  it('never makes another session\'s task this runtime\'s stop target, and never lets it hold the turn open', async () => {
    // The cancellation target is deliberately broader than Activity membership - a task with NO
    // session id stays actionable (pinned by the tests above). Broader is not unowned: a task that
    // NAMES another session is the one shape we can prove is not ours, and it arrives here through
    // the same typed row the identity gate already rejects. Unfiltered it does two things, both
    // wrong: `stopTask` asks the provider to kill someone else's work, and `activeTaskId` alone
    // keeps this runtime out of `idle` for as long as that foreign task lives.
    const foreignTaskProcessed = createDeferred<void>();
    const resultProcessed = createDeferred<void>();
    const stopTask = vi.fn(async (_taskId: string) => {});
    const interrupt = vi.fn(async () => {});

    queryMock.mockImplementation((params: any) => {
      const prompt = params?.prompt as AsyncIterable<unknown>;
      const promptIterator = prompt[Symbol.asyncIterator]();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'sess_mine' };
          await promptIterator.next();
          yield {
            type: 'system',
            subtype: 'task_started',
            task_id: 'task_foreign',
            task_type: 'shell',
            session_id: 'sess_someone_else',
          };
          foreignTaskProcessed.resolve();
          yield {
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            session_id: 'sess_mine',
            result: 'Done',
            is_error: false,
          };
          resultProcessed.resolve();
        },
        stopTask,
        interrupt,
      };
    });

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });
    const statuses: string[] = [];
    backend.onMessage((message: any) => {
      if (message?.type === 'status') statuses.push(String(message.status));
    });

    try {
      const { sessionId } = await backend.startSession();
      await backend.sendPrompt(sessionId, 'hi');
      await foreignTaskProcessed.promise;
      await resultProcessed.promise;
      await backend.waitForResponseComplete();

      // Nothing of OURS is running, so the turn settles.
      expect(statuses.at(-1)).toBe('idle');

      await backend.sendPrompt(sessionId, 'cancel me');
      await backend.cancel(sessionId);
      expect(stopTask).not.toHaveBeenCalled();
      expect(interrupt).toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });

  it('does not let another session\'s typed task hold this runtime open (PLAN 4.9.1 step 2)', async () => {
    // This backend owns its OWN provider-activity ledger, so it must arm the identity gate at its
    // own session-identity chokepoint (`init`/`result` -> `noteVendorSessionId`). Unarmed, a
    // `task_started` bearing a foreign `session_id` becomes an active blocker of THIS runtime and
    // is then promoted to the cancellation target when the real task finishes, so the turn never
    // settles. Nothing in this test arms the ledger: the wiring has to.
    const notificationProcessed = createDeferred<void>();

    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess_mine' };
        // `task_type: 'shell'` is a fully typed detached shape, so it ADMITS for liveness - the
        // only thing that should stop it here is that it belongs to another session.
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task_foreign',
          task_type: 'shell',
          session_id: 'sess_someone_else',
        };
        yield {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task_mine',
          task_type: 'shell',
          session_id: 'sess_mine',
        };
        yield {
          type: 'system',
          subtype: 'task_notification',
          task_id: 'task_mine',
          session_id: 'sess_mine',
          status: 'completed',
        };
        // Resumed only once the consumer has handled the notification above.
        notificationProcessed.resolve();
      },
      interrupt: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {}),
    }));

    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');
    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionHandler: noToolsPermissionHandler(),
    });
    const statuses: string[] = [];
    backend.onMessage((message: any) => {
      if (message?.type === 'status') statuses.push(String(message.status));
    });

    try {
      await backend.startSession();
      await notificationProcessed.promise;
      await Promise.resolve();

      // Our only real task reported terminal evidence, and nothing else of ours is live.
      expect(statuses.at(-1)).toBe('idle');
    } finally {
      await backend.dispose();
    }
  });
});
