import { describe, expect, it, vi } from 'vitest';

import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import { createReadyNotificationDispatcher } from './notifications/createReadyNotificationDispatcher';
import { MessageQueue2 } from './modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from './permissions/queuedPrompt';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { PermissionMode } from '@/api/types';
import type { sendReadyWithPushNotification } from './notifications/sendReadyWithPushNotification';

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    { batcher: (messages) => combinePermissionModeQueuedPrompts(messages) },
  );
}

describe('runPermissionModePromptLoop assistant text snapshots', () => {
  it('starts a fresh snapshot turn for each prompt so ready does not reuse stale assistant text', async () => {
    const snapshotStore = createTurnAssistantTextSnapshotStore({ maxTextChars: 200 });
    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'm1' }, { permissionMode: 'default' });

    const readyBodies: Array<string | null | undefined> = [];
    const abortController = new AbortController();
    let shouldExit = false;
    let promptCount = 0;
    let resolveFinalReadyAdmission!: () => void;

    const session = {
      sessionId: 'session-1',
      sendSessionEvent: vi.fn(),
      enqueueSessionEventCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
      getLastObservedMessageSeq: () => promptCount,
      getTurnAssistantTextSnapshotStore: () => snapshotStore,
      getMetadataSnapshot: () => ({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
      fetchLatestUserPermissionIntentFromTranscript: async () => null,
      refreshSessionSnapshotFromServerBestEffort: async () => undefined,
      ensureMetadataSnapshot: async () => undefined,
      popPendingMessage: async () => false,
      waitForMetadataUpdate: async () => false,
      sendAgentMessage: vi.fn(),
    };

    const sendReady = createReadyNotificationDispatcher({
      session,
      pushSender: { sendToAllDevices: vi.fn() },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[test]',
      includeAssistantPreviewText: true,
      sendReadyWithPushNotificationFn: (async (opts) => {
        readyBodies.push(opts.assistantPreviewText);
        if (readyBodies.length === 1) {
          queue.push({ text: 'second', localId: 'm2' }, { permissionMode: 'default' });
        } else if (readyBodies.length === 2) {
          shouldExit = true;
          abortController.abort();
          await new Promise<void>((resolve) => {
            resolveFinalReadyAdmission = resolve;
          });
        }
      }) as typeof sendReadyWithPushNotification,
    });

    const loop = runPermissionModePromptLoop({
      providerName: 'Codex',
      agentMessageType: 'codex',
      explicitPermissionMode: undefined,
      // The loop requires the full ApiSessionClient type, but this test exercises only the methods above.
      session: session as unknown as Parameters<typeof runPermissionModePromptLoop>[0]['session'],
      messageQueue: queue,
      permissionHandler: { setPermissionMode: vi.fn(), reset: vi.fn() },
      runtime: {
        beginTurnLifecycle: vi.fn(),
        async sendTurnPrompt() {
          promptCount += 1;
          if (promptCount === 1) {
            snapshotStore.observe({ text: 'First answer', source: 'streaming' });
          }
        },
        async steerInFlightTurn() {},
        async waitForTurnCompletion() {},
        subscribeRuntimeEvents: () => () => undefined,
        async cancelTurn() {},
        async updateSessionRuntimeConfig() {},
        async resetOrDisposeRuntime() {},
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
      sendReady,
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: vi.fn(),
      setCurrentPermissionModeUpdatedAt: vi.fn(),
      formatPromptErrorMessage: (error) => String(error),
    });

    await vi.waitFor(() => {
      expect(readyBodies).toHaveLength(2);
    });
    let loopSettled = false;
    void loop.finally(() => {
      loopSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loopSettled).toBe(false);

    resolveFinalReadyAdmission();
    await loop;

    expect(readyBodies).toEqual(['First answer', null]);
  });
});
