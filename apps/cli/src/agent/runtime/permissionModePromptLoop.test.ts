import { describe, expect, it, vi } from 'vitest';

import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import type { AgentMessage } from '@/agent/core/AgentMessage';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { Metadata } from '@/api/types';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import {
  combinePermissionModeQueuedPrompts,
  type PermissionModeQueuedPrompt,
  type PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { createRuntimeOverrideSynchronizers } from './createRuntimeOverrideSynchronizers';
import { formatProviderPromptErrorMessage } from './formatProviderPromptErrorMessage';
import {
  createRuntimeTurnFailureAlreadySurfacedError,
  type RuntimeTurnOperations,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import type { StructuredInputComposerReferenceResolver } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createDeferred } from '@/testkit/async/deferred';
import { applyAcpConfigOptionIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  MENTION_KIND_V1,
  ProviderConnectionIdSchema,
  AgentSessionRuntimeEventV1Schema,
  buildComposerReferenceMentionPayloadV1,
  buildMentionRefForKindV1,
} from '@happier-dev/protocol';

type PromptLoopMetadata = Metadata & {
  replaySeedV1?: any;
  forkV1?: any;
};

function createPromptLoopSession() {
  return createMutableApiSessionClientFixture<PromptLoopMetadata>({
    overrides: {
      async enqueueAgentMessageCommitted() {
        return { persisted: true, delivered: false };
      },
    },
  });
}

function createPromptLoopMetadata(overrides: Partial<PromptLoopMetadata> = {}): PromptLoopMetadata {
  return {
    ...createTestMetadata(overrides as Partial<Metadata>),
    ...overrides,
  };
}

function createModeQueue() {
  return new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    (mode) => JSON.stringify(mode),
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function createRuntime() {
  const operations = {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn<RuntimeTurnOperations['sendTurnPrompt']>(async () => {}),
    steerInFlightTurn: vi.fn(async () => {}),
    waitForTurnCompletion: vi.fn(async () => {}),
    subscribeRuntimeEvents: vi.fn(() => () => {}),
    respondToPermission: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'resume-from-runtime' })),
    updateSessionRuntimeConfig: vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async () => {}),
    resetOrDisposeRuntime: vi.fn(async () => {}),
    compactContext: undefined as undefined | ((command: string) => Promise<void>),
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

  it.each([
    {
      title: 'retires the replay seed on confirmed delivery even when the turn then fails',
      failFirstSendBeforeAcceptance: false,
      expectedSecondPrompt: 'second',
      expectedSeedTextAfter: '',
    },
    {
      title: 'keeps the replay seed live when the first prompt never reached the provider',
      failFirstSendBeforeAcceptance: true,
      expectedSecondPrompt: 'SEED\n\nsecond',
      expectedSeedTextAfter: 'SEED',
    },
  ])('$title', async ({ failFirstSendBeforeAcceptance, expectedSecondPrompt, expectedSeedTextAfter }) => {
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
    let sendCount = 0;
    const seedTextAtEachSend: unknown[] = [];
    runtime.sendTurnPrompt = vi.fn<RuntimeTurnOperations['sendTurnPrompt']>(async () => {
      sendCount += 1;
      seedTextAtEachSend.push(session.__getMetadata()?.replaySeedV1?.seedText);
      // A prompt the provider never took custody of keeps its seed; anything the
      // provider accepted has already delivered it.
      if (sendCount === 1 && failFirstSendBeforeAcceptance) {
        throw new Error('provider rejected the prompt before acceptance');
      }
    });
    // The provider accepted the prompt and the turn then died — the shape of the
    // observed incident. A genuinely abort-like failure tears the loop down (see the
    // abort case below), so the surviving-loop observable uses a plain turn failure.
    runtime.waitForTurnCompletion = vi.fn(async () => {
      if (sendCount === 1 && !failFirstSendBeforeAcceptance) {
        throw new Error('provider turn died after acceptance');
      }
    });
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount === 1) {
          queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
          return;
        }
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'SEED\n\nhello', localIdentityMeta('local-1'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, expectedSecondPrompt, localIdentityMeta('local-2'));
    expect(seedTextAtEachSend[1]).toBe(expectedSeedTextAfter);
  });

  it('has already retired the replay seed when a user abort tears the loop down', async () => {
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
    runtime.waitForTurnCompletion = vi.fn(async () => {
      throw new Error('Cancelled by user');
    });

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    await expect(runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => false,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    })).rejects.toThrow('Cancelled by user');

    expect(runtime.sendTurnPrompt).toHaveBeenCalledExactlyOnceWith('SEED\n\nhello', localIdentityMeta('local-1'));
    // Retirement is scoped to provider acceptance, which already happened when the
    // send resolved — so the abort cannot leave the seed live for the next prompt.
    expect(session.__getMetadata()?.replaySeedV1?.appliedToLocalId).toBe('local-1');
    expect(session.__getMetadata()?.replaySeedV1?.seedText).toBe('');
  });

  // A runtime whose send stays pending for the whole turn (the ACP seam awaits the
  // provider's response after acceptance) surfaces a user abort as a rejected send. The
  // provider already has the seed in its context, so the abort must not leave the seed
  // live — that is exactly how one session received the same seed twice.
  it.each([
    {
      title: 'retires the replay seed when a turn-spanning send confirms acceptance and is then aborted',
      confirmAcceptanceBeforeAbort: true,
      expectedSecondPrompt: 'second',
      expectedSeedTextAtSecondSend: '',
    },
    {
      title: 'keeps the replay seed live when a turn-spanning send is aborted without confirming acceptance',
      confirmAcceptanceBeforeAbort: false,
      expectedSecondPrompt: 'SEED\n\nsecond',
      expectedSeedTextAtSecondSend: 'SEED',
    },
  ])('$title', async ({ confirmAcceptanceBeforeAbort, expectedSecondPrompt, expectedSeedTextAtSecondSend }) => {
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
    const sentTexts: string[] = [];
    const seedTextAtEachSend: unknown[] = [];
    const acceptanceByLocalId = new Map<string, () => void>();
    runtime.sendTurnPrompt = vi.fn(async (text: string) => {
      sentTexts.push(text);
      seedTextAtEachSend.push(session.__getMetadata()?.replaySeedV1?.seedText);
      if (sentTexts.length > 1) return;
      if (confirmAcceptanceBeforeAbort) {
        acceptanceByLocalId.get('local-1')?.();
      }
      // The send only settles when the turn does, so the abort arrives here rather than
      // through waitForTurnCompletion.
      throw new Error('Cancelled by user');
    });

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount === 1) {
          queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
          return;
        }
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      registerProviderAcceptedEffect: (localId, onAccepted) => {
        if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
        else acceptanceByLocalId.delete(localId);
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(sentTexts[0]).toBe('SEED\n\nhello');
    expect(sentTexts[1]).toBe(expectedSecondPrompt);
    expect(seedTextAtEachSend[1]).toBe(expectedSeedTextAtSecondSend);
  });

  it('keeps the replay seed live when the runtime returns before exact provider acceptance', async () => {
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
    const sentTexts: string[] = [];
    const acceptanceByLocalId = new Map<string, () => void>();
    runtime.sendTurnPrompt = vi.fn(async (text: string) => {
      sentTexts.push(text);
      // Native terminal custody can return before the provider decides whether it
      // accepted the injected input. Absence of the exact callback is intentionally
      // ambiguous and must keep the seed available for a later accepted prompt.
    });

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount === 1) {
          queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
          return;
        }
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      registerProviderAcceptedEffect: (localId, onAccepted) => {
        if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
        else acceptanceByLocalId.delete(localId);
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(sentTexts).toEqual(['SEED\n\nhello', 'SEED\n\nsecond']);
    expect(session.__getMetadata()?.replaySeedV1?.seedText).toBe('SEED');
  });

  // OWNERSHIP PIN. Provider ACCEPTANCE is normalized once by the host and correlated to the
  // replay effect by Pending localId; the runtime keeps only its ordinary send contract.
  it('drains host acceptance arriving during turn completion before reading the next prompt', async () => {
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
    const sentTexts: string[] = [];
    const seedTextAtEachSend: unknown[] = [];
    const acceptanceByLocalId = new Map<string, () => void>();
    runtime.sendTurnPrompt = vi.fn(async (text: string) => {
      sentTexts.push(text);
      seedTextAtEachSend.push(session.__getMetadata()?.replaySeedV1?.seedText);
    });
    runtime.waitForTurnCompletion = vi.fn(async () => {
      if (sentTexts.length === 1) acceptanceByLocalId.get('local-1')?.();
    });

    queue.push({ text: 'hello', localId: 'local-1' }, { permissionMode: 'default' });

    let shouldExit = false;
    let readyCount = 0;

    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount === 1) {
          queue.push({ text: 'second', localId: 'local-2' }, { permissionMode: 'default' });
          return;
        }
        shouldExit = true;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      registerProviderAcceptedEffect: (localId, onAccepted) => {
        if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
        else acceptanceByLocalId.delete(localId);
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(sentTexts[0]).toBe('SEED\n\nhello');
    expect(sentTexts[1]).toBe('second');
    expect(seedTextAtEachSend[1]).toBe('');
  });

  it('replays already-resolved provider prompts literally with their transcript anchor and without echo or command parsing', async () => {
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-1'));
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(flushPendingAfterStart).toHaveBeenCalled();
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

    const enqueueAgentMessageCommitted = vi.spyOn(session, 'enqueueAgentMessageCommitted');

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
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('awaiting provider acceptance'),
      }),
      expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }),
    );
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-2'));
  });

  it('does not duplicate a turn-completion failure already surfaced by a runtime event', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    const enqueueAgentMessageCommitted = vi.spyOn(session, 'enqueueAgentMessageCommitted');

    runtime.waitForTurnCompletion = vi.fn(async () => {
      throw createRuntimeTurnFailureAlreadySurfacedError({
        message: 'Plugin session runtime turn failed: OpenCode permission request was denied.',
        event: {
          kind: 'turn-failed',
          sequence: 1,
          sessionId: session.sessionId,
          emittedAtMs: 2,
          turnId: 'turn-1',
          diagnostic: {
            code: 'opencode_permission_denied',
            severity: 'error',
            message: 'OpenCode permission request was denied.',
            details: {
              source: 'permission_blocked',
              occurredAt: 2,
              agentId: 'opencode',
            },
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

    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalledWith('qwen', expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('OpenCode permission request was denied'),
    }), expect.anything());
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

    const enqueueAgentMessageCommitted = vi.spyOn(session, 'enqueueAgentMessageCommitted');

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
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('awaiting provider acceptance'),
      }),
      expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }),
    );
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
    const enqueueAgentMessageCommitted = vi.spyOn(session, 'enqueueAgentMessageCommitted');
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

    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalledWith('qwen', expect.objectContaining({
      message: expect.stringContaining('aborted'),
    }), expect.anything());
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
      runtimeMessageHandler?.({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'turn-checkpoint-1',
        startedBy: 'host',
      });
      runtimeMessageHandler?.({
        kind: 'turn-complete',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        turnId: 'turn-checkpoint-1',
      });
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
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        turnId: 'codex-turn-1',
        startedBy: 'host',
      });
      runtimeMessageHandler?.({
        kind: 'turn-complete',
        sequence: 2,
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

  it('does not attempt pending materialization after a local queue wake already established custody', async () => {
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
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queue.push({ text: 'should-not-materialize', localId: 'local-materialize' }, { permissionMode: 'default' });
      return {
        type: 'materialized' as const,
        localId: 'local-materialize',
        seq: 1,
        content: null,
      };
    });
    session.materializeNextPendingMessageSafely = materializeNextPendingMessageSafely;
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

    expect(beforePendingMaterialize).not.toHaveBeenCalled();
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('after-gate', localIdentityMeta('local-gate'));
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
    const enqueueAgentMessageCommittedSpy = vi.spyOn(session, 'enqueueAgentMessageCommitted');
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
    expect(enqueueAgentMessageCommittedSpy).toHaveBeenCalledWith(
      'qwen',
      {
        type: 'message',
        message: 'Pending prompts could not be restored after startup because session authentication failed; reconnect and retry.',
      },
      expect.objectContaining({
        localId: expect.any(String),
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
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
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

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
      sendReady: () => {},
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      initialResumeId: 'resume-123',
      strictInitialResume: true,
      onAfterStart: () => {
        shouldExit = true;
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(session.refreshSessionSnapshotFromServerBestEffort).not.toHaveBeenCalled();
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('APPEND\n\nhello', localIdentityMeta('local-eager-1'));
  });

  it('registers replay retirement by localId while using the ordinary runtime send owner', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const acceptanceByLocalId = new Map<string, () => void>();
    runtime.sendTurnPrompt = vi.fn(async () => {
      acceptanceByLocalId.get('local-1')?.();
    });
    const registerProviderAcceptedEffect = vi.fn((localId: string, onAccepted: (() => void) | null) => {
      if (onAccepted) acceptanceByLocalId.set(localId, onAccepted);
      else acceptanceByLocalId.delete(localId);
    });
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
      registerProviderAcceptedEffect,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(registerProviderAcceptedEffect).toHaveBeenCalledWith('local-1', expect.any(Function));
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-1'));
  });

  it('passes queued structured input through the runtime prompt metadata', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const structuredInput = {
      v: 1 as const,
      imageInputs: [{
        id: 'image-1',
        kind: 'localImage' as const,
        path: '.happier/uploads/messages/message-1/image.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
        provenance: { kind: 'sessionAttachmentUpload' as const },
      }],
    };
    const causalPermissionAuthority = {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
      sourceAuthority: {
        kind: 'mediatedExternal' as const,
        mediatorPluginId: 'acme.plugin',
        sourceRef: 'message-1',
        sourceRevisionOrEpoch: 'revision-1',
        admittedPermissionCeiling: 'read-only' as const,
        remoteApprovalMaxScope: 'request' as const,
      },
    };
    queue.push({
      text: 'inspect this image',
      localId: 'local-image-1',
      structuredInput,
      causalPermissionAuthority,
    } as PermissionModeQueuedPrompt, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({ syncFromMetadata: () => {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('inspect this image', {
      ...localIdentityMeta('local-image-1'),
      structuredInput,
      causalPermissionAuthority,
    });
  });

  it('applies a queued structured model selection before provider prompt dispatch', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));

    const queue = createModeQueue();
    const runtime = createRuntime();
    const events: string[] = [];
    const onProviderPromptDispatchPrepared = vi.fn((input: unknown) => {
      events.push('dispatch-model-snapshotted');
      expect(input).toEqual({
        localIds: ['local-model-1'],
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_openrouter',
          modelId: 'openrouter/model',
        },
      });
    });
    const configUpdates: unknown[] = [];
    runtime.updateSessionRuntimeConfig = vi.fn<RuntimeTurnOperations['updateSessionRuntimeConfig']>(async (update) => {
      configUpdates.push(update);
    });
    runtime.sendTurnPrompt = vi.fn(async () => {
      events.push('provider-dispatch');
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push(
      { text: 'hello with selected model', localId: 'local-model-1' },
      {
        permissionMode: 'default',
        modelSelection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_openrouter'),
          modelId: 'openrouter/model',
        },
      },
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
            setSessionModelSelection: async () => {},
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
      transitionModelSelectionBeforePrompt: async (
        selection,
        runWithActiveSelection,
      ) => {
        events.push('model-transition');
        expect(selection).toEqual({
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_openrouter',
          modelId: 'openrouter/model',
        });
        expect(runWithActiveSelection).toBeTypeOf('function');
        await runWithActiveSelection!(async ({ dispatch }) => {
          await dispatch();
          return { status: 'dispatched', value: undefined };
        });
        return {
          ok: true,
          status: 'applied',
          activeSelection: selection,
        };
      },
      readActiveModelSelection: () => ({
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_openrouter'),
        modelId: 'openrouter/model',
      }),
      onProviderPromptDispatchPrepared,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(events).toEqual(['model-transition', 'dispatch-model-snapshotted', 'provider-dispatch']);
    expect(runtime.updateSessionRuntimeConfig).not.toHaveBeenCalledWith({
      modelId: 'openrouter/model',
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      'hello with selected model',
      localIdentityMeta('local-model-1'),
    );
  });

  it.each([
    [
      'restart_required',
      'provider_rejected_before_acceptance',
      false,
    ],
    [
      'owner_unavailable',
      'provider_unavailable_before_acceptance',
      true,
    ],
  ] as const)(
    'settles every batched prompt before provider effect when its structured model transition is %s',
    async (transitionStatus, settlementReason, retryable) => {
    const session = createPromptLoopSession();
    const observeProviderInputSettlement = vi.spyOn(
      session,
      'observeProviderInputSettlement',
    );
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    const runtime = createRuntime();
    const requestedSelection = {
      agentTargetKey: 'backend:codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_other'),
      modelId: 'other/model',
    } as const;
    queue.push(
      { text: 'must remain in host custody', localId: 'local-model-failed' },
      { permissionMode: 'default', modelSelection: requestedSelection },
    );
    queue.push(
      { text: 'second prompt in the same custody batch', localId: 'local-model-failed-2' },
      { permissionMode: 'default', modelSelection: requestedSelection },
    );

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => {},
        flushPendingAfterStart: async () => {},
      }),
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
      transitionModelSelectionBeforePrompt: async () =>
        transitionStatus === 'owner_unavailable'
          ? {
              ok: false,
              status: transitionStatus,
              activeSelection: null,
              requestedSelection,
            }
          : {
              ok: false,
              status: transitionStatus,
              activeSelection: {
                agentTargetKey: 'backend:codex',
                providerConnectionId:
                  ProviderConnectionIdSchema.parse('pc_work'),
                modelId: 'current/model',
              },
              requestedSelection,
            },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(observeProviderInputSettlement).toHaveBeenNthCalledWith(1, {
      kind: 'rejected_before_effect',
      localId: 'local-model-failed',
      userMessageSeq: null,
      reason: settlementReason,
      diagnostic: {
        code: `session_model_transition_${transitionStatus}`,
        severity: 'error',
        message: `Structured model transition failed: ${transitionStatus}`,
      },
      retryable,
    });
    expect(observeProviderInputSettlement).toHaveBeenNthCalledWith(2, {
      kind: 'rejected_before_effect',
      localId: 'local-model-failed-2',
      userMessageSeq: null,
      reason: settlementReason,
      diagnostic: {
        code: `session_model_transition_${transitionStatus}`,
        severity: 'error',
        message: `Structured model transition failed: ${transitionStatus}`,
      },
      retryable,
    });
  });

  it('resolves selected attachments immediately before dispatch and settles a failed resolution without retiring durable custody', async () => {
    const session = createPromptLoopSession();
    const observeProviderInputSettlement = vi.spyOn(session, 'observeProviderInputSettlement').mockImplementation(
      (() => Promise.resolve(false)) as typeof session.observeProviderInputSettlement,
    );
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    const runtime = createRuntime();
    const resolveComposerAttachmentForDispatch = vi.fn(async () => ({
      attachments: [{
        instanceId: 'review-comment-1',
        status: 'failed',
        retryable: false,
        message: 'The selected review comment no longer exists.',
      }],
    }));
    queue.push({
      text: 'Review this selected comment.',
      localId: 'local-attachment-preparation-unavailable',
      userMessageSeq: 42,
      userMessageSeqs: [42],
      structuredInput: {
        v: 1,
        composerAttachments: [{
          v: 1,
          instanceId: 'review-comment-1',
          attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
          key: 'comment-1',
          value: { reviewId: 'review-1' },
          presentation: { label: 'Review comment', typeLabel: 'Review comment' },
        }],
      },
    }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: {
        setPermissionMode: vi.fn(),
        reset: vi.fn(),
      } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => {},
        flushPendingAfterStart: async () => {},
      }),
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
      resolveComposerAttachmentForDispatch,
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(resolveComposerAttachmentForDispatch).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      request: {
        sessionId: session.sessionId,
        localId: 'local-attachment-preparation-unavailable',
        attachments: [{
          instanceId: 'review-comment-1',
          key: 'comment-1',
          value: { reviewId: 'review-1' },
        }],
      },
      signal: expect.any(AbortSignal),
    });
    expect(observeProviderInputSettlement).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'local-attachment-preparation-unavailable',
      userMessageSeq: 42,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: {
        code: 'composer_attachment_resolution_failed',
        severity: 'error',
        message: 'The selected review comment no longer exists.',
      },
      retryable: false,
    });
  });

  it('settles selected SessionMedia video as typed unsupported without a provider effect', async () => {
    const session = createPromptLoopSession();
    const observeProviderInputSettlement = vi.spyOn(session, 'observeProviderInputSettlement').mockImplementation(
      (() => Promise.resolve(false)) as typeof session.observeProviderInputSettlement,
    );
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    const runtime = createRuntime();
    const media = {
      id: 'media-review-video',
      role: 'input' as const,
      category: 'attachment' as const,
      mediaKind: 'video' as const,
      mimeType: 'video/webm' as const,
      name: 'review.webm',
      path: '.happier/uploads/messages/session-1/local-review-video/review.webm',
      sizeBytes: 67,
      sha256: 'b'.repeat(64),
      origin: { source: 'user-upload' as const },
    };
    queue.push({
      text: 'Review this recording.',
      localId: 'local-review-video',
      structuredInput: {
        v: 1,
        composerAttachments: [{
          v: 1,
          instanceId: 'review-video-1',
          attachment: { pluginId: 'acme.review', localId: 'review-media' },
          key: 'review-video',
          value: { reviewId: 'review-1' },
          presentation: { label: 'Review recording', typeLabel: 'Review media' },
          content: { kind: 'sessionMedia', mediaId: media.id },
        }],
      },
      sessionMedia: [media],
    }, { permissionMode: 'default' });

    let shouldExit = false;
    await runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => {},
        flushPendingAfterStart: async () => {},
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => new AbortController().signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => { shouldExit = true; },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    } as Parameters<typeof runPermissionModePromptLoop>[0]);

    expect(runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(observeProviderInputSettlement).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'local-review-video',
      userMessageSeq: null,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: {
        code: 'session_media_video_unsupported',
        severity: 'error',
        message: 'The current Agent runtime does not declare video input support',
      },
      retryable: false,
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
    runtime.sendTurnPrompt = vi.fn(async () => {
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
            setSessionModelSelection: async () => {},
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
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      'hello read-only',
      localIdentityMeta('local-permission-1'),
    );
  });

  it('formats object-shaped prompt errors without leaking [object Object] into the transcript', async () => {
    const session = createPromptLoopSession();
    const enqueueAgentMessageCommittedSpy = vi.spyOn(session, 'enqueueAgentMessageCommitted');
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

    expect(enqueueAgentMessageCommittedSpy).toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: expect.stringContaining('"message": "Internal error"'),
    }, expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }));
    expect(enqueueAgentMessageCommittedSpy).toHaveBeenCalledWith('qwen', {
      type: 'turn_failed',
      id: 'local-object-error',
    }, expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }));
    const sentMessages = enqueueAgentMessageCommittedSpy.mock.calls.map((call) =>
      'message' in call[1] ? call[1].message ?? '' : '',
    );
    expect(sentMessages.join('\n')).not.toContain('[object Object]');
  });

  it('marks the queued turn failed when runtime startup fails before prompt dispatch', async () => {
    const session = createPromptLoopSession();
    const enqueueAgentMessageCommittedSpy = vi.spyOn(session, 'enqueueAgentMessageCommitted');
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendTurnPrompt = vi.fn(async () => {
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

    expect(enqueueAgentMessageCommittedSpy).toHaveBeenCalledWith('qwen', {
      type: 'message',
      message: expect.stringContaining('Qwen CLI (qwen) is not available'),
    }, expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }));
    expect(enqueueAgentMessageCommittedSpy).toHaveBeenCalledWith('qwen', {
      type: 'turn_failed',
      id: 'local-start-error',
    }, expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }));
  });

  it('does not surface abort-like prompt failures as agent messages', async () => {
    const session = createPromptLoopSession();
    const enqueueAgentMessageCommittedSpy = vi.spyOn(session, 'enqueueAgentMessageCommitted');
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendTurnPrompt = vi.fn(async () => {
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

    expect(enqueueAgentMessageCommittedSpy).not.toHaveBeenCalledWith('opencode', expect.objectContaining({
      type: 'message',
    }), expect.anything());
  });

  it('does not turn runtime-handled provider status errors into assistant transcript messages', async () => {
    const session = createPromptLoopSession();
    const runtimeEvents: ReturnType<typeof AgentSessionRuntimeEventV1Schema.parse>[] = [];

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
    runtime.subscribeRuntimeEvents((message) => {
      const event = AgentSessionRuntimeEventV1Schema.parse(message);
      runtimeEvents.push(event);
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

    const assistantText = runtimeEvents.flatMap((event) => (
      event.kind === 'transcript-message-committed' && event.role === 'assistant'
        ? [event.text]
        : []
    )).join('\n');
    expect(assistantText).not.toContain('Model not found');
    await expect.poll(() => runtimeEvents.some((event) => event.kind === 'turn-failed')).toBe(true);
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
    runtime.sendTurnPrompt = vi.fn(async () => {
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
            setSessionModelSelection: async (selection) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              selectedModelId = selection.modelId;
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
            setSessionModelSelection: async () => {},
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
            setSessionModelSelection: async () => {},
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
      onAfterStart: () => {
        auditActive = true;
        refreshSessionSnapshotSpy.mockClear();
      },
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
              setSessionModelSelection: async (selection) => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                runtime.__setAppliedModel(selection.modelId);
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(appliedModeId).toBe('plan');
    expect(appliedModelId).toBe('openai/gpt-5.2');
    expect(session.refreshSessionSnapshotFromServerBestEffort).toHaveBeenCalledWith({
      reason: 'primaryTurnRuntimeState',
    });
  });

  it('applies a metadata override projected after turn finalization but before the next metadata wait is armed', async () => {
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });
    const runtime = createRuntime();

    const abortController = new AbortController();
    session.waitForMetadataUpdate = vi.fn(async (signal?: AbortSignal) => await new Promise<boolean>((resolve) => {
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    }));

    const applied = createDeferred<void>();
    const setSessionConfigOption = vi.fn(async () => {
      applied.resolve();
      return { status: 'applied' as const };
    });
    let shouldExit = false;
    let projectedBetweenBoundaries = false;

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() } as any,
      runtime: runtime as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['runtime'],
      createOverrideSynchronizer: (isStarted) => createRuntimeOverrideSynchronizers({
        agentTargetKey: 'backend:grok',
        session,
        runtime: {
          setSessionMode: async () => {},
          setSessionModelSelection: async () => {},
          setSessionConfigOption,
        },
        isStarted,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {},
      onAfterLoopBoundary: async ({ reason }) => {
        if (reason !== 'turn_completed' || projectedBetweenBoundaries) return;
        projectedBetweenBoundaries = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        session.__setMetadata(applyAcpConfigOptionIntentSessionMetadata(
          session.getMetadataSnapshot() ?? {},
          { v: 1, configId: 'reasoning_effort', value: 'medium', updatedAt: 10 },
        ) as PromptLoopMetadata);
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await Promise.race([
        applied.promise,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('Timed out waiting for the between-boundaries metadata override')),
          250,
        )),
      ]);
    } finally {
      shouldExit = true;
      abortController.abort();
      await loopPromise;
    }

    expect(setSessionConfigOption).toHaveBeenCalledWith('reasoning_effort', 'medium');
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
      runtime.sendTurnPrompt = vi.fn(
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
            setSessionModelSelection: async (selection) => {
              await new Promise((resolve) => setTimeout(resolve, 0));
              runtime.__setAppliedModel(selection.modelId);
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-1'));
  });

  it('does not leak unsupported /compact commands as normal prompts', async () => {
    const session = createPromptLoopSession();
    const enqueueAgentMessageCommitted = vi.spyOn(session, 'enqueueAgentMessageCommitted');
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

    expect(runtime.compactContext).toBeUndefined();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen',
      expect.objectContaining({
        type: 'message',
        message: expect.stringContaining('/compact'),
      }),
      expect.objectContaining({ provenance: { kind: 'non_dependent', source: 'external' } }),
    );
    expect(readySpy).toHaveBeenCalledTimes(1);
  });

  it('restarts when mode hash changes and replays the pending message', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const messageBuffer = new MessageBuffer();
    const permissionReset = createDeferred<void>();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(() => permissionReset.promise),
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

    const loop = runPermissionModePromptLoop({
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

    await vi.waitFor(() => {
      expect(permissionHandler.reset).toHaveBeenCalledTimes(1);
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.resetOrDisposeRuntime).not.toHaveBeenCalled();
    permissionReset.resolve();
    await loop;

    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(1, 'first', localIdentityMeta('local-3'));
    expect(runtime.sendTurnPrompt).toHaveBeenNthCalledWith(2, 'second', localIdentityMeta('local-4'));
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledWith(undefined, {
      kind: 'resume',
      providerSessionId: 'resume-from-runtime',
      importHistory: false,
    });
    expect(onBeforeReset).toHaveBeenCalledWith({ reason: 'mode_change' });
    expect(onAfterReset).toHaveBeenCalledWith({ reason: 'mode_change' });
    expect(onAfterLoopBoundary).toHaveBeenCalledWith({ reason: 'mode_change_reset' });
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
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledWith(undefined, { kind: 'create' });
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

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-fork'));
  });

  it('keeps a generic initial-resume turn failure on the ordinary loop path', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    runtime.sendTurnPrompt = vi.fn(async () => {
      throw new Error('resume failed');
    });
    runtime.waitForTurnCompletion = vi.fn(async () => {
      throw new Error('flush failed');
    }) as any;
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;
    const onStrictInitialResumeFailure = vi.fn(async () => undefined);

    queue.push({ text: 'hello', localId: 'local-6' }, { permissionMode: 'default' });

    let shouldExit = false;
    await expect((runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
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
      onStrictInitialResumeFailure,
      formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
    })).resolves.toBeUndefined();

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-6'));
    expect(onStrictInitialResumeFailure).not.toHaveBeenCalled();
    expect(messageBuffer.getMessages()).not.toContainEqual(expect.objectContaining({
      content: expect.stringContaining('Resume failed; cannot continue'),
    }));
  });

  it('surfaces a generic completion failure without invalidating the requested native identity', async () => {
    // Prompt transport and a later generic completion error say nothing about
    // whether this particular provider identity was accepted. Only a provider
    // classified identity mismatch may invalidate the local native-return
    // record; otherwise a transient turn failure would erase continuity.
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    expect(session.__getMetadata()?.replaySeedV1).toBeUndefined();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const identityMismatch = new Error('requested provider session did not resume');
    let shouldExit = false;
    runtime.sendTurnPrompt = vi.fn(async () => undefined);
    runtime.waitForTurnCompletion = vi.fn(async () => {
      shouldExit = true;
      throw identityMismatch;
    }) as any;
    const onStrictInitialResumeFailure = vi.fn(async () => undefined);
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-strict-completion' }, { permissionMode: 'default' });

    const outcome = await (runPermissionModePromptLoop as unknown as (params: any) => Promise<void>)({
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
      onStrictInitialResumeFailure,
      formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
    });

    expect(outcome).toBeUndefined();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', localIdentityMeta('local-strict-completion'));
    expect(onStrictInitialResumeFailure).not.toHaveBeenCalled();
  });

  it('invalidates a provider-classified native identity mismatch after prompt acceptance', async () => {
    const session = createPromptLoopSession();
    const queue = createModeQueue();
    const runtime = createRuntime();
    const identityMismatch = Object.assign(
      new Error('requested provider session did not resume'),
      { happierNativeResumeIdentityMismatch: true },
    );
    let shouldExit = false;
    runtime.sendTurnPrompt = vi.fn(async () => undefined);
    runtime.waitForTurnCompletion = vi.fn(async () => {
      shouldExit = true;
      throw identityMismatch;
    }) as any;
    const onStrictInitialResumeFailure = vi.fn(async () => undefined);
    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    queue.push({ text: 'hello', localId: 'local-strict-mismatch' }, { permissionMode: 'default' });

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
      onStrictInitialResumeFailure,
      formatPromptErrorMessage: (error: unknown) => `Error: ${String(error)}`,
    }).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('StrictInitialResumeError');
    expect((error as Error & { cause?: unknown }).cause).toBe(identityMismatch);
    expect(onStrictInitialResumeFailure).toHaveBeenCalledWith({
      resumeId: 'resume-id',
      error: identityMismatch,
    });
  });

  it('resolves composer references into provider context at the dispatch choke point (EU-5, R-10)', async () => {
    // The wiring gate. The resolver being correct in isolation proves nothing if dispatch
    // never calls it, and a `structuredInput` pass-through is exactly the shape that looks
    // right while carrying identity-only references no provider can use.
    const session = createPromptLoopSession();
    session.__setMetadata(createPromptLoopMetadata({
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    }));
    const queue = createModeQueue();
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      listSkills?: () => Promise<unknown>;
      listVendorPlugins?: () => Promise<unknown>;
      resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
    };
    runtime.listSkills = vi.fn(async () => ({
      skills: [{
        name: 'review',
        displayName: 'Review',
        path: '/w/.codex/skills/review/SKILL.md',
        enabled: true,
        origin: 'codex_native',
      }],
    }));
    runtime.listVendorPlugins = vi.fn(async () => ({
      vendorPlugins: [{
        vendorPluginRef: 'plugin://linear@happier',
        name: 'linear',
        displayName: 'Linear',
        installed: true,
        enabled: true,
      }],
    }));
    runtime.resolveComposerReference = vi.fn(async () => ({
      id: 'issue:42',
      label: 'Issue 42 (current)',
      description: 'Fresh issue summary',
      context: 'The issue is ready for review.',
    }));
    const messageBuffer = new MessageBuffer();
    const permissionHandler = { setPermissionMode: vi.fn(), reset: vi.fn() } as any;

    queue.push({
      text: 'run $review with @linear on @issue',
      localId: 'local-1',
      structuredInput: {
        v: 1,
        mentions: [
          {
            kind: MENTION_KIND_V1.skill,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.skill, 'vendor:codex:review'),
            token: '$review',
            start: 4,
            end: 11,
          },
          {
            kind: MENTION_KIND_V1.vendorPlugin,
            ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'plugin://linear@happier'),
            token: '@linear',
            start: 17,
            end: 24,
          },
          {
            ...buildComposerReferenceMentionPayloadV1({
              reference: { pluginId: 'acme.issues', localId: 'issues' },
              candidate: { id: 'issue:42', label: 'Issue 42' },
            }),
            token: '@issue',
            start: 28,
            end: 34,
          },
        ],
      },
    }, { permissionMode: 'default' });

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

    expect(runtime.resolveComposerReference).toHaveBeenCalledWith({
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      candidateId: 'issue:42',
      signal: expect.any(AbortSignal),
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(1);
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(expect.stringContaining('run $review with @linear on @issue'), {
      ...localIdentityMeta('local-1'),
      structuredInput: {
        v: 1,
        skillMentions: [{
          name: 'review',
          path: '/w/.codex/skills/review/SKILL.md',
          displayName: 'Review',
          origin: 'vendor',
          backendId: 'codex',
        }],
        vendorPluginMentions: [{ vendorPluginRef: 'plugin://linear@happier', label: 'Linear' }],
      },
    });
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(expect.stringContaining('<happier_composer_reference_context v="1">'), expect.anything());
    expect(JSON.stringify(runtime.sendTurnPrompt.mock.calls[0]?.[1])).not.toContain('The issue is ready for review.');
  });

});
