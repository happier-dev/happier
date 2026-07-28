import { describe, expect, it, vi } from 'vitest';

import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { createRuntimeOverrideSynchronizers } from './createRuntimeOverrideSynchronizers';
import { formatProviderPromptErrorMessage } from './formatProviderPromptErrorMessage';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';

type PromptLoopMetadata = Metadata & {
  replaySeedV1?: any;
  forkV1?: any;
};

function createPromptLoopSession() {
  return createMutableApiSessionClientFixture<PromptLoopMetadata>();
}

function createPromptLoopMetadata(overrides: Partial<PromptLoopMetadata> = {}): PromptLoopMetadata {
  return {
    ...createTestMetadata(overrides as Partial<Metadata>),
    ...overrides,
  };
}

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: any; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
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
    sendPrompt: vi.fn<(message: string) => Promise<void>>(async () => {}),
    sendPromptWithMeta: undefined as any,
    compactContext: undefined as undefined | ((command: string) => Promise<void>),
    flushTurn: vi.fn(),
    reset: vi.fn(async () => {}),
    getSessionId: vi.fn(() => 'resume-from-runtime'),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
  };
}

async function waitForPromptLoopTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('runPermissionModePromptLoop', () => {
  it('applies replay seed exactly once to the first real user prompt', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata({
      ...createPromptLoopMetadata({
        permissionMode: 'default',
        permissionModeUpdatedAt: 0,
      }),
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

    queue.push({
      text: 'hello',
      localId: 'local-1',
      meta: { sessionWorkStateRequestV1: { refresh: true } },
    } as any, { permissionMode: 'default' });

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
    expect(finalMetadata?.replaySeedV1?.appliedToLocalId).toBe('local-1');
    expect(finalMetadata?.replaySeedV1?.seedText).toBe('');
  });

  it('starts runtime, sends prompt, and emits ready', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({
      text: 'hello',
      localId: 'local-1',
      meta: { sessionWorkStateRequestV1: { refresh: true } },
    }, { permissionMode: 'default' });

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
    expect(flushPendingAfterStart.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(syncFromMetadata).toHaveBeenCalled();
    expect(permissionHandler.setPermissionMode).toHaveBeenCalled();
  });

  it('does not begin queued prompt work when exit is requested while waiting for input', async () => {
    const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
      overrides: {
        shouldAttemptPendingMaterialization: vi.fn(() => false),
        waitForMetadataUpdate: vi.fn(async (abortSignal?: AbortSignal) =>
          await new Promise<boolean>((resolve) => {
            if (abortSignal?.aborted) {
              resolve(false);
              return;
            }
            abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
          })),
      } as Partial<ApiSessionClient>,
    });
    Reflect.deleteProperty(session, 'materializeNextPendingMessageSafely');
    const queue = createModeQueue();
    const waitForMessagesSignal = vi.spyOn(queue, 'waitForMessagesSignal');
    const runtime = createRuntime();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const setCurrentPermissionMode = vi.fn();
    let shouldExit = false;

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: vi.fn(),
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await expect.poll(() => waitForMessagesSignal.mock.calls.length).toBe(1);
    const permissionModeMutationCount = permissionHandler.setPermissionMode.mock.calls.length;
    const currentPermissionModeMutationCount = setCurrentPermissionMode.mock.calls.length;

    shouldExit = true;
    queue.push({ text: 'must not start', localId: 'local-after-exit' }, { permissionMode: 'acceptEdits' });
    await loopPromise;

    expect(permissionHandler.setPermissionMode).toHaveBeenCalledTimes(permissionModeMutationCount);
    expect(setCurrentPermissionMode).toHaveBeenCalledTimes(currentPermissionModeMutationCount);
    expect(runtime.beginTurn).not.toHaveBeenCalled();
    expect(runtime.startOrLoad).not.toHaveBeenCalled();
    expect(runtime.reset).not.toHaveBeenCalled();
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
  });

  it('waits for the queued user transcript row before sending the provider prompt', async () => {
    let resolveCommittedUserSeq!: (seq: number) => void;
    const committedUserSeq = new Promise<number>((resolve) => {
      resolveCommittedUserSeq = resolve;
    });
    const waitForCommittedUserMessageSeq = vi.fn(async () => committedUserSeq);
    const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
      overrides: {
        getCommittedUserMessageSeq: vi.fn(() => null),
        waitForCommittedUserMessageSeq,
      } as Partial<ApiSessionClient>,
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
    const runPromise = runPermissionModePromptLoop({
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
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await waitForPromptLoopTick();

    expect(waitForCommittedUserMessageSeq).toHaveBeenCalledWith('local-1', expect.any(Object));
    expect(runtime.sendPrompt).not.toHaveBeenCalled();

    resolveCommittedUserSeq(7);
    await runPromise;

    expect(runtime.sendPrompt).toHaveBeenCalledWith('hello');
  });

  it('does not begin turn or runtime work when exit is requested during a pre-prompt await', async () => {
    let resolveCommittedUserSeq!: (seq: number) => void;
    const committedUserSeq = new Promise<number>((resolve) => {
      resolveCommittedUserSeq = resolve;
    });
    const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
      overrides: {
        getCommittedUserMessageSeq: vi.fn(() => null),
        waitForCommittedUserMessageSeq: vi.fn(async () => committedUserSeq),
      } as Partial<ApiSessionClient>,
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const setCurrentPermissionMode = vi.fn();
    const sendReady = vi.fn();
    let shouldExit = false;

    queue.push({ text: 'must not start', localId: 'local-pre-prompt-exit' }, { permissionMode: 'default' });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode,
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await waitForPromptLoopTick();
    const permissionModeMutationCount = permissionHandler.setPermissionMode.mock.calls.length;
    const currentPermissionModeMutationCount = setCurrentPermissionMode.mock.calls.length;

    shouldExit = true;
    resolveCommittedUserSeq(7);
    await loopPromise;

    expect(permissionHandler.setPermissionMode).toHaveBeenCalledTimes(permissionModeMutationCount);
    expect(setCurrentPermissionMode).toHaveBeenCalledTimes(currentPermissionModeMutationCount);
    expect(runtime.beginTurn).not.toHaveBeenCalled();
    expect(runtime.startOrLoad).not.toHaveBeenCalled();
    expect(runtime.reset).not.toHaveBeenCalled();
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(runtime.flushTurn).not.toHaveBeenCalled();
    expect(sendReady).not.toHaveBeenCalled();
  });

  it('can eagerly start the runtime before the first prompt arrives', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    let shouldExit = false;
    const readySpy = vi.fn();
    const onAfterStart = vi.fn(async () => {
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
      onAfterStart,
      startRuntimeBeforeFirstPrompt: true,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenCalledWith({});
    expect(onAfterStart).toHaveBeenCalledTimes(1);
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(readySpy).not.toHaveBeenCalled();
  });

  it('preserves the fresh-session system prompt when eager startup happens before the first prompt', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      if (runtime.sendPrompt.mock.calls.length === 0) return;
      shouldExit = true;
    });
    const onAfterStart = vi.fn(async () => {
      queue.push(
        { text: 'hello', localId: 'local-eager-1' },
        { permissionMode: 'default', appendSystemPrompt: 'APPEND' } as any,
      );
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue as any,
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
      onAfterStart,
      startRuntimeBeforeFirstPrompt: true,
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) => baseOverride === undefined ? 'FALLBACK' : baseOverride ?? '',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenCalledTimes(1);
    expect(runtime.sendPrompt).toHaveBeenCalledWith('APPEND\n\nhello');
  });

  it('uses sendPromptWithMeta when provided by the runtime', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    runtime.sendPromptWithMeta = vi.fn(async () => {});
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({
      text: 'hello',
      localId: 'local-1',
      meta: { sessionWorkStateRequestV1: { refresh: true } },
    }, { permissionMode: 'default' });

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

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledWith({
      text: 'hello',
      localId: 'local-1',
      meta: { sessionWorkStateRequestV1: { refresh: true } },
    });
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
  });

  it('formats object-shaped prompt errors without leaking [object Object] into the transcript', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendPrompt = vi.fn(async () => {
      throw {
        code: -32603,
        message: 'Internal error',
        data: 'Prompt already in progress',
      };
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-object-error' }, { permissionMode: 'default' });

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
      formatPromptErrorMessage: formatProviderPromptErrorMessage,
    });

    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: expect.stringContaining('"message": "Internal error"'),
    });
    const sentMessages = sendAgentMessageSpy.mock.calls.map((call) =>
      'message' in call[1] ? call[1].message ?? '' : '',
    );
    expect(sentMessages.join('\n')).not.toContain('[object Object]');
  });

  it('does not surface abort-like prompt failures as agent messages', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    runtime.sendPromptWithMeta = vi.fn(async () => {
      throw new Error('OpenCode session aborted');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-abort-error' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'opencode',
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
      formatPromptErrorMessage: formatProviderPromptErrorMessage,
    });

    expect(sendAgentMessageSpy).not.toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'message',
    }));
  });

  it('does not turn runtime-handled provider status errors into assistant transcript messages', async () => {
    const session = createPromptLoopSession();
    const sentMessages: unknown[] = [];
    vi.spyOn(session, 'sendAgentMessage').mockImplementation((_provider, body) => {
      sentMessages.push(body);
    });

    let backend!: ReturnType<typeof createFakeAcpRuntimeBackend>;
    backend = createFakeAcpRuntimeBackend({
      sessionId: 'pi-session-status-error',
      sendPrompt: async () => {
        backend.emit({ type: 'status', status: 'error', detail: 'Model not found.' } satisfies AgentMessage);
      },
      waitForResponseComplete: async () => {
        throw new Error('Model not found.');
      },
    });

    const queue = createModeQueue();
    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });
    // This prompt-loop slice exercises only permission-mode synchronization hooks.
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['permissionHandler'];

    queue.push({ text: 'hello', localId: 'local-status-error' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Pi',
      agentMessageType: 'pi',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
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
      formatPromptErrorMessage: formatProviderPromptErrorMessage,
    });

    const assistantText = sentMessages
      .filter((message): message is { type: 'message'; message: string } => {
        if (!message || typeof message !== 'object') return false;
        const record = message as { type?: unknown; message?: unknown };
        return record.type === 'message' && typeof record.message === 'string';
      })
      .map((message) => message.message)
      .join('\n');
    expect(assistantText).not.toContain('Model not found');
    await expect.poll(() => sentMessages.some((message) => {
      if (!message || typeof message !== 'object') return false;
      return (message as { type?: unknown }).type === 'turn_failed';
    })).toBe(true);
  });

  it('refreshes the session snapshot and re-syncs metadata overrides before sending the next queued prompt when queue delivery wins the race', async () => {
    const session = createPromptLoopSession();
    const initialMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    });
    let serverMetadata: PromptLoopMetadata = initialMetadata;
    session.__setMetadata(initialMetadata);
    const refreshSessionSnapshotSpy = vi.fn(async () => {
      session.__setMetadata(serverMetadata);
    });
    session.refreshSessionSnapshotFromServerBestEffort = refreshSessionSnapshotSpy;

    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    const promptSnapshots: Array<{ modeId: string | null; modelId: string | null }> = [];
    let selectedModeId: string | null = null;
    let selectedModelId: string | null = null;
    runtime.sendPromptWithMeta = vi.fn(async () => {
      promptSnapshots.push({ modeId: selectedModeId, modelId: selectedModelId });
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        serverMetadata = createPromptLoopMetadata({
          permissionMode: 'default',
          permissionModeUpdatedAt: 0,
          acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
          modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/gpt-5.2' },
        });
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
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime: {
            setSessionMode: async (modeId: string) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              selectedModeId = modeId;
            },
            setSessionModel: async (modelId: string) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              selectedModelId = modelId;
            },
            setSessionConfigOption: async () => {},
          },
          isStarted,
        }),
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

    expect(promptSnapshots).toEqual([
      { modeId: null, modelId: null },
      { modeId: 'plan', modelId: 'openai/gpt-5.2' },
    ]);
    expect(refreshSessionSnapshotSpy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('applies overrides discovered by the post-start snapshot refresh before the first prompt', async () => {
    const session = createPromptLoopSession();
    const initialMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    });
    const serverMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/gpt-5.2' },
    });
    session.__setMetadata(initialMetadata);
    let refreshCount = 0;
    session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount >= 2) {
        session.__setMetadata(serverMetadata);
      }
    });

    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    const promptSnapshots: string[] = [];
    let selectedModelId: string | null = null;
    runtime.sendPromptWithMeta = vi.fn(async () => {
      promptSnapshots.push(selectedModelId ?? '');
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });
    let resolveModelApply = (): void => {
      throw new Error('Expected model apply to be waiting');
    };
    const modelApplyStarted = { value: false };
    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime: {
            setSessionMode: async () => {},
            setSessionModel: async (modelId: string) => {
              modelApplyStarted.value = true;
              await new Promise<void>((resolve) => {
                resolveModelApply = resolve;
              });
              selectedModelId = modelId;
            },
            setSessionConfigOption: async () => {},
          },
          isStarted,
        }),
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

    for (let index = 0; index < 10 && !modelApplyStarted.value; index += 1) {
      await waitForPromptLoopTick();
    }

    expect(modelApplyStarted.value).toBe(true);
    await waitForPromptLoopTick();
    expect(runtime.sendPromptWithMeta).not.toHaveBeenCalled();

    resolveModelApply();
    await loopPromise;

    expect(promptSnapshots).toEqual(['openai/gpt-5.2']);
  });

  it('refreshes the session snapshot and applies metadata overrides while idle even without a new queued prompt', async () => {
    const session = createPromptLoopSession();
    const initialMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    });
    let serverMetadata: PromptLoopMetadata = initialMetadata;
    session.__setMetadata(initialMetadata);
    session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {
      session.__setMetadata(serverMetadata);
    });

    const metadataWakeRef: { current: ((value: boolean) => void) | null } = { current: null };
    session.waitForMetadataUpdate = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          metadataWakeRef.current = resolve;
        }),
    );

    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    runtime.sendPromptWithMeta = vi.fn(async () => {});

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const abortController = new AbortController();
    let shouldExit = false;
    let appliedModeId: string | null = null;
    let appliedModelId: string | null = null;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount !== 1) return;
      serverMetadata = createPromptLoopMetadata({
        permissionMode: 'default',
        permissionModeUpdatedAt: 0,
        acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/gpt-5.2' },
      });
    });

    const appliedPromise = new Promise<void>((resolve) => {
      const maybeResolve = () => {
        if (appliedModeId !== 'plan' || appliedModelId !== 'openai/gpt-5.2') return;
        shouldExit = true;
        abortController.abort();
        resolve();
      };

      runtime.__setAppliedMode = (modeId: string) => {
        appliedModeId = modeId;
        maybeResolve();
      };
      runtime.__setAppliedModel = (modelId: string) => {
        appliedModelId = modelId;
        maybeResolve();
      };
    });

    const loopPromise = runPermissionModePromptLoop({
        providerName: 'Test Provider',
        agentMessageType: 'qwen',
        explicitPermissionMode: undefined,
        session,
        messageQueue: queue,
        permissionHandler,
        runtime,
        createOverrideSynchronizer: (isStarted) =>
          createRuntimeOverrideSynchronizers({
            session,
            runtime: {
              setSessionMode: async (modeId: string) => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                runtime.__setAppliedMode(modeId);
              },
              setSessionModel: async (modelId: string) => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                runtime.__setAppliedModel(modelId);
              },
              setSessionConfigOption: async () => {},
            },
            isStarted,
          }),
        messageBuffer,
        shouldExit: () => shouldExit,
        getAbortSignal: () => abortController.signal,
        keepAlive: () => {},
        setThinking: () => {},
        sendReady: readySpy,
        currentPermissionModeUpdatedAt: 0,
        setCurrentPermissionMode: () => {},
        setCurrentPermissionModeUpdatedAt: () => {},
        formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
      });

    for (let index = 0; index < 10 && !metadataWakeRef.current; index += 1) {
      await waitForPromptLoopTick();
    }
    const wake = metadataWakeRef.current;
    if (!wake) {
      throw new Error('Expected metadata waiter to be registered');
    }
    wake(true);

    await Promise.race([loopPromise, appliedPromise]);

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledTimes(1);
    expect(appliedModeId).toBe('plan');
    expect(appliedModelId).toBe('openai/gpt-5.2');
    expect(session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalled();
  });

  it('does not refresh the session snapshot twice for the same queued prompt boundary after runtime startup', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const refreshSessionSnapshotSpy = vi.fn(async () => {});
    session.refreshSessionSnapshotFromServerBestEffort = refreshSessionSnapshotSpy;

    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        refreshSessionSnapshotSpy.mockClear();
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
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime: {
            setSessionMode: async () => {},
            setSessionModel: async () => {},
            setSessionConfigOption: async () => {},
          },
          isStarted,
        }),
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

    expect(runtime.sendPrompt).toHaveBeenCalledTimes(2);
    expect(refreshSessionSnapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('applies socket-updated metadata overrides that arrived during the turn before waiting again', async () => {
    const session = createPromptLoopSession();
    const initialMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    });
    session.__setMetadata(initialMetadata);
    session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {});
    session.waitForMetadataUpdate = vi.fn(async () => false);

    const queue = createModeQueue();
    const runtime = createRuntime() as any;
    let resolvePromptSend: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      runtime.sendPromptWithMeta = vi.fn(
        () =>
          new Promise<void>((sendResolve) => {
            resolvePromptSend = sendResolve;
            resolve();
          }),
      );
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const abortController = new AbortController();
    let shouldExit = false;
    let appliedModeId: string | null = null;
    let appliedModelId: string | null = null;
    const readySpy = vi.fn();

    const appliedPromise = new Promise<void>((resolve) => {
      const maybeResolve = () => {
        if (appliedModeId !== 'plan' || appliedModelId !== 'openai/gpt-5.2') return;
        shouldExit = true;
        abortController.abort();
        resolve();
      };

      runtime.__setAppliedMode = (modeId: string) => {
        appliedModeId = modeId;
        maybeResolve();
      };
      runtime.__setAppliedModel = (modelId: string) => {
        appliedModelId = modelId;
        maybeResolve();
      };
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime: {
            setSessionMode: async (modeId: string) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              runtime.__setAppliedMode(modeId);
            },
            setSessionModel: async (modelId: string) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              runtime.__setAppliedModel(modelId);
            },
            setSessionConfigOption: async () => {},
          },
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await promptStarted;
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/gpt-5.2' },
    }));
    const releasePromptSend = resolvePromptSend;
    if (!releasePromptSend) {
      throw new Error('Expected prompt send to be waiting');
    }
    releasePromptSend();

    await appliedPromise;
    await loopPromise;

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledTimes(1);
    expect(appliedModeId).toBe('plan');
    expect(appliedModelId).toBe('openai/gpt-5.2');
    expect(session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalled();
  });

  it('prepends appendSystemPrompt on the first fresh-session prompt only', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default', appendSystemPrompt: 'APPEND' } as any);

    let shouldExit = false;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default', appendSystemPrompt: 'APPEND' } as any);
        return;
      }
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue as any,
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
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) => baseOverride === undefined ? 'FALLBACK' : baseOverride ?? '',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(1, 'APPEND\n\nhello');
    expect(runtime.sendPrompt).toHaveBeenNthCalledWith(2, 'second');
  });

  it('does not prepend appendSystemPrompt when resuming an existing provider session', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default', appendSystemPrompt: 'APPEND' } as any);

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue as any,
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
      initialResumeId: 'resume-1',
      resolveFreshSessionSystemPrompt: async ({ baseOverride }) => baseOverride === undefined ? 'FALLBACK' : baseOverride ?? '',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-1', importHistory: false });
    expect(runtime.sendPrompt).toHaveBeenCalledWith('hello');
  });

  it('handles /clear by resetting runtime and skipping prompt send', async () => {
    const session = createPromptLoopSession();
    const updateMetadataSpy = vi.spyOn(session, 'updateMetadata');
    session.__setMetadata({
      ...createPromptLoopMetadata({
        permissionMode: 'default',
        permissionModeUpdatedAt: 0,
      }),
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
    expect(updateMetadataSpy).not.toHaveBeenCalled();
  });

  it('handles /compact through a runtime compaction hook without sending it as a normal prompt', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata({
      ...createPromptLoopMetadata({
        permissionMode: 'default',
        permissionModeUpdatedAt: 0,
      }),
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
    runtime.compactContext = vi.fn(async () => {});
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: '/compact keep latest task details', localId: 'local-compact' }, { permissionMode: 'default' });

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

    expect(runtime.startOrLoad).toHaveBeenCalledTimes(1);
    expect(runtime.compactContext).toHaveBeenCalledWith('/compact keep latest task details');
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(runtime.sendPromptWithMeta).toBeUndefined();
    expect(readySpy).toHaveBeenCalledTimes(1);
  });

  it('restarts when mode hash changes and replays the pending message', async () => {
    const session = createPromptLoopSession();
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

  it('drops vendor resume without transcript replay when permission settings change on a runtime that requires a fresh session', async () => {
    const fetchRecentTranscriptTextItemsForAcpImport = vi.fn(async () => [
      { role: 'user' as const, text: 'Remember project codename CONTEXT-ALPHA.' },
      { role: 'agent' as const, text: 'I will keep CONTEXT-ALPHA in mind.' },
      { role: 'user' as const, text: 'second' },
    ]);
    const session = createMutableApiSessionClientFixture<PromptLoopMetadata>({
      overrides: { fetchRecentTranscriptTextItemsForAcpImport } satisfies Partial<ApiSessionClient>,
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.shouldResumeAfterPermissionModeChange = vi.fn(() => false);
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'first', localId: 'local-3b' }, { permissionMode: 'default' });
    queue.push({ text: 'second', localId: 'local-4b' }, { permissionMode: 'read-only' });

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
    const secondPrompt = String(runtime.sendPrompt.mock.calls[1]?.[0] ?? '');
    expect(secondPrompt).toBe('second');
    expect(fetchRecentTranscriptTextItemsForAcpImport).not.toHaveBeenCalled();
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(1, {});
    expect(runtime.startOrLoad).toHaveBeenNthCalledWith(2, {});
  });

  it('falls back to fresh start when resume fails', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
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
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', { type: 'message', message: 'Resume failed; starting a new session.' });
    expect(runtime.sendPrompt).toHaveBeenCalledWith('hello');
  });

  it('does not reset or fall back to create when resume rejects after exit is requested', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime();
    let rejectResume!: (error: Error) => void;
    let markResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    runtime.startOrLoad = vi.fn(async (opts: { resumeId?: string }) => {
      if (!opts.resumeId) return;
      markResumeStarted();
      await new Promise<never>((_, reject) => {
        rejectResume = reject;
      });
    });
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const sendReady = vi.fn();
    let shouldExit = false;

    queue.push({ text: 'must not start', localId: 'local-resume-exit' }, { permissionMode: 'default' });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-id',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await resumeStarted;
    shouldExit = true;
    rejectResume(new Error('resume stopped during termination'));
    await loopPromise;

    expect(runtime.startOrLoad).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
    expect(runtime.beginTurn).toHaveBeenCalledTimes(1);
    expect(runtime.reset).not.toHaveBeenCalled();
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(runtime.flushTurn).not.toHaveBeenCalled();
    expect(sendAgentMessageSpy).not.toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: 'Resume failed; starting a new session.',
    });
    expect(sendReady).not.toHaveBeenCalled();
  });

  it('disables ACP replay history import when resuming a forked session (acp_fork_latest)', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata({
      ...createPromptLoopMetadata(),
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

  it('fails closed without masking the strict initial resume error', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoad = vi.fn(async (opts: { resumeId?: string; importHistory?: boolean }) => {
      if (opts.resumeId) {
        throw new Error('resume failed');
      }
    });
    runtime.flushTurn = vi.fn(async () => {
      throw new Error('flush failed');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-6' }, { permissionMode: 'default' });

    let shouldExit = false;
    const error = await (runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
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
    }).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('StrictInitialResumeError');
    expect((error as Error).message).toContain('Strict initial resume failed');
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(((error as Error & { cause?: Error }).cause as Error).message).toBe('resume failed');
    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.flushTurn).toHaveBeenCalledTimes(1);
  });

  it('fails closed on resume failure when the provider requires non-silent resume', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoad = vi.fn(async (opts: { resumeId?: string; importHistory?: boolean }) => {
      if (opts.resumeId) {
        throw new Error('session not found');
      }
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-7' }, { permissionMode: 'default' });

    const error = await (runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
      providerName: 'Test Provider',
      agentMessageType: 'cursor',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => false,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-id',
      failClosedOnResumeFailure: true,
      formatPromptErrorMessage: (caught: unknown) => `Error: ${String(caught)}`,
    }).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ResumeFailClosedError');
    expect(runtime.startOrLoad).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoad).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
    expect(runtime.reset).toHaveBeenCalledTimes(1);
    expect(runtime.sendPrompt).not.toHaveBeenCalled();
  });
});
