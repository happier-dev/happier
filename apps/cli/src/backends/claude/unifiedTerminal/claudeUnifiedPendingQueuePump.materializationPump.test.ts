import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { EnhancedMode } from '../loop';
import { Session } from '../session';

const mocks = vi.hoisted(() => ({
  runClaudeUnifiedTerminalSession: vi.fn(),
}));

vi.mock('./runClaudeUnifiedTerminalSession', () => ({
  runClaudeUnifiedTerminalSession: mocks.runClaudeUnifiedTerminalSession,
}));

import { createSessionProviderInputConsumer } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';
import { claudeUnifiedTerminalLauncher } from './claudeUnifiedTerminalLauncher';
import { createClaudeUnifiedPendingQueuePump } from './createClaudeUnifiedPendingQueuePump';

const createdSessions: Session[] = [];

function createSession(): Session {
  const fixture = {
    path: '/workspace/project',
    client: {
      sessionId: 'happy-session-id',
      keepAlive: vi.fn(),
      sendSessionEvent: vi.fn(),
      getMetadataSnapshot: vi.fn(() => ({})),
      recordClaudeJsonlMessageConsumed: vi.fn(),
      bindProviderInputOutcomeProducer: vi.fn(() => vi.fn()),
      hasPendingProviderInputAcceptance: vi.fn(() => false),
      hasActiveCanonicalTurn: vi.fn(() => false),
      blockPendingMessageDelivery: vi.fn(async () => false),
      registerSessionRuntimeControls: vi.fn(() => vi.fn()),
      updateAgentState: vi.fn((updater: (state: unknown) => unknown) => updater({ capabilities: {} })),
      fetchCommittedClaudeJsonlMessageBaseline: vi.fn(async () => ({ keys: new Set<string>(), complete: true, oldestCoveredAtMs: null })),
      fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
      sessionTurnLifecycle: {
        beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
        completeTurn: vi.fn(async () => undefined),
        cancelTurn: vi.fn(async () => undefined),
        failTurn: vi.fn(async () => undefined),
      },
      rpcHandlerManager: { registerHandler: vi.fn() },
      flush: vi.fn(async () => undefined),
      shouldAttemptPendingMaterialization: vi.fn(() => false),
      popPendingMessage: vi.fn(async () => false),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(async () => false),
      waitForPendingEligibilityUpdate: vi.fn((signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      })),
    },
    pushSender: null,
    accountSettings: null,
    lastPermissionMode: 'default',
    lastPermissionModeUpdatedAt: 0,
    adoptLastPermissionModeFromMetadata: vi.fn(() => true),
    transcriptPath: null,
    claudeArgs: [],
    terminalRuntime: null,
    getProviderTaskRuntimeActivityAdapter: vi.fn(() => null),
    getProviderTaskActivityLedger: vi.fn(() => null),
    registerProviderInputConsumer: vi.fn(),
    isWorkflowOwnedTaskReference: vi.fn(() => false),
    hookSettingsPath: undefined,
    hookPluginDir: null,
    queue: {
      size: vi.fn(() => 0),
      waitForMessagesSignal: vi.fn(async () => true),
      waitForMessagesAndGetAsString: vi.fn(),
      unshift: vi.fn(),
    },
    getOrCreateHappierMcpBridge: vi.fn(async () => ({ mcpConfigJson: '{}' })),
    addClaudeSessionHookCallback: vi.fn(),
    removeClaudeSessionHookCallback: vi.fn(),
    onThinkingChange: vi.fn(),
    setThinkingWithoutTaskLifecycle: vi.fn(),
    noteUserAbortRequested: vi.fn(),
    abortCurrentTaskTurn: vi.fn(),
  };
  const session = new Session({
    client: fixture.client as unknown as SessionClientPort,
    path: fixture.path,
    logPath: '/tmp/claude-unified-materialization-pump.log',
    sessionId: 'claude-session-id',
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });
  // Keep the pump's existing runtime fixture while Session owns identity and resumability.
  Object.assign(session, fixture);
  createdSessions.push(session);
  return session;
}

describe('Claude unified pending queue materialization pump', () => {
  afterEach(() => {
    for (const session of createdSessions.splice(0)) session.cleanup();
    vi.useRealTimers();
    mocks.runClaudeUnifiedTerminalSession.mockReset();
  });

  it('surfaces durable-row materialization exhaustion through the runner park callback', async () => {
    const session = createSession();
    const waitUntilAborted = async (abortSignal?: AbortSignal): Promise<boolean> => {
      if (!abortSignal || abortSignal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        abortSignal.addEventListener('abort', () => resolve(false), { once: true });
      });
    };
    vi.mocked(session.queue.waitForMessagesSignal).mockImplementation(waitUntilAborted);
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) throw new Error('test fixture missing blockPendingMessageDelivery');
    let blockAttempt = 0;
    let resolveFirstBlock!: () => void;
    const firstBlock = new Promise<void>((resolve) => {
      resolveFirstBlock = resolve;
    });
    vi.mocked(blockPendingMessageDelivery).mockImplementation(async () => {
      blockAttempt += 1;
      if (blockAttempt === 1) resolveFirstBlock();
      return false;
    });
    const materializationFailure = Object.assign(new Error('durable row materialization stalled'), {
      localId: 'durable-wrapper-row',
    });
    let materializationAttempts = 0;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onPendingQueuePumpPark?: (params: { error: unknown; failureCount: number }) => Promise<void>;
    }) => {
      const abortController = new AbortController();
      const inputConsumer = createSessionProviderInputConsumer({
        messageQueue: session.queue,
        session: {
          ...session.client,
          materializeNextPendingMessageSafely: vi.fn(async () => {
            materializationAttempts += 1;
            if (materializationAttempts > 3) return { type: 'no_pending' as const };
            throw materializationFailure;
          }),
          blockPendingMessageDelivery,
          shouldAttemptPendingMaterialization: vi.fn(() => true),
          waitForPendingEligibilityUpdate: vi.fn(waitUntilAborted),
        },
      });
      const pump = createClaudeUnifiedPendingQueuePump({
        inputConsumer,
        arbiter: {
          enqueueUiMessage: vi.fn(),
          drainWhenSafe: vi.fn(),
          snapshot: vi.fn(() => ({
            pendingQueuePumpStateVersion: 0,
            queuedCount: 0,
            pendingInjectionCount: 0,
            providerAcceptancePendingCount: 0,
            terminalCustodyCount: 0,
            disposed: false,
            turnState: 'idle' as const,
            permissionBlocked: false,
            userTyping: false,
            lastDeferredReason: null,
            lastFailureReason: null,
            currentHeadBlocker: null,
            headInputState: null,
          })),
          waitForPendingQueuePumpStateChange: vi.fn(async () => false),
        },
      });
      const running = pump.start({ abortSignal: abortController.signal });
      await firstBlock;
      await opts.onPendingQueuePumpPark?.({ error: materializationFailure, failureCount: 3 });
      abortController.abort();
      await running;
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['durable-wrapper-row'],
      reason: 'unknown',
    });
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('queued message is paused'),
    }));
  });

  it('surfaces a live-host liveness starvation callback as a non-destructive attention event', async () => {
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onHostLivenessProbeFailureStarvation?: (params: { durationMs: number }) => void | Promise<void>;
    }) => {
      await opts.onHostLivenessProbeFailureStarvation?.({ durationMs: 15_000 });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('not responding to liveness checks'),
    }));
  });
});
