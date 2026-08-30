import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { AgentState, Metadata } from '@/api/types';

import type { EnhancedMode } from './loop';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { Session } from './session';

const mockQuery = vi.hoisted(() => vi.fn());
const mockClaudeRemoteAgentSdk = vi.hoisted(() => vi.fn());
const mockRunClaudeUnifiedTerminalSession = vi.hoisted(() => vi.fn());

vi.mock('@/backends/claude/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/sdk')>();
  return { ...actual, query: mockQuery };
});

vi.mock('./remote/claudeRemoteAgentSdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remote/claudeRemoteAgentSdk')>();
  return { ...actual, claudeRemoteAgentSdk: mockClaudeRemoteAgentSdk };
});

vi.mock('./unifiedTerminal/runClaudeUnifiedTerminalSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./unifiedTerminal/runClaudeUnifiedTerminalSession')>();
  return { ...actual, runClaudeUnifiedTerminalSession: mockRunClaudeUnifiedTerminalSession };
});

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: vi.fn(() => '/resolved/claude-cli.js'),
}));

type RpcHandler = (params?: unknown) => unknown | Promise<unknown>;

const createdSessions: Session[] = [];

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

function createHarness(): Readonly<{
  session: Session;
  switchHandlerReady: Promise<RpcHandler>;
}> {
  const switchDeferred = createDeferred<RpcHandler>();
  let agentState: AgentState = { requests: Object.create(null), completedRequests: Object.create(null) };
  let metadata: Metadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/.happier',
    happyLibDir: '/tmp/.happier/lib',
    happyToolsDir: '/tmp/.happier/tools',
  };
  let hasMetadata = false;

  const client = {
    sessionId: 'happier-session-1',
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    recordClaudeJsonlMessageConsumed: vi.fn(),
    keepAlive: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
      attachProviderTurnId: vi.fn(async () => {}),
      appendTranscriptAnchors: vi.fn(async () => {}),
      completeTurn: vi.fn(async () => {}),
      failTurn: vi.fn(async () => {}),
      cancelTurn: vi.fn(async () => {}),
      endSession: vi.fn(async () => {}),
      markRollbackEligible: vi.fn(async () => {}),
      markRolledBack: vi.fn(async () => {}),
      touchActiveTurn: vi.fn(async () => {}),
      hasActiveTurn: vi.fn(() => false),
      observeAcpLifecycleMarker: vi.fn((input: { body: unknown }) => ({ body: input.body, pendingWrite: null })),
    },
    updateMetadata: vi.fn((updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
      hasMetadata = true;
    }),
    updateAgentState: vi.fn((updater: (current: AgentState) => AgentState) => {
      agentState = updater(agentState);
    }),
    getAgentStateSnapshot: vi.fn(() => agentState),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: RpcHandler) => {
        if (method === 'switch') switchDeferred.resolve(handler);
      }),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendClaudeSessionMessage: vi.fn(),
    blockPendingMessageDelivery: vi.fn(async () => false),
    registerSessionRuntimeControls: vi.fn(() => vi.fn()),
    fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
    sendSessionEvent: vi.fn(),
    getMetadataSnapshot: vi.fn(() => hasMetadata ? metadata : null),
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionClientPort;

  const session = new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/claude-remote.log',
    sessionId: 'claude-current',
    messageQueue: new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/claude-hooks.json',
    hookPluginDir: '/tmp/claude-hook-plugin',
    precomputedMcpBridge: { mcpServers: {}, stop: vi.fn() },
    runtimeActivityContributions: {
      providerTasks: {
        report: vi.fn(async () => {}),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
      // Keep this true after launcher exit: post-exit inertness must come from
      // subscriber disposal rather than being masked by the runtime fence.
      isCurrentRuntime: () => true,
    },
  });
  session.transcriptPath = '/tmp/claude-current.jsonl';
  createdSessions.push(session);

  return { session, switchHandlerReady: switchDeferred.promise };
}

describe.sequential('claudeRemoteLauncher legacy Runtime Activity subscriber', () => {
  const previousGraceMs = process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockClaudeRemoteAgentSdk.mockReset();
    mockRunClaudeUnifiedTerminalSession.mockReset();
    process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = '0';
  });

  afterEach(() => {
    if (previousGraceMs === undefined) {
      delete process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS;
    } else {
      process.env.HAPPIER_CLAUDE_REMOTE_INTERRUPT_THEN_TEARDOWN_GRACE_MS = previousGraceMs;
    }
    for (const session of createdSessions.splice(0)) session.cleanup();
  });

  it('releases the previous Agent SDK input wait before a provider relaunch', async () => {
    const awaitPhase = async <T>(label: string, promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const { session, switchHandlerReady } = createHarness();
    const firstLaunchStarted = createDeferred<void>();
    const firstWaitArmed = createDeferred<void>();
    const finishFirstLaunch = createDeferred<void>();
    const secondLaunchStarted = createDeferred<void>();
    const secondPromptOutcome = createDeferred<Readonly<{
      status: 'fulfilled' | 'rejected';
      message?: string;
      error?: unknown;
    }>>();
    let launchCall = 0;

    mockClaudeRemoteAgentSdk.mockImplementation(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      launchCall += 1;
      if (launchCall === 1) {
        firstLaunchStarted.resolve(undefined);
        await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'initial prompt' }));
        void opts.nextMessage().catch(() => undefined);
        firstWaitArmed.resolve(undefined);
        await finishFirstLaunch.promise;
        return;
      }
      if (launchCall === 2) {
        secondLaunchStarted.resolve(undefined);
        try {
          const next = await opts.nextMessage();
          if (!next) return;
          secondPromptOutcome.resolve({
            status: 'fulfilled',
            message: next.message,
          });
        } catch (error) {
          secondPromptOutcome.resolve({ status: 'rejected', error });
          throw error;
        }
        return;
      }
      const next = await opts.nextMessage();
      if (next) {
        secondPromptOutcome.resolve({
          status: 'fulfilled',
          message: next.message,
        });
      }
    });

    session.queue.push(
      'initial prompt',
      {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
      { userMessageLocalId: 'local-initial' },
    );

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const launcherOutcome = launcherPromise.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const switchHandler = await switchHandlerReady;
    try {
      await expect(awaitPhase('first Agent SDK launch', Promise.race([
        firstLaunchStarted.promise.then(() => ({ status: 'launch-started' as const })),
        launcherOutcome,
      ]))).resolves.toEqual({ status: 'launch-started' });
      await awaitPhase('first input wait', firstWaitArmed.promise);
      finishFirstLaunch.resolve(undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      session.client.updateMetadata((current) => ({
        ...current,
        replaySeedV1: {
          v: 1,
          seedText: 'CARRY-OVER',
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 10,
          createdAtMs: 123,
        },
      }));
      session.queue.pushIsolateAndClear(
        'recovery prompt',
        {
          permissionMode: 'default',
          claudeRemoteAgentSdkEnabled: true,
          claudeUnifiedTerminalEnabled: false,
        },
        { userMessageLocalId: 'local-recovery' },
      );

      await awaitPhase('second Agent SDK launch', secondLaunchStarted.promise);
      await expect(awaitPhase('second prompt', secondPromptOutcome.promise)).resolves.toEqual({
        status: 'fulfilled',
        message: 'CARRY-OVER\n\nrecovery prompt',
      });
    } finally {
      await awaitPhase('launcher shutdown', Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]));
    }
  }, 60_000);

  it('keeps the active Agent SDK runtime when a later queued prompt selects unified terminal', async () => {
    const awaitPhase = async <T>(label: string, promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const { session, switchHandlerReady } = createHarness();
    const firstPromptConsumed = createDeferred<void>();
    const secondPromptOutcome = createDeferred<Readonly<{
      runtime: 'agentSdk' | 'unifiedTerminal';
      message: string | null;
    }>>();

    mockClaudeRemoteAgentSdk.mockImplementationOnce(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'initial SDK prompt' }));
      firstPromptConsumed.resolve(undefined);
      const next = await opts.nextMessage();
      if (next) {
        secondPromptOutcome.resolve({ runtime: 'agentSdk', message: next.message });
      }
    });
    mockRunClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: Readonly<{
      nextMessage: () => Promise<Readonly<{ message: string }> | null>;
    }>) => {
      const next = await opts.nextMessage();
      secondPromptOutcome.resolve({ runtime: 'unifiedTerminal', message: next?.message ?? null });
    });

    session.queue.push(
      'initial SDK prompt',
      {
        permissionMode: 'default',
        claudeRemoteAgentSdkEnabled: true,
        claudeUnifiedTerminalEnabled: false,
      },
      { userMessageLocalId: 'local-sdk-initial' },
    );

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;
    try {
      await awaitPhase('initial Agent SDK prompt', firstPromptConsumed.promise);
      session.queue.push(
        'prompt after account runtime change',
        {
          permissionMode: 'default',
          claudeRemoteAgentSdkEnabled: true,
          claudeUnifiedTerminalEnabled: true,
        },
        { userMessageLocalId: 'local-after-runtime-change' },
      );

      await expect(awaitPhase('second prompt dispatch', secondPromptOutcome.promise)).resolves.toEqual({
        runtime: 'agentSdk',
        message: 'prompt after account runtime change',
      });
      expect(mockClaudeRemoteAgentSdk).toHaveBeenCalledTimes(1);
      expect(mockRunClaudeUnifiedTerminalSession).not.toHaveBeenCalled();
    } finally {
      await awaitPhase('launcher shutdown', Promise.all([
        Promise.resolve(switchHandler({ to: 'local' })),
        session.cleanup(),
        launcherPromise,
      ]));
    }
  }, 60_000);
});
