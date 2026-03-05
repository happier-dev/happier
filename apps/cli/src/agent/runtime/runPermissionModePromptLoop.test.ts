import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';

function createTestSession() {
  let metadata: any = null;
  return {
    getMetadataSnapshot: vi.fn(() => metadata),
    updateMetadata: vi.fn(async (updater: (current: any) => any) => {
      metadata = updater(metadata);
    }),
    __setMetadata: (next: any) => {
      metadata = next;
    },
    __getMetadata: () => metadata,
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    popPendingMessage: vi.fn(async () => false),
    waitForMetadataUpdate: vi.fn(async () => false),
    sendAgentMessage: vi.fn(),
  } as any;
}

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: any }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function createRuntime() {
  return {
    beginTurn: vi.fn(),
    startOrLoad: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => {}),
    sendPromptWithMeta: undefined as any,
    flushTurn: vi.fn(),
    reset: vi.fn(async () => {}),
    getSessionId: vi.fn(() => 'resume-from-runtime'),
  };
}

describe('runPermissionModePromptLoop', () => {
  it('applies replay seed exactly once to the first real user prompt', async () => {
    const session = createTestSession();
    session.__setMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
        return;
      }
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(1, 'SEED\n\nhello');
    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(2, 'second');

    const finalMetadata = session.__getMetadata();
    expect(finalMetadata.replaySeedV1.appliedToLocalId).toBe('local-1');
    expect(finalMetadata.replaySeedV1.seedText).toBe('');
  });

  it('starts runtime, sends prompt, and emits ready', async () => {
    const session = createTestSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });
    const syncFromMetadata = vi.fn();
    const flushPendingAfterStart = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata, flushPendingAfterStart }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenCalledWith({});
    expect(runtime.sendPrompt).toHaveBeenCalledWith('hello');
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(flushPendingAfterStart).toHaveBeenCalledTimes(1);
    expect(syncFromMetadata).toHaveBeenCalled();
    expect(permissionHandler.setPermissionMode).toHaveBeenCalled();
  });

  it('uses sendPromptWithMeta when provided by the runtime', async () => {
    const session = createTestSession();
    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    runtime.sendPromptWithMeta = vi.fn(async () => {});
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledWith({ text: 'hello', localId: 'local-1' });
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
  });

  it('handles /clear by resetting runtime and skipping prompt send', async () => {
    const session = createTestSession();
    session.__setMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: '/clear', localId: 'local-2' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).not.toHaveBeenCalled();
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(permissionHandler.reset).toHaveBeenCalledTimes(1);
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(messageBuffer.getMessages().some((m) => m.content === 'Session reset.')).toBe(true);
    expect(session.updateMetadata).not.toHaveBeenCalled();
  });

  it('restarts when mode hash changes and replays the pending message', async () => {
    const session = createTestSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-3' }, { permissionMode: 'default' });
    queue.push({ text: 'second', localId: 'local-4' }, { permissionMode: 'read-only' });

    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => readyCount >= 2,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(1, 'first');
    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(2, 'second');
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(1, {});
    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(2, { resumeId: 'resume-from-runtime', importHistory: false });
  });

  it('falls back to fresh start when resume fails', async () => {
    const session = createTestSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    // Simulate a backend that becomes "initialized" during a resume attempt, then fails.
    // A subsequent fresh start must reset the runtime before retrying, otherwise it would
    // error like "ACP backend is already initialized".
    let initialized = false;
    runtime.startOrLoad = vi.fn(async (opts: { resumeId?: string; importHistory?: boolean }) => {
      if (opts.resumeId) {
        initialized = true;
        throw new Error('resume failed');
      }
      if (initialized) {
        throw new Error('ACP backend is already initialized');
      }
    });
    runtime.reset = vi.fn(async () => {
      initialized = false;
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-5' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-id',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(1, { resumeId: 'resume-id', importHistory: false });
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(2, {});
    expect(session.sendAgentMessage).toHaveBeenCalledWith('qwen', { type: 'message', message: 'Resume failed; starting a new session.' });
    expect(runtime.sendPrompt).toHaveBeenCalledWith('hello');
  });

  it('disables ACP replay history import when resuming a forked session (acp_fork_latest)', async () => {
    const session = createTestSession();
    session.__setMetadata({
      forkV1: {
        v: 1,
        parentSessionId: 'sess_parent',
        parentCutoffSeqInclusive: 19,
        createdAtMs: 1,
        strategy: 'acp_fork_latest',
      },
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-fork' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-id',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
  });

	  it('fails closed when strictInitialResume is enabled and the initial resume attempt fails', async () => {
	    const session = createTestSession();
	    const queue = createModeQueue();
	    const runtime = createRuntime();
	    runtime.startOrLoad = vi.fn(async (opts: { resumeId?: string; importHistory?: boolean }) => {
	      if (opts.resumeId) {
	        throw new Error('resume failed');
	      }
	    });
	    const messageBuffer = new MessageBuffer();
	    const permissionHandler = {
	      setPermissionMode: vi.fn(),
	      reset: vi.fn(),
	    } as any;

    queue.push({ text: 'hello', localId: 'local-6' }, { permissionMode: 'default' });

    let shouldExit = false;
    await expect(
      (runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
        providerName: 'Test Provider',
        agentMessageType: 'qwen',
        explicitPermissionMode: undefined,
        session,
        messageQueue: queue,
        permissionHandler,
        runtime,
        createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
        messageBuffer,
        shouldExit: () => shouldExit,
        getAbortSignal: () => new AbortController().signal,
        keepAlive: () => {},
        setThinking: () => {},
        sendReady: () => {
          shouldExit = true;
        },
        currentPermissionModeUpdatedAt: 0,
        setCurrentPermissionMode: () => {},
        setCurrentPermissionModeUpdatedAt: () => {},
        initialResumeId: 'resume-id',
        strictInitialResume: true,
        formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
      }),
	    ).rejects.toThrow('resume failed');

	    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
	    expect(runtime.sendPrompt).not.toHaveBeenCalled();
	    expect(runtime.reset).toHaveBeenCalledTimes(1);
	  });
});
