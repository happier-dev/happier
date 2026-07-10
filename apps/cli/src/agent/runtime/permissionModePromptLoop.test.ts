import { describe, expect, it, vi } from 'vitest';

import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { createRuntimeOverrideSynchronizers } from './createRuntimeOverrideSynchronizers';
import { formatProviderPromptErrorMessage } from './formatProviderPromptErrorMessage';
import {
  createRuntimeTurnFailureAlreadySurfacedError,
  type RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
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
  return new MessageQueue2<{
    permissionMode: any;
    appendSystemPrompt?: string | null;
    model?: string;
    suppressUserEcho?: boolean;
    providerPromptAlreadyResolved?: boolean;
  }, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function createRuntime() {
  const operations = {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => {}),
    sendTurnPrompt: vi.fn(async () => {}),
    steerInFlightTurn: vi.fn(async () => {}),
    waitForTurnCompletion: vi.fn(async () => {}),
    subscribeRuntimeEvents: vi.fn(() => () => {}),
    respondToPermission: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'resume-from-runtime' })),
    updateSessionRuntimeConfig: vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async () => {}),
    resetOrDisposeRuntime: vi.fn(async () => {}),
    compactContext: undefined as undefined | ((command: string) => Promise<void>),
    sendPromptWithMeta: undefined as undefined | ((params: {
      text: string;
      localId?: string | null;
      localIds?: readonly string[];
      modelId?: string | null;
      providerClaimedPendingLocalIds?: readonly string[];
      userMessageSeq?: number | null;
      userMessageSeqs?: readonly number[];
    }) => Promise<void>),
    shouldResumeAfterPermissionModeChange: vi.fn(() => true),
  };
  return operations;
}

function localIdentityMeta(localId: string) {
  return { localId, localIds: [localId] };
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'SEED\n\nhello', localIdentityMeta('local-1'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-2'));

    const finalMetadata = session.__getMetadata();
    expect(finalMetadata?.replaySeedV1?.appliedToLocalId).toBe('local-1');
    expect(finalMetadata?.replaySeedV1?.seedText).toBe('');
  });

  it('replays already-resolved provider prompts literally without echo, command parsing, or replay seed reapplication', async () => {
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

    queue.push(
      { text: 'RESOLVED\n\n/clear', localId: null, userMessageSeq: 77 },
      { permissionMode: 'default', suppressUserEcho: true, providerPromptAlreadyResolved: true },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('RESOLVED\n\n/clear', {
      userMessageSeq: 77,
      userMessageSeqs: [77],
    });
    expect(messageBuffer.getMessages().some((message) => message.type === 'user')).toBe(false);
    expect(session.__getMetadata()?.replaySeedV1?.seedText).toBe('SEED');
  });

  it('dispatches provider-claimed pending prompts without waiting for a committed transcript seq', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const localId = 'pending-provider-claim-1';
    session.hasPendingQueueMaterializedLocalId = vi.fn((candidate: string) => candidate === localId) as any;
    let shouldExit = false;
    session.getCommittedUserMessageSeq = vi.fn(() => null) as any;
    session.waitForCommittedUserMessageSeq = vi.fn(async () => {
      shouldExit = true;
      return null;
    }) as any;

    queue.push(
      {
        text: 'provider-claimed prompt',
        localId,
        localIds: [localId],
        providerClaimedPendingLocalIds: [localId],
      },
      { permissionMode: 'default', suppressUserEcho: true },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(session.waitForCommittedUserMessageSeq).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('provider-claimed prompt', {
      ...localIdentityMeta(localId),
      providerClaimedPendingLocalIds: [localId],
    });
  });

  it('blocks provider-claimed pending prompts when runtime startup fails before provider send', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const localId = 'pending-provider-startup-failure';
    session.blockPendingMessageDelivery = vi.fn(async () => true) as any;
    session.confirmUserMessageDeliveredToProvider = vi.fn() as any;
    runtime.startOrLoadSession = vi.fn(async () => {
      throw new Error('Codex CLI unavailable');
    });

    queue.push(
      {
        text: 'provider-claimed startup failure prompt',
        localId,
        localIds: [localId],
        providerClaimedPendingLocalIds: [localId],
      },
      { permissionMode: 'default', suppressUserEcho: true },
    );

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Codex',
      agentMessageType: 'codex',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(session.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: [localId],
      reason: 'runtime_disposed_before_delivery',
    });
    expect(session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
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

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });
    const syncFromMetadata = vi.fn();
    const flushPendingAfterStart = vi.fn(async () => {});
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      onAfterLoopBoundary,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({});
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-1'));
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(flushPendingAfterStart).toHaveBeenCalledTimes(2);
    expect(syncFromMetadata).toHaveBeenCalled();
    expect(permissionHandler.setPermissionMode).toHaveBeenCalled();
    expect(onAfterLoopBoundary).toHaveBeenCalledWith({ reason: 'turn_completed' });
  });

  it('surfaces a non-abort turn-completion failure and keeps looping instead of escaping fatally', async () => {
    // A classified terminal runtime issue (e.g. Claude unified injection/acceptance failure)
    // thrown from waitForTurnCompletion must NOT propagate out of the loop into a process-killing
    // fatal. It surfaces to the transcript and the loop re-enters on the next queued message.
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');

    let completionCalls = 0;
    runtime.waitForTurnCompletion = vi.fn(async () => {
      completionCalls += 1;
      if (completionCalls === 1) {
        throw new Error('Claude unified terminal prompt is awaiting provider acceptance: injection_failed');
      }
    });

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        // Re-enter on a new message after the surfaced failure.
        queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
        return;
      }
      shouldExit = true;
    });

    await expect(runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    })).resolves.toBeUndefined();

    // The failure was surfaced to the transcript and the loop continued to the second prompt.
    expect(sendAgentMessage).toHaveBeenCalledWith('qwen', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('awaiting provider acceptance'),
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-2'));
  });

  it('does not duplicate a turn-completion failure already surfaced by a runtime event', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');

    runtime.waitForTurnCompletion = vi.fn(async () => {
      throw createRuntimeTurnFailureAlreadySurfacedError({
        message: 'Plugin session runtime turn failed: OpenCode permission request was denied.',
        event: {
          kind: 'turn-failed',
          sessionId: session.sessionId,
          emittedAtMs: 2,
          turnId: 'turn-1',
          issue: {
            v: 1,
            scope: 'primary_session',
            status: 'failed',
            code: 'opencode_permission_denied',
            source: 'permission_blocked',
            agentId: 'opencode',
            occurredAt: 2,
            sanitizedPreview: 'OpenCode permission request was denied.',
          },
        },
      });
    });

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    await expect(runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    })).resolves.toBeUndefined();

    expect(sendAgentMessage).not.toHaveBeenCalledWith('qwen', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('OpenCode permission request was denied'),
    }));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(readySpy).toHaveBeenCalledTimes(1);
  });

  it('parks a CLASSIFIED steer-acceptance injection failure and relaunches on the next message (incident pid-82626, T2b)', async () => {
    // Incident shape: a ui_pending steer was injected, provider acceptance never arrived, the
    // ambiguous retry was exhausted and the runtime rejected the turn with a CLASSIFIED error
    // (stable code + failureState). Classification must not read as abort-like: the loop surfaces
    // the failure, parks on the queue, and delivers the NEXT message in the same loop — never a
    // process-killing fatal.
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');

    class ClassifiedInjectionFailureError extends Error {
      readonly code = 'claude_unified_terminal_injection_failed';
      readonly failureState = 'failed_terminal';

      constructor() {
        super('Claude unified terminal prompt is awaiting provider acceptance: ambiguous_provider_acceptance');
        this.name = 'ClaudeUnifiedTerminalInjectionFailureError';
      }
    }

    let completionCalls = 0;
    runtime.waitForTurnCompletion = vi.fn(async () => {
      completionCalls += 1;
      if (completionCalls === 1) {
        throw new ClassifiedInjectionFailureError();
      }
    });

    queue.push({ text: 'steer that never got accepted', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    let dispatchCountAtRelaunchWake = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
      if (readyCount === 1) {
        // Parked: no eager relaunch happened before the next message arrived.
        dispatchCountAtRelaunchWake = (runtime.sendTurnPrompt as ReturnType<typeof vi.fn>).mock.calls.length;
        queue.push({ text: 'next message after the park', localId: 'local-2' }, { permissionMode: 'default' });
        return;
      }
      shouldExit = true;
    });

    await expect(runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    })).resolves.toBeUndefined();

    // Surfaced (not silent, not fatal), parked (1 dispatch when the next message arrived),
    // and the next message relaunched the turn in the SAME loop.
    expect(sendAgentMessage).toHaveBeenCalledWith('qwen', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('awaiting provider acceptance'),
    }));
    expect(dispatchCountAtRelaunchWake).toBe(1);
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'next message after the park', localIdentityMeta('local-2'));
  });

  it('still propagates an abort-like turn-completion failure (shutdown path)', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    runtime.waitForTurnCompletion = vi.fn(async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });

    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });

    // Abort-like errors are the shutdown signal and must not be swallowed into a surfaced message;
    // the loop simply does not surface them as a turn failure.
    const sendAgentMessage = vi.spyOn(session, 'sendAgentMessage');
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    }).catch(() => undefined);

    expect(sendAgentMessage).not.toHaveBeenCalledWith('qwen', expect.objectContaining({
      message: expect.stringContaining('aborted'),
    }));
  });

  it('waits for the queued user transcript row before beginning the provider turn', async () => {
    const session = createPromptLoopSession();
    const callOrder: string[] = [];
    Object.assign(session, {
      hasPendingQueueMaterializedLocalId: vi.fn((localId: string) => localId === 'local-committed-1'),
      getCommittedUserMessageSeq: vi.fn(() => null),
      waitForCommittedUserMessageSeq: vi.fn(async (localId: string, options?: { timeoutMs?: number; pollMs?: number }) => {
        callOrder.push(`wait:${localId}:${options?.timeoutMs ?? 'none'}:${options?.pollMs ?? 'none'}`);
        return 42;
      }),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.beginTurnLifecycle = vi.fn(() => {
      callOrder.push('begin-turn');
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      callOrder.push('send-prompt');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-committed-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(callOrder[0]).toMatch(/^wait:local-committed-1:/);
    expect(callOrder).toEqual([
      expect.stringMatching(/^wait:local-committed-1:/),
      'begin-turn',
      'send-prompt',
    ]);
  });

  it('waits for direct queued local prompts to commit before provider dispatch', async () => {
    const session = createPromptLoopSession();
    const callOrder: string[] = [];
    Object.assign(session, {
      hasPendingQueueMaterializedLocalId: vi.fn(() => false),
      getCommittedUserMessageSeq: vi.fn(() => null),
      waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => {
        callOrder.push(`wait:${localId}`);
        return 42;
      }),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.beginTurnLifecycle = vi.fn(() => {
      callOrder.push('begin-turn');
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      callOrder.push('send-prompt');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-direct-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(callOrder).toEqual([
      'wait:local-direct-1',
      'begin-turn',
      'send-prompt',
    ]);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', {
      localId: 'local-direct-1',
      localIds: ['local-direct-1'],
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
  });

  it('defers provider dispatch when the pending-queue materialized user transcript row has not committed yet', async () => {
    const session = createPromptLoopSession();
    const callOrder: string[] = [];
    let waitCount = 0;
    Object.assign(session, {
      hasPendingQueueMaterializedLocalId: vi.fn((localId: string) => localId === 'local-committed-late'),
      getCommittedUserMessageSeq: vi.fn(() => null),
      waitForCommittedUserMessageSeq: vi.fn(async (localId: string, options?: { timeoutMs?: number; pollMs?: number }) => {
        waitCount += 1;
        callOrder.push(`wait:${localId}:${waitCount}:${options?.timeoutMs ?? 'none'}:${options?.pollMs ?? 'none'}`);
        return waitCount === 1 ? null : 42;
      }),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.beginTurnLifecycle = vi.fn(() => {
      callOrder.push('begin-turn');
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      callOrder.push('send-prompt');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-committed-late' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', {
      ...localIdentityMeta('local-committed-late'),
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });
    expect(callOrder).toEqual([
      expect.stringMatching(/^wait:local-committed-late:1:/),
      expect.stringMatching(/^wait:local-committed-late:2:/),
      'begin-turn',
      'send-prompt',
    ]);
  });

  it('sends already-echoed queued prompts without duplicating the user transcript row', async () => {
    const session = createPromptLoopSession();
    const queue = new MessageQueue2<
      { permissionMode: any; appendSystemPrompt?: string | null; suppressUserEcho?: boolean },
      PermissionModeQueuedPrompt
    >(
      (mode) => mode.permissionMode,
      {
        batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
      },
    );
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'recover as a new turn', localId: 'local-already-echoed' },
      { permissionMode: 'default', suppressUserEcho: true },
    );

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['messageQueue'],
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('recover as a new turn', localIdentityMeta('local-already-echoed'));
    expect(messageBuffer.getMessages().filter((message) => message.type === 'user')).toEqual([]);
  });

  it('does not skip queued provider prompts that only reached local queue handoff', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      userMessageDeliveryWatermarkModeV1: 'queueHandoff',
      deliveredUserMessageSeqV1: 1,
    }));
    Object.assign(session, {
      getDeliveredUserMessageSeq: vi.fn(() => 1),
      getProviderAcceptedUserMessageSeq: vi.fn(() => null),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'local handoff only', localId: 'local-delivered', userMessageSeq: 1 },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'fresh prompt', localId: 'local-fresh', userMessageSeq: 2 },
      { permissionMode: 'read-only' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('local handoff only', {
      ...localIdentityMeta('local-delivered'),
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
    expect(messageBuffer.getMessages().filter((message) => message.type === 'user')).toEqual([
      expect.objectContaining({ content: 'local handoff only' }),
    ]);
  });

  it('does not discard queued prompts that only reached local queue handoff in provider-acceptance mode', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getDeliveredUserMessageSeq: vi.fn(() => 4),
      getProviderAcceptedUserMessageSeq: vi.fn(() => 3),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'provider accepted already', localId: 'local-provider-accepted', userMessageSeq: 3 },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'local handoff only', localId: 'local-handoff-only', userMessageSeq: 4 },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'fresh after handoff', localId: 'local-fresh-after-handoff', userMessageSeq: 5 },
      { permissionMode: 'read-only' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('local handoff only', {
      ...localIdentityMeta('local-handoff-only'),
      userMessageSeq: 4,
      userMessageSeqs: [4],
    });
    expect(messageBuffer.getMessages().filter((message) => message.type === 'user')).toEqual([
      expect.objectContaining({ content: 'local handoff only' }),
    ]);
  });

  it('skips local-id-only queued prompts that provider acceptance already claimed', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getProviderAcceptedUserMessageSeq: vi.fn(() => null),
      hasPendingQueueMaterializedLocalId: vi.fn((localId: string) => localId === 'local-provider-claimed'),
      hasUserMessageProviderAcceptance: vi.fn((query: { localIds?: readonly string[] }) =>
        query.localIds?.includes('local-provider-claimed') === true),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      {
        text: 'provider already accepted this local prompt',
        localId: 'local-provider-claimed',
        localIds: ['local-provider-claimed'],
        providerClaimedPendingLocalIds: ['local-provider-claimed'],
      },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'fresh after accepted local prompt', localId: 'local-fresh', userMessageSeq: 2 },
      { permissionMode: 'default' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(session.hasUserMessageProviderAcceptance).toHaveBeenCalledWith({
      localIds: ['local-provider-claimed'],
      userMessageSeq: null,
      userMessageSeqs: [],
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('fresh after accepted local prompt', {
      ...localIdentityMeta('local-fresh'),
      userMessageSeq: 2,
      userMessageSeqs: [2],
    });
    expect(messageBuffer.getMessages().filter((message) => message.type === 'user')).toEqual([
      expect.objectContaining({ content: 'fresh after accepted local prompt' }),
    ]);
  });

  it('does not treat an absent provider-accepted watermark as a delivered watermark fallback', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getDeliveredUserMessageSeq: vi.fn(() => 1),
      getProviderAcceptedUserMessageSeq: vi.fn(() => null),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'local handoff only', localId: 'local-handoff-only', userMessageSeq: 1 },
      { permissionMode: 'default' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('local handoff only', {
      ...localIdentityMeta('local-handoff-only'),
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
  });

  it('honors provider-acceptance watermark mode even when the explicit accepted getter is absent', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      userMessageDeliveryWatermarkModeV1: 'providerAcceptance',
      deliveredUserMessageSeqV1: 1,
    }));
    Object.assign(session, {
      getDeliveredUserMessageSeq: vi.fn(() => 1),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'provider acceptance still owed', localId: 'local-owed-provider-acceptance', userMessageSeq: 1 },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'later prompt', localId: 'local-later', userMessageSeq: 2 },
      { permissionMode: 'read-only' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('provider acceptance still owed', {
      ...localIdentityMeta('local-owed-provider-acceptance'),
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
  });

  it('keeps queue-handoff prompts in same-mode batches until provider acceptance', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getDeliveredUserMessageSeq: vi.fn(() => 1),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'local handoff only', localId: 'local-delivered', userMessageSeq: 1 },
      { permissionMode: 'default' },
    );
    queue.push(
      { text: 'fresh prompt', localId: 'local-fresh', userMessageSeq: 2 },
      { permissionMode: 'default' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('local handoff only\nfresh prompt', {
      localId: 'local-delivered',
      localIds: ['local-delivered', 'local-fresh'],
      userMessageSeq: 2,
      userMessageSeqs: [1, 2],
    });
    expect(messageBuffer.getMessages().filter((message) => message.type === 'user')).toEqual([
      expect.objectContaining({ content: 'local handoff only\nfresh prompt' }),
    ]);
  });

  it('runs checkpoint lifecycle hooks without blocking prompt dispatch or turn completion', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    let runtimeMessageHandler: ((message: unknown) => void) | null = null;
    runtime.subscribeRuntimeEvents = vi.fn((handler: (message: unknown) => void) => {
      runtimeMessageHandler = handler;
      return () => {
        runtimeMessageHandler = null;
      };
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      runtimeMessageHandler?.({ type: 'task_started', id: 'turn-checkpoint-1' });
      runtimeMessageHandler?.({ type: 'task_complete', id: 'turn-checkpoint-1' });
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const calls: string[] = [];

    queue.push({ text: 'hello', localId: 'local-checkpoint-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      checkpointLifecycle: {
        onBeforePromptDispatch: async ({ messageId }) => {
          calls.push(`message-start:${messageId}`);
          throw new Error('checkpoint unavailable');
        },
        onTurnStarted: async ({ messageId, turnId }) => {
          calls.push(`turn-start:${messageId}:${turnId}`);
        },
        onTurnFinal: async ({ messageId, turnId, status }) => {
          calls.push(`turn-final:${messageId}:${turnId}:${status}`);
        },
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-checkpoint-1'));
    expect(calls).toEqual([
      'message-start:local-checkpoint-1',
      'turn-start:local-checkpoint-1:turn-checkpoint-1',
      'turn-final:local-checkpoint-1:turn-checkpoint-1:completed',
    ]);
  });

  it('maps canonical runtime turn events into checkpoint lifecycle status', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    let runtimeMessageHandler: ((message: unknown) => void) | null = null;
    runtime.subscribeRuntimeEvents = vi.fn((handler: (message: unknown) => void) => {
      runtimeMessageHandler = handler;
      return () => {
        runtimeMessageHandler = null;
      };
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      runtimeMessageHandler?.({
        kind: 'turn-start',
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'codex-turn-1',
        startedBy: 'user',
      });
      runtimeMessageHandler?.({
        kind: 'turn-complete',
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'codex-turn-1',
      });
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const calls: string[] = [];

    queue.push({ text: 'hello', localId: 'local-canonical-runtime' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      checkpointLifecycle: {
        onBeforePromptDispatch: async ({ messageId }) => {
          calls.push(`message-start:${messageId}`);
        },
        onTurnStarted: async ({ messageId, turnId }) => {
          calls.push(`turn-start:${messageId}:${turnId}`);
        },
        onTurnFinal: async ({ messageId, turnId, status }) => {
          calls.push(`turn-final:${messageId}:${turnId}:${status}`);
        },
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(calls).toEqual([
      'message-start:local-canonical-runtime',
      'turn-start:local-canonical-runtime:codex-turn-1',
      'turn-final:local-canonical-runtime:codex-turn-1:completed',
    ]);
  });

  it('finalizes checkpoint lifecycle with the prompt message id when runtime emits no turn events', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const calls: string[] = [];

    queue.push({ text: 'hello', localId: 'local-checkpoint-fallback' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      checkpointLifecycle: {
        onBeforePromptDispatch: async ({ messageId }) => {
          calls.push(`message-start:${messageId}`);
        },
        onTurnStarted: async ({ messageId, turnId }) => {
          calls.push(`turn-start:${messageId}:${turnId}`);
        },
        onTurnFinal: async ({ messageId, turnId, status }) => {
          calls.push(`turn-final:${messageId}:${turnId}:${status}`);
        },
        onTurnAbortedBeforeStart: ({ messageId }) => {
          calls.push(`aborted:${messageId}`);
        },
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(calls).toEqual([
      'message-start:local-checkpoint-fallback',
      'turn-start:local-checkpoint-fallback:local-checkpoint-fallback',
      'turn-final:local-checkpoint-fallback:local-checkpoint-fallback:unknown',
    ]);
  });

  it('passes pending materialization through the lifecycle handoff gate', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    let metadataWaitCount = 0;
    session.waitForMetadataUpdate = vi.fn(async () => {
      metadataWaitCount += 1;
      if (metadataWaitCount === 1) {
        queue.push({ text: 'after-gate', localId: 'local-gate' }, { permissionMode: 'default' });
        return true;
      }
      return false;
    });
    session.popPendingMessage = vi.fn(async () => {
      queue.push({ text: 'should-not-pop', localId: 'local-pop' }, { permissionMode: 'default' });
      return true;
    });
    const beforePendingMaterialize = vi.fn(async () => false);

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      beforePendingMaterialize,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(beforePendingMaterialize).toHaveBeenCalled();
    expect(session.popPendingMessage).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('after-gate', localIdentityMeta('local-gate'));
  });

  it('drains accepted pending rows after eager initial resume before parking idle', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    session.popPendingMessage = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    let shouldExit = false;
    const onAfterStart = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      onAfterStart,
      pendingQueueDrainMaxPopPerWake: 2,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-123', importHistory: false });
    expect(onAfterStart).toHaveBeenCalledTimes(1);
    expect(session.popPendingMessage).toHaveBeenCalledTimes(2);
  });

  it('surfaces eager pending drain failures before parking idle', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    session.materializeNextPendingMessageSafely = vi.fn(async () => {
      throw new Error('pending drain failed');
    });

    let shouldExit = false;
    const onAfterStart = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      onAfterStart,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(session.materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
    });
    expect(messageBuffer.getMessages()).toContainEqual(expect.objectContaining({
      type: 'status',
      content: 'Pending prompts could not be restored after startup; please retry once the session is reachable.',
    }));
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: 'Pending prompts could not be restored after startup; please retry once the session is reachable.',
    });
  });

  it('passes runtime-idle delivery timing into eager pending drain materialization', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'deferred' as const,
      reason: 'runtime_activity_active' as const,
    }));

    let shouldExit = false;
    const onAfterStart = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      onAfterStart,
      pendingQueueDeliveryTiming: 'after_runtime_idle',
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0] & { pendingQueueDeliveryTiming: 'after_runtime_idle' });

    expect(session.materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'force',
      activeTurnDeliveryPolicy: 'allow_live_delivery',
      deliveryTiming: 'after_runtime_idle',
    });
  });

  it('surfaces eager pending drain auth failures before parking idle', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'deferred' as const,
      reason: 'supervisor_auth_failed' as const,
    }));

    let shouldExit = false;
    const onAfterStart = vi.fn(() => {
      shouldExit = true;
    });

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      onAfterStart,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(messageBuffer.getMessages()).toContainEqual(expect.objectContaining({
      type: 'status',
      content: 'Pending prompts could not be restored after startup because session authentication failed; reconnect and retry.',
    }));
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: 'Pending prompts could not be restored after startup because session authentication failed; reconnect and retry.',
    });
  });

  it('parks after an idle pending materialization auth failure and continues with later input', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    session.materializeNextPendingMessageSafely = vi.fn(async () => {
      queueMicrotask(() => {
        queue.push({ text: 'after auth park', localId: 'local-after-auth' }, { permissionMode: 'default' });
      });
      return {
        type: 'deferred' as const,
        reason: 'supervisor_auth_failed' as const,
      };
    });

    let shouldExit = false;
    await expect(runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    })).resolves.toBeUndefined();

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      'after auth park',
      localIdentityMeta('local-after-auth'),
    );
  });

  it('uses a preloaded resume metadata snapshot instead of refreshing session detail before eager start', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    session.refreshSessionSnapshotFromServerBestEffort = vi.fn(async () => {});

    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async () => ({ type: 'exit', code: 0 })) as any;
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-123', importHistory: false });
    expect(session.refreshSessionSnapshotFromServerBestEffort).not.toHaveBeenCalled();
  });

  it('does not emit ready or turn_completed when runtime startup exits before the turn begins', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async () => ({ type: 'exit', code: 0 })) as any;
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-exit-1' }, { permissionMode: 'default' });

    const readySpy = vi.fn();
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => false,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: readySpy,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      onAfterLoopBoundary,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(readySpy).not.toHaveBeenCalled();
    expect(onAfterLoopBoundary).not.toHaveBeenCalledWith({ reason: 'turn_completed' });
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({});
    expect(onAfterStart).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
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
      if (runtime.sendTurnPrompt.mock.calls.length === 0) return;
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('APPEND\n\nhello', localIdentityMeta('local-eager-1'));
  });

  it('uses sendPromptWithMeta when provided by the runtime', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
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
    const onBeforeReset = vi.fn(async () => {});
    const onAfterReset = vi.fn(async () => {});
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      onBeforeReset,
      onAfterReset,
      onAfterLoopBoundary,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledWith({ text: 'hello', ...localIdentityMeta('local-1') });
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('preserves provider-claimed pending identity when dispatching through sendPromptWithMeta', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendPromptWithMeta = vi.fn(async () => {});
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const localId = 'local-provider-claimed-meta';

    queue.push(
      {
        text: 'provider claimed meta prompt',
        localId,
        localIds: [localId],
        providerClaimedPendingLocalIds: [localId],
      },
      { permissionMode: 'default', suppressUserEcho: true },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      text: 'provider claimed meta prompt',
      ...localIdentityMeta(localId),
      providerClaimedPendingLocalIds: [localId],
    });
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('passes a queued model override as prompt metadata without mutating the persistent runtime model', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));

    const queue = createModeQueue();
    const runtime = createRuntime();
    const configUpdates: unknown[] = [];
    runtime.updateSessionRuntimeConfig = vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async (update) => {
      configUpdates.push(update);
    });
    runtime.sendPromptWithMeta = vi.fn(async () => {});

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'hello with selected model', localId: 'local-model-1' },
      { permissionMode: 'default', model: 'opencode/big-pickle' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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

    expect(runtime.updateSessionRuntimeConfig).not.toHaveBeenCalledWith({ modelId: 'opencode/big-pickle' });
    expect(runtime.sendPromptWithMeta).toHaveBeenCalledWith({
      text: 'hello with selected model',
      modelId: 'opencode/big-pickle',
      ...localIdentityMeta('local-model-1'),
    });
  });

  it('applies a queued permission mode override before dispatching the prompt', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));

    const queue = createModeQueue();
    const runtime = createRuntime();
    const configUpdates: unknown[] = [];
    runtime.updateSessionRuntimeConfig = vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async (update) => {
      configUpdates.push(update);
    });
    runtime.sendPromptWithMeta = vi.fn(async () => {
      expect(configUpdates).toContainEqual({ permissionMode: 'read-only' });
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'hello read-only', localId: 'local-permission-1' },
      { permissionMode: 'read-only' },
    );

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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

    expect(runtime.updateSessionRuntimeConfig).toHaveBeenCalledWith({ permissionMode: 'read-only' });
    expect(runtime.sendPromptWithMeta).toHaveBeenCalledWith({
      text: 'hello read-only',
      ...localIdentityMeta('local-permission-1'),
    });
  });

  it('formats object-shaped prompt errors without leaking [object Object] into the transcript', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendTurnPrompt = vi.fn(async () => {
      throw {
        code: -32603,
        message: 'Internal error',
        data: 'Prompt already in progress',
      };
    }) as any;
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', {
      type: 'turn_failed',
      id: 'local-object-error',
    });
    const sentMessages = sendAgentMessageSpy.mock.calls.map((call) =>
      'message' in call[1] ? call[1].message ?? '' : '',
    );
    expect(sentMessages.join('\n')).not.toContain('[object Object]');
  });

  it('marks the queued turn failed when runtime startup fails before prompt dispatch', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async () => {
      throw new ReferenceError('Qwen CLI (qwen) is not available from any configured source.');
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-start-error' }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Qwen',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      message: expect.stringContaining('Qwen CLI (qwen) is not available'),
    });
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', {
      type: 'turn_failed',
      id: 'local-start-error',
    });
  });

  it('does not surface abort-like prompt failures as agent messages', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    const queue = createModeQueue();
    const runtime = createRuntime();
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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
    expect(refreshSessionSnapshotSpy).toHaveBeenCalledTimes(2);
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(2);
    expect(refreshSessionSnapshotSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the session snapshot twice when a metadata wake is followed by a queued prompt', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));

    const queue = createModeQueue();
    let auditActive = false;
    let didQueuePrompt = false;
    const refreshSessionSnapshotSpy = vi.fn(async () => {
      if (!auditActive || didQueuePrompt) return;
      didQueuePrompt = true;
      queue.push({ text: 'after metadata', localId: 'local-1' }, { permissionMode: 'default' });
    });
    session.refreshSessionSnapshotFromServerBestEffort = refreshSessionSnapshotSpy;
    session.waitForMetadataUpdate = vi.fn(async () => auditActive);

    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async () => {
      auditActive = true;
      refreshSessionSnapshotSpy.mockClear();
    });
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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
      startRuntimeBeforeFirstPrompt: true,
    });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(refreshSessionSnapshotSpy).toHaveBeenCalledTimes(1);
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

    session.waitForMetadataUpdate = vi.fn(async () => serverMetadata !== initialMetadata);

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

    await Promise.race([
      runPermissionModePromptLoop({
        providerName: 'Test Provider',
        agentMessageType: 'qwen',
        explicitPermissionMode: undefined,
        session,
        messageQueue: queue,
        permissionHandler,
        runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
        createOverrideSynchronizer: (isStarted) =>
          createRuntimeOverrideSynchronizers({
            agentTargetKey: 'backend:codex',
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
      }),
      appliedPromise,
    ]);

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledTimes(1);
    expect(appliedModeId).toBe('plan');
    expect(appliedModelId).toBe('openai/gpt-5.2');
    expect(session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalled();
  });

  it('refreshes the session snapshot and applies metadata overrides that arrived during the turn before waiting again', async () => {
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
    session.waitForMetadataUpdate = vi.fn(async () => serverMetadata !== initialMetadata);

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          agentTargetKey: 'backend:codex',
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
    serverMetadata = createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/gpt-5.2' },
    });
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'APPEND\n\nhello', localIdentityMeta('local-1'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-2'));
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
    const onBeforeReset = vi.fn(async () => {});
    const onAfterReset = vi.fn(async () => {});
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue as any,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-1', importHistory: false });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-1'));
  });

  it('handles /clear by resetting runtime and skipping prompt send', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      confirmUserMessageDeliveredToProvider: vi.fn(),
      confirmUserMessageLocallyConsumed: vi.fn(),
    });
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

    queue.push({ text: '/clear', localId: 'local-2', userMessageSeq: 64 }, { permissionMode: 'default' });

    let shouldExit = false;
    const readySpy = vi.fn(() => {
      shouldExit = true;
    });
    const onBeforeReset = vi.fn(async () => {});
    const onAfterReset = vi.fn(async () => {});
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      onBeforeReset,
      onAfterReset,
      onAfterLoopBoundary,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoadSession).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(permissionHandler.reset).toHaveBeenCalledTimes(1);
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(messageBuffer.getMessages().some((m) => m.content === 'Session reset.')).toBe(true);
    expect(updateMetadataSpy).not.toHaveBeenCalled();
    expect(onBeforeReset).toHaveBeenCalledWith({ reason: 'clear' });
    expect(onAfterReset).toHaveBeenCalledWith({ reason: 'clear' });
    expect(onAfterLoopBoundary).toHaveBeenCalledWith({ reason: 'clear_reset' });
    expect(session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(session.confirmUserMessageLocallyConsumed).toHaveBeenCalledWith({
      localIds: ['local-2'],
      userMessageSeq: 64,
      userMessageSeqs: [64],
    });
  });

  it('handles /compact through a runtime compaction hook without sending it as a normal prompt', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      confirmUserMessageDeliveredToProvider: vi.fn(),
      confirmUserMessageLocallyConsumed: vi.fn(),
    });
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

    queue.push({ text: '/compact keep latest task details', localId: 'local-compact', userMessageSeq: 65 }, { permissionMode: 'default' });

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledTimes(1);
    expect(runtime.compactContext).toHaveBeenCalledWith('/compact keep latest task details');
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(runtime.sendPromptWithMeta).toBeUndefined();
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
    expect(session.confirmUserMessageLocallyConsumed).toHaveBeenCalledWith({
      localIds: ['local-compact'],
      userMessageSeq: 65,
      userMessageSeqs: [65],
    });
  });

  it('skips replayed locally consumed slash commands without provider custody', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getProviderAcceptedUserMessageSeq: vi.fn(() => null),
      hasUserMessageLocalConsumption: vi.fn((query: { userMessageSeq?: number | null }) => query.userMessageSeq === 64),
      confirmUserMessageDeliveredToProvider: vi.fn(),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: '/clear', localId: 'local-clear-replay', userMessageSeq: 64 }, { permissionMode: 'default' });
    queue.push({ text: 'fresh prompt', localId: 'local-fresh', userMessageSeq: 65 }, { permissionMode: 'default' });

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('fresh prompt', {
      ...localIdentityMeta('local-fresh'),
      userMessageSeq: 65,
      userMessageSeqs: [65],
    });
    expect(session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
  });

  it('skips local-id-only replayed slash commands that were already locally consumed', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      getProviderAcceptedUserMessageSeq: vi.fn(() => null),
      hasUserMessageLocalConsumption: vi.fn((query: { localIds?: readonly string[] }) =>
        query.localIds?.includes('local-clear-replay') === true),
      confirmUserMessageDeliveredToProvider: vi.fn(),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: '/clear', localId: 'local-clear-replay' }, { permissionMode: 'default' });
    queue.push({ text: 'fresh prompt', localId: 'local-fresh', userMessageSeq: 65 }, { permissionMode: 'default' });

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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(session.hasUserMessageLocalConsumption).toHaveBeenCalledWith({
      localIds: ['local-clear-replay'],
      userMessageSeq: null,
      userMessageSeqs: [],
    });
    expect(runtime.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('fresh prompt', {
      ...localIdentityMeta('local-fresh'),
      userMessageSeq: 65,
      userMessageSeqs: [65],
    });
    expect(session.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();
  });

  it('does not leak unsupported /compact commands as normal prompts', async () => {
    const session = createPromptLoopSession();
    const sendAgentMessage = vi.fn();
    Object.assign(session, { sendAgentMessage });
    const queue = createModeQueue();
    const runtime = createRuntime();
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledTimes(1);
    expect(runtime.compactContext).toBeUndefined();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(runtime.sendPromptWithMeta).toBeUndefined();
    expect(sendAgentMessage).toHaveBeenCalledWith('qwen', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('/compact'),
    }));
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
    const onBeforeReset = vi.fn(async () => {});
    const onAfterReset = vi.fn(async () => {});
    const onAfterLoopBoundary = vi.fn(async () => {});

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
      onBeforeReset,
      onAfterReset,
      onAfterLoopBoundary,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'first', localIdentityMeta('local-3'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-4'));
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(1, {});
    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(2, { resumeId: 'resume-from-runtime', importHistory: false });
    expect(onBeforeReset).toHaveBeenCalledWith({ reason: 'mode_change' });
    expect(onAfterReset).toHaveBeenCalledWith({ reason: 'mode_change' });
    expect(onAfterLoopBoundary).toHaveBeenCalledWith({ reason: 'mode_change_reset' });
  });

  it('replays pending-queue materialized follow-ups after a model-backed mode reset', async () => {
    const session = createPromptLoopSession();
    Object.assign(session, {
      hasPendingQueueMaterializedLocalId: vi.fn((localId: string) => localId === 'local-ui-followup'),
      getCommittedUserMessageSeq: vi.fn((localId: string) => localId === 'local-ui-followup' ? 4 : null),
      waitForCommittedUserMessageSeq: vi.fn(async () => 4),
    });
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.updateSessionRuntimeConfig = vi.fn(async () => ({ status: 'unsupported' as const }));
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'initial', localId: 'local-ui-initial', userMessageSeq: 1 },
      { permissionMode: 'default', model: 'Gemini 3.5 Flash (Low)' },
    );
    queue.push(
      { text: 'follow-up', localId: 'local-ui-followup' },
      { permissionMode: 'default' },
    );

    let readyCount = 0;
    const readySpy = vi.fn(() => {
      readyCount += 1;
    });

    await runPermissionModePromptLoop({
      providerName: 'Antigravity',
      agentMessageType: 'antigravity',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'initial', {
      ...localIdentityMeta('local-ui-initial'),
      modelId: 'Gemini 3.5 Flash (Low)',
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'follow-up', {
      ...localIdentityMeta('local-ui-followup'),
      userMessageSeq: 4,
      userMessageSeqs: [4],
    });
  });

  it('drops vendor resume when permission settings change on a runtime that requires a fresh session', async () => {
    const session = createPromptLoopSession();
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'first', localIdentityMeta('local-3b'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-4b'));
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(1, {});
    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(2, {});
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
    runtime.startOrLoadSession = vi.fn(async (opts?: { resumeId?: string | null; importHistory?: boolean }) => {
      if (opts?.resumeId) {
        initialized = true;
        throw new Error('resume failed');
      }
      if (initialized) {
        throw new Error('ACP backend is already initialized');
      }
    }) as any;
    runtime.resetOrDisposeRuntime = vi.fn(async () => {
      initialized = false;
    }) as any;
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(1, { resumeId: 'resume-id', importHistory: false });
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.startOrLoadSession).toHaveBeenNthCalledWith(2, {});
    expect(sendAgentMessageSpy).toHaveBeenCalledWith('qwen', { type: 'message', message: 'Resume failed; starting a new session.' });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-5'));
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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

    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
  });

  it('fails closed for strict initial resume before waiting for the first message', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async (opts?: { resumeId?: string | null; importHistory?: boolean }) => {
      if (opts?.resumeId) {
        throw new Error('resume failed before prompt');
      }
    }) as any;
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    let shouldExit = false;
    const runPromise = (runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-id',
      strictInitialResume: true,
      formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
    }).catch((caught: unknown) => caught as Error);

    const result = await Promise.race([
      runPromise,
      new Promise<'timed-out'>((resolve) => setTimeout(() => {
        shouldExit = true;
        resolve('timed-out');
      }, 25)),
    ]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe('StrictInitialResumeError');
    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('fails closed without masking the strict initial resume error', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.startOrLoadSession = vi.fn(async (opts?: { resumeId?: string | null; importHistory?: boolean }) => {
      if (opts?.resumeId) {
        throw new Error('resume failed');
      }
    }) as any;
    runtime.waitForTurnCompletion = vi.fn(async () => {
      throw new Error('flush failed');
    }) as any;
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
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
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
    expect(runtime.startOrLoadSession).toHaveBeenCalledWith({ resumeId: 'resume-id', importHistory: false });
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.waitForTurnCompletion).not.toHaveBeenCalled();
  });
});
