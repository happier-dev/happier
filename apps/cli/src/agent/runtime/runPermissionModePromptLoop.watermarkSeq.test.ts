import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from './modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from './permissions/queuedPrompt';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionMode } from '@/api/types';

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

describe('runPermissionModePromptLoop watermark seq custody (ported HF-1)', () => {
  it('passes exact batch identities to sendTurnPrompt so acceptance can confirm the watermark', async () => {
    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'm1', userMessageSeq: 5 }, { permissionMode: 'default' });
    queue.push({ text: 'second', localId: 'm2', userMessageSeq: 9 }, { permissionMode: 'default' });

    const dispatches: Array<{ prompt: string; meta: unknown }> = [];
    const abortController = new AbortController();
    let shouldExit = false;

    const session = {
      sessionId: 'session-1',
      sendSessionEvent: vi.fn(),
      getLastObservedMessageSeq: () => 0,
      getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
      fetchLatestUserPermissionIntentFromTranscript: async () => null,
      refreshSessionSnapshotFromServerBestEffort: async () => undefined,
      ensureMetadataSnapshot: async () => undefined,
      popPendingMessage: async () => false,
      waitForMetadataUpdate: async () => false,
      sendAgentMessage: vi.fn(),
    };

    await runPermissionModePromptLoop({
      providerName: 'Claude',
      agentMessageType: 'claude',
      explicitPermissionMode: undefined,
      session: session as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['session'],
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: {
        beginTurnLifecycle: vi.fn(),
        async sendTurnPrompt(prompt: string, meta?: unknown) {
          dispatches.push({ prompt, meta });
          shouldExit = true;
          abortController.abort();
        },
        async steerInFlightTurn() {},
        async waitForTurnCompletion() {},
        subscribeRuntimeEvents: () => () => undefined,
        async cancelTurn() {},
        async updateSessionRuntimeConfig() {},
        async resetOrDisposeRuntime() {},
        async startOrLoadSession() {},
        readSessionIdentity: () => ({ sessionId: 'runtime-session' }),
      },
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: vi.fn(),
      setThinking: vi.fn(),
      sendReady: vi.fn(),
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: vi.fn(),
      setCurrentPermissionModeUpdatedAt: vi.fn(),
      formatPromptErrorMessage: (error) => String(error),
    });

    expect(dispatches).toEqual([
      {
        prompt: 'first\nsecond',
        meta: {
          localId: 'm1',
          localIds: ['m1', 'm2'],
          userMessageSeq: 9,
          userMessageSeqs: [5, 9],
        },
      },
    ]);
  });

  it('does not discard pending-queue materialized prompts at the delivered watermark before provider dispatch', async () => {
    const queue = createModeQueue();
    queue.push({ text: 'materialized prompt', localId: 'm7', userMessageSeq: 7 }, { permissionMode: 'default' });

    const dispatches: Array<{ prompt: string; meta: unknown }> = [];
    const abortController = new AbortController();
    let shouldExit = false;

    const session = {
      sessionId: 'session-acceptance-mode',
      sendSessionEvent: vi.fn(),
      getLastObservedMessageSeq: () => 0,
      getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
      fetchLatestUserPermissionIntentFromTranscript: async () => null,
      refreshSessionSnapshotFromServerBestEffort: async () => undefined,
      ensureMetadataSnapshot: async () => undefined,
      popPendingMessage: async () => false,
      waitForMetadataUpdate: async () => {
        shouldExit = true;
        abortController.abort();
        return false;
      },
      sendAgentMessage: vi.fn(),
      getDeliveredUserMessageSeq: () => 7,
      getProviderAcceptedUserMessageSeq: () => 7,
      hasPendingQueueMaterializedLocalId: (localId: string) => localId === 'm7',
    };

    await runPermissionModePromptLoop({
      providerName: 'Claude',
      agentMessageType: 'claude',
      explicitPermissionMode: undefined,
      session: session as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['session'],
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: {
        beginTurnLifecycle: vi.fn(),
        async sendTurnPrompt(prompt: string, meta?: unknown) {
          dispatches.push({ prompt, meta });
          shouldExit = true;
        },
        async steerInFlightTurn() {},
        async waitForTurnCompletion() {},
        subscribeRuntimeEvents: () => () => undefined,
        async cancelTurn() {},
        async updateSessionRuntimeConfig() {},
        async resetOrDisposeRuntime() {},
        async startOrLoadSession() {},
        readSessionIdentity: () => ({ sessionId: 'runtime-session' }),
      },
      createOverrideSynchronizer: () => ({
        syncFromMetadata: () => undefined,
        flushPendingAfterStart: async () => undefined,
      }),
      messageBuffer: new MessageBuffer(),
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: vi.fn(),
      setThinking: vi.fn(),
      sendReady: vi.fn(),
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: vi.fn(),
      setCurrentPermissionModeUpdatedAt: vi.fn(),
      formatPromptErrorMessage: (error) => String(error),
    });

    expect(dispatches).toEqual([
      {
        prompt: 'materialized prompt',
        meta: {
          localId: 'm7',
          localIds: ['m7'],
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      },
    ]);
  });
});
