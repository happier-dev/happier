import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { ZellijActionTimeoutError } from '@/integrations/zellij/actions';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { AccountSettings } from '@happier-dev/protocol';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

const mocks = vi.hoisted(() => ({
  runClaudeUnifiedTerminalSession: vi.fn(),
  runTmuxAttach: vi.fn(async () => 0),
  runZellijAttach: vi.fn(async () => 0),
  dispatchActivityNotificationAsync: vi.fn(async () => undefined),
  reportConnectedServiceRuntimeAuthFailureToDaemon: vi.fn(async () => ({
    handled: false,
    report: null,
    statusCode: null,
    statusMessage: null,
  })),
  // Defaults to `null`, which is exactly what the real factory returns for this file's session stub
  // (it exposes no system-record writer). Cases that need to observe the source inject one per call;
  // the return type is widened here so an injected fake needs no cast at the call site.
  createClaudeWorkflowActivitySourceForSession: vi.fn(
    async (_params: Readonly<Record<string, unknown>>): Promise<unknown> => null,
  ),
}));

vi.mock('./runClaudeUnifiedTerminalSession', () => ({
  runClaudeUnifiedTerminalSession: mocks.runClaudeUnifiedTerminalSession,
}));

vi.mock('../workflows/createClaudeWorkflowActivitySourceForSession', () => ({
  createClaudeWorkflowActivitySourceForSession: mocks.createClaudeWorkflowActivitySourceForSession,
}));

vi.mock('@/terminal/attachment/tmuxAttach', () => ({
  runTmuxAttach: mocks.runTmuxAttach,
}));

vi.mock('@/terminal/attachment/zellijAttach', () => ({
  runZellijAttach: mocks.runZellijAttach,
}));

vi.mock('@/activity/notifications/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: mocks.dispatchActivityNotificationAsync,
}));

vi.mock('@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon', () => ({
  reportConnectedServiceRuntimeAuthFailureToDaemon: mocks.reportConnectedServiceRuntimeAuthFailureToDaemon,
}));

import { claudeUnifiedTerminalLauncher } from './claudeUnifiedTerminalLauncher';
import { ClaudeUnifiedTerminalManagedSettingsOptionError } from './buildClaudeUnifiedTerminalSpawn';
import { ClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { parseClaudeScreenState } from './tuiControls/screenState';
import { PendingQueueMaterializationAuthError } from '@/agent/runtime/sessionInput/SessionProviderInputConsumer';

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

type ReplaySeedTestMetadata = Readonly<Record<string, unknown> & {
  replaySeedV1?: Readonly<{
    seedText?: string;
    appliedToLocalId?: string;
  }>;
}>;

const RESUME_CHOICE_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const EFFORT_CHANGE_DIALOG_HIGH = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const USAGE_LIMIT_DIALOG = readFileSync(
  resolve(__dirname, 'tuiControls/__fixtures__/incident-89861-ratelimit-resume.ansi'),
  'utf8',
);

function setProcessTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function restoreProcessTty(): void {
  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

function waitUntilAborted(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    signal?.addEventListener('abort', () => resolve(false), { once: true });
  });
}

function abortLauncherOnEmptyQueueWait(session: Session, waitNumber = 1): AbortSignal {
  const controller = new AbortController();
  let queueWaits = 0;
  vi.mocked(session.queue.waitForMessagesSignal).mockImplementation(async (signal?: AbortSignal) => {
    queueWaits += 1;
    if (queueWaits === waitNumber) controller.abort();
    return await waitUntilAborted(signal);
  });
  return controller.signal;
}

function createSession(overrides: Readonly<{
  terminalRuntime?: Session['terminalRuntime'];
  metadata?: unknown;
}> = {}): Session {
  let metadata: unknown = overrides.metadata ?? {};
  return {
    path: '/workspace/project',
    client: {
      sessionId: 'happy-session-id',
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendClaudeSessionMessageCommittedExact: vi.fn(async () => {}),
      sendClaudeSessionMessageCommitted: vi.fn(async () => ({
        persisted: true,
        delivered: true,
      })),
      getMetadataSnapshot: vi.fn(() => metadata),
      // SessionClient's metadata updater is intentionally untyped at this test boundary.
      updateMetadata: vi.fn(async (updater: (current: any) => any) => {
        metadata = updater(metadata);
      }),
      recordClaudeJsonlMessageConsumed: vi.fn(),
      bindProviderInputOutcomeProducer: vi.fn(() => vi.fn()),
      hasPendingProviderInputAcceptance: vi.fn(() => false),
      hasCanonicalPendingProviderInputDelivery: vi.fn(() => true),
      hasActiveCanonicalTurn: vi.fn(() => false),
      blockPendingMessageDelivery: vi.fn(async () => false),
      wakePendingMaterialization: vi.fn(),
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
      rpcHandlerManager: {
        registerHandler: vi.fn(),
      },
      flush: vi.fn(async () => undefined),
      // Pending-queue drain surface consumed by the launcher's session input consumer.
      // Defaults keep tests inert: nothing pending, metadata wait never fires.
      shouldAttemptPendingMaterialization: vi.fn(() => false),
      materializeNextPendingMessageSafely: vi.fn(async () => ({ type: 'no_pending' as const })),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(() => new Promise<boolean>(() => undefined)),
      waitForPendingEligibilityUpdate: vi.fn((signal?: AbortSignal) => new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      })),
    },
    pushSender: null,
    accountSettings: null,
    sessionId: 'claude-session-id',
    lastPermissionMode: 'default',
    lastPermissionModeUpdatedAt: 0,
    adoptLastPermissionModeFromMetadata: vi.fn(() => true),
    transcriptPath: null,
    claudeArgs: [],
    terminalRuntime: overrides.terminalRuntime ?? null,
    hookSettingsPath: undefined,
    hookPluginDir: null,
    queue: {
      size: vi.fn(() => 0),
      waitForMessagesSignal: vi.fn(waitUntilAborted),
      waitForMessagesAndGetAsString: vi.fn(),
      unshift: vi.fn(),
    },
    getOrCreateHappierMcpBridge: vi.fn(async () => ({ mcpConfigJson: '{}' })),
    addClaudeSessionHookCallback: vi.fn(),
    removeClaudeSessionHookCallback: vi.fn(),
    getProviderTaskRuntimeActivityAdapter: vi.fn(() => null),
    getProviderTaskActivityLedger: vi.fn(() => null),
    registerProviderInputConsumer: vi.fn(),
    registerConnectedServiceExactApplicationHandler: vi.fn(() => vi.fn()),
    isWorkflowOwnedTaskReference: vi.fn(() => false),
    onSessionFound: vi.fn(),
    publishUnifiedTerminalHostMetadata: vi.fn(async () => {}),
    onThinkingChange: vi.fn(),
    setThinkingWithoutTaskLifecycle: vi.fn(),
    noteUserAbortRequested: vi.fn(),
    abortCurrentTaskTurn: vi.fn(),
  } as unknown as Session;
}

function readFirstInvocationOrder(
  spy: Readonly<{ mock: Readonly<{ invocationCallOrder: readonly number[] }> }>,
  label: string,
): number {
  const order = spy.mock.invocationCallOrder[0];
  if (typeof order !== 'number') {
    throw new Error(`Expected ${label} to have been called`);
  }
  return order;
}

function getFailTurnSpy(session: Session) {
  const failTurn = session.client.sessionTurnLifecycle?.failTurn;
  if (!failTurn) {
    throw new Error('test fixture missing sessionTurnLifecycle.failTurn');
  }
  return vi.mocked(failTurn);
}

describe('claudeUnifiedTerminalLauncher', () => {
  afterEach(() => {
    restoreProcessTty();
    mocks.runClaudeUnifiedTerminalSession.mockReset();
    vi.clearAllMocks();
  });

  it('wires one generalized dialog-choice broker into the unified runtime', async () => {
    setProcessTty(false);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: Record<string, unknown>) => {
      expect(opts.dialogChoiceBroker).toBeDefined();
      expect(opts).not.toHaveProperty('safeguardChoiceBroker');
    });

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });
  });

  it('does not manufacture an active turn when a native resume adopts its existing host', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--resume', 'claude-session-id'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onProviderLaunchStarting?: () => Promise<void>;
    }) => {
      expect(opts.onProviderLaunchStarting).toBeTypeOf('function');
      // Successful exact-host adoption returns without starting another provider process.
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
  });

  it('tees the exact unified steer evaluator snapshot to UI publication and Pending claim authority', async () => {
    setProcessTty(false);
    const session = createSession();
    vi.mocked(session.client.hasActiveCanonicalTurn!).mockReturnValue(true);
    vi.mocked(session.client.shouldAttemptPendingMaterialization!).mockReturnValue(true);
    const materializeNextPendingMessageSafely = vi.mocked(
      session.client.materializeNextPendingMessageSafely!,
    );

    const refreshAvailability = vi.fn()
      .mockResolvedValueOnce({ available: true, reason: null } as const)
      .mockResolvedValueOnce({ available: false, reason: 'unsafe_window' } as const)
      .mockResolvedValueOnce({ available: true, reason: null } as const);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onInFlightSteerAvailabilitySnapshot?: (snapshot: Readonly<{
        available: boolean;
        reason: 'unsafe_window' | 'user_terminal_draft' | null;
      }>) => void;
      registerInFlightSteerAvailabilityRefresh?: (refresh: () => Promise<Readonly<{
        available: boolean;
        reason: 'unsafe_window' | 'user_terminal_draft' | null;
      }>>) => (() => void);
    }) => {
      const consumer = vi.mocked(session.registerProviderInputConsumer).mock.calls[0]?.[0];
      if (!consumer) throw new Error('expected the canonical Pending input consumer to be registered');

      const unregisterRefresh = opts.registerInFlightSteerAvailabilityRefresh?.(async () => {
        const snapshot = await refreshAvailability();
        opts.onInFlightSteerAvailabilitySnapshot?.(snapshot);
        return snapshot;
      });
      if (!unregisterRefresh) throw new Error('expected provider-owned pre-claim steer refresh registration');

      opts.onInFlightSteerAvailabilitySnapshot?.({ available: true, reason: null });
      await consumer.drainPending({ reason: 'test-exact-steer-available' });
      expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
        reconcileWhenEmpty: 'force',
        activeTurnSteerability: 'steerable',
        pendingQueueDeliveryTiming: 'after_foreground_ready',
      }));

      // A stale positive publication is presentation only. The request-scoped recapture is the
      // sole claim proof and must be able to revoke it immediately before materialization.
      opts.onInFlightSteerAvailabilitySnapshot?.({ available: true, reason: null });
      await consumer.drainPending({ reason: 'test-exact-steer-unavailable' });
      expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
        reconcileWhenEmpty: 'force',
        activeTurnSteerability: 'unsteerable',
        pendingQueueDeliveryTiming: 'after_foreground_ready',
      }));

      await consumer.drainPending({ reason: 'test-pre-claim-steer-refresh' });
      expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
        reconcileWhenEmpty: 'force',
        activeTurnSteerability: 'steerable',
        pendingQueueDeliveryTiming: 'after_foreground_ready',
      }));
      expect(refreshAvailability).toHaveBeenCalledTimes(3);
      unregisterRefresh();
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.updateAgentState).toHaveBeenCalled();
  });

  it('foreground-attaches tty-started tmux unified sessions after the host is ready', async () => {
    setProcessTty(true);
    const terminal: NonNullable<TerminalAttachmentInfo['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:unified-window' },
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalHostReady?: (params: { handle: TerminalHostHandle; terminal: NonNullable<TerminalAttachmentInfo['terminal']> }) => void;
      publishTerminalHostMetadata?: (terminal: NonNullable<TerminalAttachmentInfo['terminal']>) => void | Promise<void>;
    }) => {
      await opts.publishTerminalHostMetadata?.(terminal);
      opts.onTerminalHostReady?.({ handle, terminal });
    });

    const session = createSession();
    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(mocks.runTmuxAttach).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal,
    });
    expect(session.publishUnifiedTerminalHostMetadata).toHaveBeenCalledWith(terminal);
  });

  it('foreground-attaches tty-started zellij unified sessions after the host is ready', async () => {
    setProcessTty(true);
    const terminal = {
      mode: 'zellij',
      zellij: { sessionName: 'happy-zellij', paneId: 'terminal_7' },
    } as NonNullable<TerminalAttachmentInfo['terminal']>;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalHostReady?: (params: { handle: TerminalHostHandle; terminal: NonNullable<TerminalAttachmentInfo['terminal']> }) => void;
    }) => {
      opts.onTerminalHostReady?.({ handle, terminal });
    });

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runZellijAttach).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal,
    });
  });

  it('uses the active tmux runtime as the unified terminal host for tmux-launched sessions', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: {
        mode: 'tmux',
        requested: 'tmux',
        tmuxTarget: 'happy:unified-window',
      },
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }),
    );
  });

  it('uses the active tmux runtime as the unified terminal host for tmux-launched initial prompts', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: {
        mode: 'tmux',
        requested: 'tmux',
        tmuxTarget: 'happy:unified-window',
      },
    });
    session.claudeArgs = ['--print', 'hello'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      initialMode?: EnhancedMode;
      nextMessage?: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    }) => {
      expect(opts.initialMode).toBeUndefined();
      const first = await opts.nextMessage?.();
      expect(first).toEqual(expect.objectContaining({
        message: 'hello',
        mode: expect.objectContaining({
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }));
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });
  });

  it('uses tmux session metadata as the unified terminal host when runtime flags are absent', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: null,
      metadata: {
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:unified-window' },
        },
      },
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }),
    );
  });

  it('uses zellij session metadata as the unified terminal host when runtime flags are absent', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: null,
      metadata: {
        terminal: {
          mode: 'zellij',
          requested: 'zellij',
          zellij: { sessionName: 'happy-zellij', paneId: 'terminal_7' },
        },
      },
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          claudeUnifiedTerminalHost: 'zellij',
        }),
      }),
    );
  });

  it('fails closed when the runner returns input without canonical Pending identity', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      returnUnconsumedMessage?: (input: { message: string; mode: unknown }) => void;
    }) => {
      opts.returnUnconsumedMessage?.({
        message: 'arrived during unwind',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.queue.unshift).not.toHaveBeenCalled();
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  it('blocks a returned server-owned pending delivery instead of hiding it in the local queue', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      returnUnconsumedMessage?: (input: {
        message: string;
        mode: unknown;
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      }) => void;
    }) => {
      opts.returnUnconsumedMessage?.({
        message: 'server-owned during unwind',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        maxUserMessageSeq: 27,
        userMessageLocalIds: ['pending-local-27'],
      });
      await Promise.resolve();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-local-27'],
      reason: 'runtime_disposed_before_delivery',
    });
    expect(session.queue.unshift).not.toHaveBeenCalled();
  });

  it('blocks and visibly surfaces a parked pending-pump delivery failure without relaunching the host', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    const failure = Object.assign(new Error('pending server stalled'), { localId: 'durable-pump-row' });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onPendingQueuePumpPark?: (params: { error: unknown; failureCount: number }) => Promise<void>;
    }) => {
      await opts.onPendingQueuePumpPark?.({ error: failure, failureCount: 3 });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['durable-pump-row'],
      reason: 'unknown',
    });
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('queued message is paused'),
    }));
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
  });

  it('passes a startup resume-choice resolver that uses the startup mode preference', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      createStartupDialogResolver?: (input: {
        controlPort: ReturnType<typeof createFakeControlPort>;
        startupMode: EnhancedMode;
      }) => ((input: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        observedAtMs: number;
        abortSignal: AbortSignal;
      }) => Promise<{ status: string }>);
    }) => {
      const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
      const resolver = opts.createStartupDialogResolver?.({
        controlPort: port,
        startupMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalResumeChoice: 'resume_full_session',
        },
      });
      expect(resolver).toBeDefined();
      await expect(resolver?.({
        screenState: parseClaudeScreenState(RESUME_CHOICE_DIALOG),
        observedAtMs: 1,
        abortSignal: new AbortController().signal,
      })).resolves.toEqual({ status: 'handled' });
      expect(port.sentLiteral).toEqual(['2']);
      expect(port.sentKeys).toEqual([]);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
        claudeUnifiedTerminalResumeChoice: 'resume_full_session',
      },
    });
  });

  it('passes a startup dialog resolver that handles orphan effort dialogs with the startup mode effort', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      createStartupDialogResolver?: (input: {
        controlPort: ReturnType<typeof createFakeControlPort>;
        startupMode: EnhancedMode;
      }) => ((input: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        observedAtMs: number;
        abortSignal: AbortSignal;
      }) => Promise<{ status: string }>);
    }) => {
      const port = createFakeControlPort({ captures: [EFFORT_CHANGE_DIALOG_HIGH, IDLE_COMPOSER] });
      const resolver = opts.createStartupDialogResolver?.({
        controlPort: port,
        startupMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          reasoningEffort: 'high',
        },
      });
      expect(resolver).toBeDefined();
      await expect(resolver?.({
        screenState: parseClaudeScreenState(EFFORT_CHANGE_DIALOG_HIGH),
        observedAtMs: 1,
        abortSignal: new AbortController().signal,
      })).resolves.toEqual({ status: 'handled' });
      expect(port.sentLiteral).toEqual(['1']);
      expect(port.sentKeys).toEqual([]);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
        reasoningEffort: 'high',
      },
    });
  });

  it('emits exact typed localId acceptance only at provider acceptance and preserves transcript seq on handback', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    };
    const client = session.client as unknown as {
      bindProviderInputOutcomeProducer: ReturnType<typeof vi.fn>;
      blockPendingMessageDelivery: ReturnType<typeof vi.fn>;
    };
    const observeProviderInputOutcome = vi.fn();
    client.bindProviderInputOutcomeProducer = vi.fn(() => observeProviderInputOutcome);
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
      unshift: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'queued before acceptance',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['l17'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage?: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      returnUnconsumedMessage?: (input: { message: string; mode: typeof mode; maxUserMessageSeq?: number | null; userMessageLocalIds?: readonly string[] }) => void;
      onPromptAcceptedByProvider?: (input: { message: string; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] }) => void;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch).toMatchObject({
        message: 'queued before acceptance',
        maxUserMessageSeq: 17,
        userMessageLocalIds: ['l17'],
      });
      opts.returnUnconsumedMessage?.({
        message: 'queued before acceptance',
        mode,
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
      opts.onPromptAcceptedByProvider?.({
        message: 'queued before acceptance',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    expect(queue.unshift).not.toHaveBeenCalled();
    expect(client.bindProviderInputOutcomeProducer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude',
      mode: 'unifiedTerminal',
      matchesCurrentSession: expect.any(Function),
    }));
    expect(observeProviderInputOutcome).toHaveBeenCalledWith({
      kind: 'accepted',
      localId: 'l17',
    });
  });

  it('dispatches replay carry-over through unified terminal and retires it only after exact provider acceptance', async () => {
    setProcessTty(false);
    const session = createSession({
      metadata: {
        replaySeedV1: {
          v: 1,
          seedText: 'CARRY-OVER',
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 41,
          createdAtMs: 123,
        },
      },
    });
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
      localId: 'transition-input',
    } as const;
    vi.mocked(session.queue.size).mockReturnValueOnce(1).mockReturnValue(0);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
      message: 'continue',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 42,
      userMessageLocalIds: ['transition-input'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{
        message: string;
        mode: typeof mode;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
      } | null>;
      onPromptAcceptedByProvider?: (input: {
        message: string;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
      }) => void;
    }) => {
      const batch = await opts.nextMessage();
      expect(batch).toMatchObject({
        message: 'CARRY-OVER\n\ncontinue',
        maxUserMessageSeq: 42,
        userMessageLocalIds: ['transition-input'],
      });
      const pendingSeed = (session.client.getMetadataSnapshot() as ReplaySeedTestMetadata).replaySeedV1;
      expect(pendingSeed).toMatchObject({ seedText: 'CARRY-OVER' });
      expect(pendingSeed?.appliedToLocalId).toBeUndefined();
      opts.onPromptAcceptedByProvider?.({
        message: batch?.message ?? '',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect((session.client.getMetadataSnapshot() as ReplaySeedTestMetadata).replaySeedV1).toMatchObject({
      seedText: '',
      appliedToLocalId: 'transition-input',
    });
  });

  it('preserves an inactive exact command and deferred provider custody through startup buffering', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    };
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'resume this exact row',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: null,
      userMessageLocalIds: ['exact-resume'],
      providerAcceptancePending: true,
      pendingProviderAction: 'send',
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{
        message: string;
        mode: typeof mode;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
        providerAcceptancePending?: boolean;
        pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
      } | null>;
    }) => {
      await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({
        message: 'resume this exact row',
        userMessageLocalIds: ['exact-resume'],
        providerAcceptancePending: true,
        pendingProviderAction: 'send',
      }));
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });
  });

  it('passes canonical Pending delivery state to the unified terminal runner', async () => {
    setProcessTty(false);
    const session = createSession();
    const client = session.client as unknown as {
      hasPendingProviderInputAcceptance: ReturnType<typeof vi.fn>;
      hasCanonicalPendingProviderInputDelivery: ReturnType<typeof vi.fn>;
    };
    client.hasPendingProviderInputAcceptance.mockReturnValueOnce(true);
    client.hasCanonicalPendingProviderInputDelivery.mockReturnValueOnce(false);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      resolvePromptDeliveryState?: (batch: {
        message: string;
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[];
      }) => 'pending' | 'accepted' | 'retired';
    }) => {
      expect(opts.resolvePromptDeliveryState?.({
        message: 'already accepted',
        maxUserMessageSeq: 739,
        userMessageLocalIds: ['prompt-739'],
      })).toBe('accepted');
      expect(opts.resolvePromptDeliveryState?.({
        message: 'discarded row',
        maxUserMessageSeq: 740,
        userMessageLocalIds: ['prompt-740'],
      })).toBe('retired');
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(client.hasPendingProviderInputAcceptance).toHaveBeenCalledWith('prompt-739');
    expect(client.hasCanonicalPendingProviderInputDelivery).toHaveBeenCalledWith('prompt-740');
  });

  it('registers terminal composer clear through additive session runtime controls', async () => {
    setProcessTty(false);
    const session = createSession();
    const unregister = vi.fn();
    const client = session.client as unknown as {
      registerSessionRuntimeControls: ReturnType<typeof vi.fn>;
    };
    client.registerSessionRuntimeControls.mockReturnValueOnce(unregister);

    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      registerTerminalComposerClearRuntimeControl?: (
        handler: (request: Readonly<{ sessionId: string }>) => Promise<unknown>,
      ) => (() => void) | void;
    }) => {
      expect(typeof opts.registerTerminalComposerClearRuntimeControl).toBe('function');
      const handler = vi.fn(async () => ({ ok: true, status: 'already_empty', sessionId: 'happy-session-id' }));
      const dispose = opts.registerTerminalComposerClearRuntimeControl?.(handler);

      expect(client.registerSessionRuntimeControls).toHaveBeenCalledWith({
        clearTerminalComposer: handler,
      });
      dispose?.();
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });
  });

  it('wires exact connected-service application to the Claude host and canonical Pending wake', async () => {
    setProcessTty(false);
    const session = createSession();
    const register = vi.mocked(session.registerConnectedServiceExactApplicationHandler);

    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      registerConnectedServiceExactApplicationHandler?: (
        handler: () => Promise<void>,
      ) => (() => void) | void;
      onConnectedServiceExactApplicationReleased?: () => void;
    }) => {
      const handler = vi.fn(async () => undefined);
      opts.registerConnectedServiceExactApplicationHandler?.(handler);
      expect(register).toHaveBeenCalledWith(handler);

      opts.onConnectedServiceExactApplicationReleased?.();
      expect(session.client.wakePendingMaterialization).toHaveBeenCalledOnce();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });
  });

  it('blocks deterministic pre-provider rejections without confirming provider acceptance', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    };
    const client = session.client as unknown as {
      blockPendingMessageDelivery: ReturnType<typeof vi.fn>;
      bindProviderInputOutcomeProducer: ReturnType<typeof vi.fn>;
    };
    const observeProviderInputOutcome = vi.fn();
    client.bindProviderInputOutcomeProducer = vi.fn(() => observeProviderInputOutcome);
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
      unshift: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'bad\u0000prompt',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 73,
      userMessageLocalIds: ['l73'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage?: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      onPromptTerminallyRejectedBeforeProvider?: (input: {
        message: string;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
        reason: 'invalid_prompt_text';
      }) => void;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch).toMatchObject({
        message: 'bad\u0000prompt',
        maxUserMessageSeq: 73,
        userMessageLocalIds: ['l73'],
      });
      opts.onPromptTerminallyRejectedBeforeProvider?.({
        message: 'bad\u0000prompt',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
        reason: 'invalid_prompt_text',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(queue.unshift).not.toHaveBeenCalled();
    expect(client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    expect(observeProviderInputOutcome).toHaveBeenCalledWith({
      kind: 'rejected_before_effect',
      localId: 'l73',
      reason: 'invalid_prompt_text',
    });
  });

  it('suppresses Claude transcript user echoes for accepted UI prompts', async () => {
    setProcessTty(false);
    const session = createSession();
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'hello from ui',
      mode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'auto',
      },
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['durable-echo-local-id'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage?: () => Promise<unknown>;
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onMessage?: (message: unknown) => void;
    }) => {
      await opts.nextMessage?.();
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'user-echo',
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        message: { role: 'user', content: 'hello from ui' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'assistant-reply',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenCalledTimes(1);
    expect(session.client.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'user-echo',
    }));
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-reply',
    }));
  });

  it('suppresses historical persisted user echoes during unified resume replay without suppressing fresh terminal input', async () => {
    setProcessTty(false);
    const session = createSession();
    const fetchRecentTranscriptTextItemsForAcpImport = session.client.fetchRecentTranscriptTextItemsForAcpImport;
    if (!fetchRecentTranscriptTextItemsForAcpImport) {
      throw new Error('test fixture missing fetchRecentTranscriptTextItemsForAcpImport');
    }
    vi.mocked(fetchRecentTranscriptTextItemsForAcpImport).mockResolvedValueOnce([
      { role: 'user', text: 'repeatable prompt' },
      { role: 'agent', text: 'old reply' },
    ]);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'user',
        uuid: 'historical-user-echo',
        timestamp: '2000-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'repeatable prompt' },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'fresh-terminal-user',
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        message: { role: 'user', content: 'repeatable prompt' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'assistant-reply',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 500 });
    expect(session.client.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'historical-user-echo',
    }));
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenCalledTimes(2);
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'user',
      uuid: 'fresh-terminal-user',
    }));
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-reply',
    }));
  });

  it('uses durable committed custody for historical resume backfill rows', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onHistoricalMessage?: (message: unknown) => Promise<void>;
    }) => {
      await opts.onHistoricalMessage?.({
        type: 'assistant',
        uuid: 'historical-row',
        timestamp: '2026-08-04T10:11:12.345Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'caught up' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sendClaudeSessionMessageCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'assistant',
        uuid: 'historical-row',
      }),
      {
        createdAt: Date.parse('2026-08-04T10:11:12.345Z'),
        updatedAt: Date.parse('2026-08-04T10:11:12.345Z'),
        provenance: { kind: 'non_dependent', source: 'history' },
      },
    );
    expect(session.client.sendClaudeSessionMessageCommittedExact).not.toHaveBeenCalled();
  });

  it('does not persist Claude compact summary or compact local-command artifacts from unified transcripts', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-summary-1',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context.',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'local-command-caveat-1',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: local command messages follow.</local-command-caveat>',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-command-1',
        message: {
          role: 'user',
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-stdout-1',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n' +
            "\u001b[2mPreCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully\u001b[22m\n" +
            "\u001b[2mPostCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully\u001b[22m</local-command-stdout>",
        },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sendClaudeSessionMessageCommittedExact).not.toHaveBeenCalled();
  });

  it('does not emit a stale compaction started event after a compact boundary completed event', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-1',
        session_id: 'claude-session-id',
        content: 'Conversation compacted',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-command-1',
        message: {
          role: 'user',
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    const compactionEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => (event as { type?: unknown }).type === 'context-compaction');

    expect(compactionEvents.map((event) => (event as { phase?: unknown }).phase)).toEqual(['completed']);
  });

  it('starts the canonical Claude turn only after a new-turn terminal injection is accepted', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
    }) => {
      expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.setThinkingWithoutTaskLifecycle).toHaveBeenCalledWith(true);
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(true);
  });

  it('completes the canonical Claude turn when unified lifecycle reports ready', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.completeTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });
    expect(readFirstInvocationOrder(vi.mocked(session.client.sessionTurnLifecycle!.completeTurn!), 'completeTurn')).toBeGreaterThan(
      readFirstInvocationOrder(vi.mocked(session.client.sessionTurnLifecycle!.beginTurn), 'beginTurn'),
    );
  });

  it('starts and completes a canonical Claude turn for terminal-originated unified prompts', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onProviderPromptStarted?: () => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onProviderPromptStarted?.();
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
      expect(session.client.sessionTurnLifecycle?.completeTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });
  });

  it('opens the canonical continuation barrier only when explicit --continue starts a provider launch', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--continue'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      claudeArgs?: readonly string[];
      onProviderLaunchStarting?: () => void | Promise<void>;
    }) => {
      expect(opts.claudeArgs).toEqual(['--continue']);
      expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
      await opts.onProviderLaunchStarting?.();
      expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });
  });

  it('does not start a second canonical turn for in-flight steering injections', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'in_flight_steer';
        turnStateAtInjection: 'running';
      }) => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'steer this turn',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'in_flight_steer',
        turnStateAtInjection: 'running',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
    expect(session.setThinkingWithoutTaskLifecycle).not.toHaveBeenCalledWith(true);
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(true);
  });

  it('uses a CLI positional prompt as the first terminal-injected unified input', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'run pwd'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      claudeArgs?: readonly string[];
      initialMode?: unknown;
      allowFirstInputBeforeSessionStart?: boolean;
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      expect(opts.claudeArgs).toEqual(['--model', 'opus']);
      expect(opts.initialMode).toBeUndefined();
      expect(opts.allowFirstInputBeforeSessionStart).toBe(true);
      const first = await opts.nextMessage();
      expect(first).toEqual({
        message: 'run pwd',
        mode: expect.objectContaining({
          permissionMode: 'acceptEdits',
          claudeUnifiedTerminalHost: 'zellij',
        }),
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
  });

  it('retries a CLI positional prompt when terminal-host startup fails before runner handback', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'run pwd'];
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after cleanup',
    });
    let runCount = 0;
    const observedPrompts: Array<string | null> = [];
    mocks.runClaudeUnifiedTerminalSession.mockImplementation(async (opts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      runCount += 1;
      const next = await opts.nextMessage();
      observedPrompts.push(next?.message ?? null);
      expect(next).toEqual(expect.objectContaining({
        message: 'run pwd',
        mode: expect.objectContaining({
          permissionMode: 'acceptEdits',
          claudeUnifiedTerminalHost: 'zellij',
        }),
      }));
      if (runCount === 1) {
        throw startupError;
      }
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(observedPrompts).toEqual(['run pwd', 'run pwd']);
  });

  it('imports CLI positional prompt transcript rows because Happier has no submitted-message echo to suppress', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'source cli prompt'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onMessage?: (message: unknown) => void;
    }) => {
      const first = await opts.nextMessage();
      expect(first).toEqual(expect.objectContaining({
        message: 'source cli prompt',
      }));
      if (!first) throw new Error('Expected CLI positional prompt');

      await opts.onTerminalPromptInjected?.({
        message: first.message,
        mode: first.mode,
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'cli-positional-user',
        message: { role: 'user', content: 'source cli prompt' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'cli-positional-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(session.client.recordClaudeJsonlMessageConsumed).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'cli-positional-user',
    }));
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenCalledTimes(2);
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'user',
      uuid: 'cli-positional-user',
    }));
    expect(session.client.sendClaudeSessionMessageCommittedExact).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'assistant',
      uuid: 'cli-positional-assistant',
    }));
  });

  it('allows the first session-queue prompt before Claude lifecycle starts', async () => {
    setProcessTty(false);
    const session = createSession();
    vi.mocked(session.queue.size).mockReturnValueOnce(1);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
      message: 'daemon queued prompt',
      mode: {
        permissionMode: 'safe-yolo',
        claudeUnifiedTerminalEnabled: true,
        localId: 'daemon-initial-prompt:happy-session-id',
      },
      userMessageLocalIds: ['daemon-initial-prompt:happy-session-id'],
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      allowFirstInputBeforeSessionStart?: boolean;
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      expect(opts.allowFirstInputBeforeSessionStart).toBe(true);
      await expect(opts.nextMessage()).resolves.toEqual({
        message: 'daemon queued prompt',
        mode: expect.objectContaining({
          permissionMode: 'safe-yolo',
          claudeUnifiedTerminalEnabled: true,
        }),
        maxUserMessageSeq: null,
        userMessageLocalIds: ['daemon-initial-prompt:happy-session-id'],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: undefined,
    });
  });

  it('materializes server-side pending messages while waiting for input instead of waiting only on the local queue (daemon-owned drain, QA C-F2/A-F3)', async () => {
    setProcessTty(false);
    const session = createSession();
    // Server holds one queued pending row; the local queue is empty until materialization
    // commits it (the transcript update path then delivers it into the queue).
    let queueSize = 0;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queueSize = 1;
      return { type: 'materialized' as const };
    });
    (session.client as unknown as Record<string, unknown>).materializeNextPendingMessageSafely =
      materializeNextPendingMessageSafely;
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return {
        message: 'queued on server',
        mode: { permissionMode: 'default' },
        hash: 'h1',
        userMessageLocalIds: ['pending-server-queued'],
      } as never;
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (runOpts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
        message: 'queued on server',
      }));
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'skip',
      activeTurnSteerability: 'unsteerable',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('attempts pending materialization while parked after host death (queued messages must not require a manual Send now)', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    let queueSize = 0;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queueSize = 1;
      return { type: 'materialized' as const, localId: 'pending-host-recovery' };
    });
    (session.client as unknown as Record<string, unknown>).materializeNextPendingMessageSafely =
      materializeNextPendingMessageSafely;
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return {
        message: 'try again',
        mode: { permissionMode: 'default' },
        hash: 'h1',
        maxUserMessageSeq: 1,
        userMessageLocalIds: ['pending-host-recovery'],
      } as never;
    });
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(hostDeadError)
      .mockImplementationOnce(async (runOpts: {
        claudeArgs?: readonly string[];
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        expect(runOpts.claudeArgs).toEqual(['--resume', 'claude-session-id']);
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'try again' }));
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    // The parked wait must include the daemon-owned pending drain, not just the local queue.
    expect(materializeNextPendingMessageSafely).toHaveBeenCalled();
  });

  it('parks after a live pump auth materialization failure and relaunches when pending input recovers', async () => {
    setProcessTty(false);
    const session = createSession();
    let queueSize = 0;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queueSize = 1;
      return { type: 'materialized' as const };
    });
    (session.client as unknown as Record<string, unknown>).materializeNextPendingMessageSafely =
      materializeNextPendingMessageSafely;
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return {
        message: 'queued after daemon auth recovery',
        mode: { permissionMode: 'default' },
        hash: 'h-auth',
        userMessageLocalIds: ['pending-after-auth-recovery'],
      } as never;
    });

    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(new PendingQueueMaterializationAuthError())
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
          message: 'queued after daemon auth recovery',
        }));
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalled();
  });

  it('forwards the resolved default coding prompt into unified terminal spawn options', async () => {
    setProcessTty(false);
    const session = createSession();
    Object.defineProperty(session, 'defaultSystemPromptText', {
      configurable: true,
      value: 'Resolved default coding prompt',
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      systemPromptText?: string | null;
    }) => {
      expect(opts.systemPromptText).toBe('Resolved default coding prompt');
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });
  });

  it('uses the committed assistant snapshot for unified ready notifications after terminal injection starts a turn', async () => {
    setProcessTty(false);
    const session = createSession();
    const sendToAllDevices = vi.fn();
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'ready-turn-1');
    const getTurnAssistantTextSnapshot = vi.fn((params: { turnToken?: string | null; startSeqExclusive?: number | null }) => (
      params.turnToken === 'ready-turn-1' && params.startSeqExclusive === 42
        ? {
            turnToken: 'ready-turn-1',
            text: 'Latest unified assistant response',
            observedAtMs: 123,
            seq: 45,
            localId: 'assistant-message-1',
            sidechainId: null,
            provider: 'claude',
            source: 'committed' as const,
          }
        : null
    ));
    (session as any).pushSender = { sendToAllDevices };
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 42);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 42 });
    expect(getTurnAssistantTextSnapshot).toHaveBeenCalledWith({
      turnToken: 'ready-turn-1',
      startSeqExclusive: 42,
    });
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Claude',
      'Latest unified assistant response',
      { sessionId: 'happy-session-id' },
    );
  });

  it('uses the committed assistant snapshot for terminal-originated unified ready notifications', async () => {
    setProcessTty(false);
    const session = createSession();
    const sendToAllDevices = vi.fn();
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'terminal-turn-1');
    const getTurnAssistantTextSnapshot = vi.fn((params: { turnToken?: string | null; startSeqExclusive?: number | null }) => (
      params.turnToken === 'terminal-turn-1' && params.startSeqExclusive === 7
        ? {
            turnToken: 'terminal-turn-1',
            text: 'Direct terminal assistant response',
            observedAtMs: 456,
            seq: 9,
            localId: 'assistant-message-terminal',
            sidechainId: null,
            provider: 'claude',
            source: 'committed' as const,
          }
        : null
    ));
    (session as any).pushSender = { sendToAllDevices };
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 7);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onProviderPromptStarted?: () => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onProviderPromptStarted?.();
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 7 });
    expect(getTurnAssistantTextSnapshot).toHaveBeenCalledWith({
      turnToken: 'terminal-turn-1',
      startSeqExclusive: 7,
    });
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Claude',
      'Direct terminal assistant response',
      { sessionId: 'happy-session-id' },
    );
  });

  it('honors account notification settings and secrets for unified ready notifications', async () => {
    setProcessTty(false);
    const session = createSession();
    const settingsSecretsReadKeys = [new Uint8Array(32).fill(5)];
    const accountSettings = {
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: false,
        permissionRequest: true,
      },
    } as AccountSettings;
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'ready-turn-no-preview');
    const getTurnAssistantTextSnapshot = vi.fn(() => ({
      turnToken: 'ready-turn-no-preview',
      text: 'This text must not be included',
      observedAtMs: 123,
      seq: 45,
      localId: 'assistant-message-hidden',
      sidechainId: null,
      provider: 'claude',
      source: 'committed' as const,
    }));
    (session as any).pushSender = { sendToAllDevicesAsync: vi.fn() };
    (session as any).accountSettings = accountSettings;
    (session as any).accountSettingsSecretsReadKeys = settingsSecretsReadKeys;
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 42);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchActivityNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
        settings: accountSettings,
        settingsSecretsReadKeys,
        event: expect.objectContaining({
          topic: 'ready',
          assistantPreviewText: null,
        }),
      }));
    });
    expect(getTurnAssistantTextSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces unified StopFailure usage-limit details through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onUsageLimitDetails?: (details: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onUsageLimitDetails).toBeTypeOf('function');
      opts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'rate_limit',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'claude',
          usageLimit: expect.objectContaining({
            providerLimitId: 'rate_limit',
          }),
        }),
      });
    });
  });

  it('surfaces unified overloaded capacity details through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onUsageLimitDetails?: (details: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onUsageLimitDetails).toBeTypeOf('function');
      opts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        limitCategory: 'capacity',
        providerLimitId: 'server_overloaded',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
          usageLimit: expect.objectContaining({
            limitCategory: 'capacity',
            providerLimitId: 'server_overloaded',
          }),
        }),
      });
    });
  });

  it('surfaces unified transcript auth failures through the session runtime issue path', async () => {
    setProcessTty(false);
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'claude-main',
      fallbackProfileId: 'claude-main',
      generation: 1,
    }]);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onRuntimeAuthFailureEvent).toBeTypeOf('function');
      await opts.onRuntimeAuthFailureEvent?.({
        type: 'assistant',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      });
    });

    try {
      await claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'auto',
        },
      });
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
    }

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'auth_error',
          source: 'auth_error',
          provider: 'claude',
        }),
      });
    });
  });

  it('keeps provider auth evidence primary and parks when terminal host death follows in the same failure window', async () => {
    setProcessTty(false);
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'claude-main',
      fallbackProfileId: 'claude-main',
      generation: 1,
    }]);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    let queueSize = 1;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return {
        message: 'retry after login',
        mode: { permissionMode: 'default' },
        hash: 'h-auth-retry',
        maxUserMessageSeq: 2,
        userMessageLocalIds: ['pending-auth-retry'],
      } as never;
    });
    mocks.runClaudeUnifiedTerminalSession
      .mockImplementationOnce(async (opts: {
        onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
      }) => {
        expect(opts.onRuntimeAuthFailureEvent).toBeTypeOf('function');
        await opts.onRuntimeAuthFailureEvent?.({
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'authentication_failed',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
          },
        });
        throw hostDeadError;
      })
      .mockImplementationOnce(async (opts: {
        claudeArgs?: readonly string[];
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        expect(opts.claudeArgs).toEqual(['--resume', 'claude-session-id']);
        await expect(opts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'retry after login' }));
      });

    try {
      await expect(claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'zellij',
        },
      })).resolves.toEqual({ type: 'exit', code: 0 });
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
    }

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'auth_error',
        source: 'auth_error',
        provider: 'claude',
      }),
    });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_process_exit',
        source: 'provider_process_exit',
      }),
    });
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('Claude unified terminal host is not alive'),
    }));
    expect(session.client.flush).toHaveBeenCalled();
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
  });

  it('relaunches once while runtime auth recovery continues without consuming the park failure latch', async () => {
    setProcessTty(false);
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'claude-main',
      fallbackProfileId: 'claude-main',
      generation: 1,
    }]);
    mocks.reportConnectedServiceRuntimeAuthFailureToDaemon.mockResolvedValueOnce({
      handled: true,
      report: { status: 'credential_refreshed', restartRequested: true },
      statusCode: 'credential_refreshed_restart_requested',
      statusMessage: 'Credential refreshed',
      projection: {
        handled: true,
        statusCode: 'credential_refreshed_restart_requested',
        statusMessage: 'Credential refreshed',
      },
    } as never);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    mocks.runClaudeUnifiedTerminalSession
      .mockImplementationOnce(async (opts: {
        onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
      }) => {
        await opts.onRuntimeAuthFailureEvent?.({
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'authentication_failed',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
          },
        });
        throw hostDeadError;
      })
      .mockResolvedValueOnce(undefined);

    try {
      await expect(claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'zellij',
        },
      })).resolves.toEqual({ type: 'exit', code: 0 });
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
    }

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('Not retrying automatically'),
    }));
  });

  it('surfaces unified transcript provider API errors through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (acceptedPrompt: {
        message: string;
        mode: { permissionMode: 'default'; claudeUnifiedTerminalEnabled: true };
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onPromptTurnTerminal?: (event: {
        reason: 'failed';
        source: string;
        detail?: string;
      }) => void | Promise<void>;
    }) => {
      expect(opts.onPromptTurnTerminal).toBeTypeOf('function');
      await opts.onTerminalPromptInjected?.({
        message: 'hello',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onPromptTurnTerminal?.({
        reason: 'failed',
        source: 'claude_transcript_api_error',
        detail: 'api_error',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
        }),
      });
    });
  });

  it('surfaces unobserved failed terminal prompt turns through the runtime issue path before terminalizing', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (acceptedPrompt: {
        message: string;
        mode: { permissionMode: 'default'; claudeUnifiedTerminalEnabled: true };
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onPromptTurnTerminal?: (event: {
        reason: 'failed';
        source: string;
        providerAcceptanceFailureObserved?: boolean;
      }) => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onPromptTurnTerminal?.({
        reason: 'failed',
        source: 'claude_hook_stop_failure',
        providerAcceptanceFailureObserved: false,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_session_error',
          source: 'provider_session_error',
          provider: 'claude',
        }),
        allocateWhenIdle: true,
      });
    });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.flush).toHaveBeenCalled();
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('cancels aborted terminal prompt turns without also marking them failed', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (acceptedPrompt: {
        message: string;
        mode: { permissionMode: 'default'; claudeUnifiedTerminalEnabled: true };
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onPromptTurnTerminal?: (event: {
        reason: 'aborted';
        source: string;
      }) => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'stop the current work',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onPromptTurnTerminal?.({
        reason: 'aborted',
        source: 'claude_hook_stop',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.abortCurrentTaskTurn).toHaveBeenCalled();
  });

  it('surfaces terminal host death through the primary turn runtime issue path and stays parked until shutdown', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(hostDeadError);

    const abortController = new AbortController();
    const result = claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalled();
    });
    let resolved = false;
    void result.then(() => { resolved = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(resolved).toBe(false);

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_process_exit',
        source: 'provider_process_exit',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('Claude unified terminal host is not alive'),
    }));
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('before Happier could send your prompt'),
    }));
    expect(session.client.flush).toHaveBeenCalled();
    expect(readFirstInvocationOrder(vi.mocked(session.client.flush), 'flush')).toBeGreaterThan(
      readFirstInvocationOrder(getFailTurnSpy(session), 'failTurn'),
    );
    expect(readFirstInvocationOrder(vi.mocked(session.client.flush), 'flush')).toBeGreaterThan(
      readFirstInvocationOrder(vi.mocked(session.client.sendSessionEvent), 'sendSessionEvent'),
    );
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);

    abortController.abort();
    await expect(result).resolves.toEqual({ type: 'exit', code: 1 });
  });

  it('escalates once to a durable attention state after repeated inconclusive recovery probes without disposing', async () => {
    setProcessTty(false);
    const session = createSession();
    // A wedged-but-alive host (socket present, client probe times out) throws recovery_probe_inconclusive
    // on every relaunch. The launcher must never auto-dispose (no positive death evidence) yet must not
    // livelock silently: after a bounded number of consecutive inconclusive probes it surfaces one
    // durable, user-visible attention event.
    const inconclusiveError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'recovery_probe_inconclusive',
      message: 'Terminal host recovery probe was inconclusive; retaining the saved host for retry',
    });
    // Feed a message on every park wake so the loop keeps relaunching until the budget runs out.
    vi.mocked(session.queue.size).mockReturnValue(1);
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValue({
        message: 'still there?',
        mode: { permissionMode: 'default' },
        hash: 'h',
        userMessageLocalIds: ['pending-inconclusive-recovery'],
      } as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValue(inconclusiveError);

    const result = await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });
    expect(result).toEqual({ type: 'exit', code: 1 });

    const escalationCalls = vi.mocked(session.client.sendSessionEvent).mock.calls.filter(([event]) =>
      typeof event === 'object'
      && event !== null
      && (event as { message?: unknown }).message !== undefined
      && String((event as { message: unknown }).message).includes('not responding to liveness checks'),
    );
    expect(escalationCalls).toHaveLength(1);
  });

  it('parks for the next message and relaunches the unified host after terminal host death', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'sonnet', '--session-id', 'initial-session-id', '--fork-session'];
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    let queueSize = 1;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return {
        message: 'try again',
        mode: { permissionMode: 'default' },
        hash: 'h1',
        maxUserMessageSeq: 3,
        userMessageLocalIds: ['pending-host-retry'],
      } as never;
    });
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(hostDeadError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'try again' }));
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(mocks.runClaudeUnifiedTerminalSession.mock.calls[1]?.[0]).toMatchObject({
      claudeArgs: ['--model', 'sonnet', '--resume', 'claude-session-id'],
    });
  });

  it('keeps a host-dead runner parked across an empty queue wake until durable input arrives', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    let queueReady = false;
    let queueWakeCount = 0;
    vi.mocked(session.queue.size).mockImplementation(() => queueReady ? 1 : 0);
    vi.mocked(session.queue.waitForMessagesSignal).mockImplementation(async () => {
      queueWakeCount += 1;
      if (queueWakeCount === 1) {
        return false;
      }
      queueReady = true;
      return true;
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockImplementationOnce(async () => {
        queueReady = false;
        return {
          message: 'durable prompt after host recovery',
          mode: { permissionMode: 'default' },
          hash: 'h-recovery',
          maxUserMessageSeq: 42,
          userMessageLocalIds: ['local-recovery-42'],
        } as never;
      });
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(hostDeadError)
      .mockImplementationOnce(async (runOpts: {
        claudeArgs?: readonly string[];
        nextMessage: () => Promise<{
          message: string;
          mode: unknown;
          maxUserMessageSeq: number | null;
          userMessageLocalIds: readonly string[];
        } | null>;
      }) => {
        expect(runOpts.claudeArgs).toEqual(['--resume', 'claude-session-id']);
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
          message: 'durable prompt after host recovery',
          maxUserMessageSeq: 42,
          userMessageLocalIds: ['local-recovery-42'],
        }));
      });

    const result = await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(result).toEqual({ type: 'exit', code: 0 });
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
  });

  it('surfaces terminal injection failures through the primary turn runtime issue path and exits gracefully instead of escaping as a fatal command error (incident cmq7pyqkj)', async () => {
    setProcessTty(false);
    const session = createSession();
    const signal = abortLauncherOnEmptyQueueWait(session);
    const injectionError = Object.assign(new Error('Claude unified terminal injection failed: timeout'), {
      code: 'claude_unified_terminal_injection_failed',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(injectionError);

    // The runner must NEVER exit fatally on a classified injection failure: it surfaces the
    // structured runtime issue and (with no queued message and a closed/aborted queue) exits
    // gracefully — never rethrows into `[claude] Fatal command error` (incident cmq7pyqkj).
    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal,
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('never propagates a zellij action timeout as a runner-fatal error', async () => {
    setProcessTty(false);
    const session = createSession();
    const signal = abortLauncherOnEmptyQueueWait(session);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(new ZellijActionTimeoutError('list-panes'));

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal,
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
  });

  it('surfaces invalid prompt text once without parking, requeueing, or relaunching', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'invalid_prompt_text',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValue({
      message: 'bad\u0000prompt',
      mode: { permissionMode: 'default' },
      hash: 'h1',
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(injectionError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
    expect(session.queue.unshift).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
  });

  it.each([
    ['separate --settings value', ['--settings', '/tmp/user-settings.json']],
    ['inline --settings=value', ['--settings={"permissions":{"allow":[]}}']],
  ])('surfaces managed %s rejection as a structured runtime issue without generic fatal escape', async (_label, claudeArgs) => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = claudeArgs;
    const settingsError = new ClaudeUnifiedTerminalManagedSettingsOptionError([
      { code: 'managed_settings_option', option: '--settings' },
    ]);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(settingsError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.client.flush).toHaveBeenCalled();
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
  });

  it('keeps the session alive after a fatal mid-turn injection failure: surfaces the issue, waits for the next message, and relaunches (incident cmq7pyqkj)', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    let queueSize = 1;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockImplementationOnce(async () => {
        queueSize = 0;
        return {
          message: 'resume after failure',
          mode: { permissionMode: 'default' },
          hash: 'h1',
          userMessageLocalIds: ['pending-resume-after-failure'],
        } as never;
      })
      .mockResolvedValue(null as never);
    const secondRunFirstBatch: Array<{ message: string } | null> = [];
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(injectionError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        secondRunFirstBatch.push(await runOpts.nextMessage());
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(secondRunFirstBatch).toEqual([expect.objectContaining({ message: 'resume after failure' })]);
    // The failed turn was surfaced as a structured runtime issue before parking.
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
  });

  it('does not park and relaunch the same prompt after recoverable provider-acceptance timeout exhaustion', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValue({
      message: 'same unconfirmed prompt',
      mode: { permissionMode: 'default' },
      hash: 'h1',
      maxUserMessageSeq: 41,
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (runOpts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => Promise<void> | void;
    }) => {
      await runOpts.onTerminalPromptInjected?.({
        message: 'same unconfirmed prompt',
        mode: { permissionMode: 'default' },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      throw injectionError;
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('requeues a parked message when relaunch fails during terminal-host startup before runner handback', async () => {
    setProcessTty(false);
    const session = createSession({
      metadata: {
        replaySeedV1: {
          v: 1,
          seedText: 'CARRY-OVER',
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 30,
          createdAtMs: 123,
        },
      },
    });
    const signal = abortLauncherOnEmptyQueueWait(session, 2);
    const mode = { permissionMode: 'default', localId: 'pending-retry-after-startup-failure' };
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after cleanup',
    });
    let queueSize = 1;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockImplementationOnce(async () => {
        queueSize = 0;
        return {
          message: 'retry after startup failure',
          mode,
          hash: 'h1',
          maxUserMessageSeq: 31,
          userMessageLocalIds: ['pending-retry-after-startup-failure'],
        } as never;
      })
      .mockResolvedValue(null as never);
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(injectionError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
          message: 'CARRY-OVER\n\nretry after startup failure',
          maxUserMessageSeq: 31,
        }));
        throw startupError;
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal,
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.queue.unshift).toHaveBeenCalledWith(
      'retry after startup failure',
      mode,
      { userMessageSeq: 31, userMessageLocalIds: ['pending-retry-after-startup-failure'] },
    );
  });

  it('stops park/relaunch after the bounded budget of consecutive failures instead of looping forever (A4-MED-3)', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    // A deterministically failing host with an always-available bounced message (the HIGH-2
    // handback re-pends the failed batch) must not relaunch unboundedly.
    vi.mocked(session.queue.size).mockReturnValue(1);
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValue({
        message: 'poison message',
        mode: { permissionMode: 'default' },
        hash: 'h1',
        userMessageLocalIds: ['pending-poison-message'],
      } as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValue(injectionError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    // 1 initial run + 3 budgeted relaunches.
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(4);
    const events = vi.mocked(session.client.sendSessionEvent).mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.some((event) => event.type === 'message' && String(event.message).includes('Not retrying automatically'))).toBe(true);
  });

  it('pauses durable pending rows and stays alive parked after exhausting the relaunch budget instead of exiting (RC-RESUMEFLAP)', async () => {
    // Live incident 2026-07-08 (session cmr377jsr, runner pid 5526): four deterministic
    // host-startup failures burned the park budget in ~50s and the runner exited code 1,
    // leaving a dead session the user had to resume manually (the flap). With durable
    // server-owned rows the exhaustion path must instead BLOCK the poisoned rows
    // (terminal_host_unreachable) and keep the runner alive parked for genuinely new input.
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) throw new Error('test fixture missing blockPendingMessageDelivery');
    vi.mocked(blockPendingMessageDelivery).mockResolvedValue(true);

    // The poisoned batch keeps re-materializing (its rows stay deliverable) until the launcher
    // blocks them; after the block the queue goes quiet (blocked rows no longer materialize).
    let rowsBlocked = false;
    vi.mocked(blockPendingMessageDelivery).mockImplementation(async () => {
      rowsBlocked = true;
      return true;
    });
    // Keep the queue wait observable after the row is blocked so the harness can model the
    // live parked runner until the test-owned abort closes that wait.
    vi.mocked(session.queue.size).mockReturnValue(1);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation((async (abortSignal?: AbortSignal) => {
      if (!rowsBlocked) {
        return {
          message: 'poison message',
          mode: { permissionMode: 'default' },
          hash: 'h1',
          maxUserMessageSeq: 7,
          userMessageLocalIds: ['local-poison-1'],
        };
      }
      return await new Promise((resolveWait) => {
        if (abortSignal?.aborted) {
          resolveWait(null);
          return;
        }
        abortSignal?.addEventListener('abort', () => resolveWait(null), { once: true });
      });
    }) as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValue(injectionError);

    const abortController = new AbortController();
    const result = claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
        localIds: ['local-poison-1'],
        reason: 'terminal_host_unreachable',
      });
    });

    // Budget consumed: 1 initial run + 3 relaunches, then the rows were paused — and the
    // launcher must still be alive parked (not resolved) with no fifth relaunch.
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(4);
    let resolved = false;
    void result.then(() => { resolved = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(resolved).toBe(false);
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(4);

    const events = vi.mocked(session.client.sendSessionEvent).mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.some((event) => event.type === 'message' && String(event.message).includes('paused'))).toBe(true);

    abortController.abort();
    // Same terminal shape as the existing park-wait-aborted paths.
    await expect(result).resolves.toEqual({ type: 'exit', code: 1 });
  });

  it('surfaces a startup readiness timeout and re-adopts the preserved live host without making the wrapper inactive', async () => {
    setProcessTty(false);
    const session = createSession();
    const readinessError = new ClaudeUnifiedTerminalReadinessTimeoutError({
      timeoutMs: 15_000,
      handle: {
        kind: 'zellij',
        sessionName: 'happier-claude-session-test',
        paneId: '1',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      diagnostics: {
        elapsedMs: 16_000,
        hostAlive: true,
        sessionStartObserved: true,
        lastLivenessPaneAlive: true,
        lastScreenTail: 'Initializing Claude Code…',
      },
    });
    mocks.runClaudeUnifiedTerminalSession
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: { permissionMode: string } } | null>;
        returnUnconsumedMessage?: (input: {
          message: string;
          mode: { permissionMode: string };
          maxUserMessageSeq?: number | null;
          userMessageLocalIds?: readonly string[] | null;
        }) => void;
        onTerminalHostReady?: (input: { handle: TerminalHostHandle; terminal: TerminalAttachmentInfo['terminal'] }) => Promise<void>;
      }) => {
        const batch = await runOpts.nextMessage();
        expect(batch).toEqual(expect.objectContaining({
          message: 'resume after readiness timeout',
        }));
        if (!batch) throw new Error('expected pending readiness-timeout batch');
        runOpts.returnUnconsumedMessage?.({
          message: batch.message,
          mode: batch.mode,
          maxUserMessageSeq: null,
          userMessageLocalIds: ['pending-readiness-timeout'],
        });
        await runOpts.onTerminalHostReady?.({
          handle: {
            kind: 'zellij',
            sessionName: 'happier-claude-session-test',
            paneId: '1',
            attachmentId: 'attachment-created-by-first-attempt' as NonNullable<TerminalHostHandle['attachmentId']>,
            attachMetadata: {
              attachStrategy: 'terminal_host',
              topology: 'shared',
              locality: 'same_machine',
              liveProbe: 'required',
            },
          },
          terminal: {
            mode: 'plain',
          },
        });
        throw readinessError;
      })
      .mockImplementationOnce(async (runOpts: { expectedExistingTerminalHostAttachmentId?: string }) => {
        expect(runOpts.expectedExistingTerminalHostAttachmentId).toBe('attachment-created-by-first-attempt');
      });
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
      message: 'resume after readiness timeout',
      mode: { permissionMode: 'default' },
      hash: 'resume-timeout-hash',
      userMessageLocalIds: ['pending-readiness-timeout'],
    } as never);
    vi.mocked(session.queue.size).mockReturnValueOnce(1);

    // The readiness issue remains visible, but the same wrapper retries the exact preserved host;
    // returning exit 1 here would publish session death while Claude keeps running underneath.
    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(session.queue.unshift).toHaveBeenCalledWith(
      'resume after readiness timeout',
      expect.objectContaining({ permissionMode: 'default' }),
      { userMessageSeq: null, userMessageLocalIds: ['pending-readiness-timeout'] },
    );
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('pauses durable rows after repeated readiness timeouts instead of redelivering them forever', async () => {
    setProcessTty(false);
    const session = createSession();
    const readinessError = new ClaudeUnifiedTerminalReadinessTimeoutError({
      timeoutMs: 15_000,
      handle: {
        kind: 'tmux',
        sessionName: 'happier-claude-readiness-loop',
        paneId: '0',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      diagnostics: {
        elapsedMs: 15_000,
        hostAlive: true,
        sessionStartObserved: false,
        lastLivenessPaneAlive: true,
        lastScreenTail: '❯ No, exit\n  Yes, I accept\nEnter to confirm · Esc to cancel',
      },
    });
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) throw new Error('test fixture missing blockPendingMessageDelivery');
    let rowsBlocked = false;
    vi.mocked(blockPendingMessageDelivery).mockImplementation(async () => {
      rowsBlocked = true;
      return true;
    });
    vi.mocked(session.queue.size).mockReturnValue(1);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation((async (abortSignal?: AbortSignal) => {
      if (!rowsBlocked) {
        return {
          message: 'poisoned startup message',
          mode: { permissionMode: 'default' },
          hash: 'readiness-loop',
          maxUserMessageSeq: 9,
          userMessageLocalIds: ['local-readiness-loop'],
        };
      }
      return await new Promise((resolveWait) => {
        if (abortSignal?.aborted) return resolveWait(null);
        abortSignal?.addEventListener('abort', () => resolveWait(null), { once: true });
      });
    }) as never);
    mocks.runClaudeUnifiedTerminalSession.mockImplementation(async (runOpts: {
      nextMessage: () => Promise<{
        message: string;
        mode: { permissionMode: string };
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      } | null>;
      returnUnconsumedMessage?: (input: {
        message: string;
        mode: { permissionMode: string };
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[] | null;
      }) => void;
    }) => {
      const batch = await runOpts.nextMessage();
      if (!batch) throw new Error('expected pending readiness-timeout batch');
      runOpts.returnUnconsumedMessage?.(batch);
      throw readinessError;
    });

    const abortController = new AbortController();
    const result = claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
      signal: abortController.signal,
    });

    await vi.waitFor(() => {
      expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
        localIds: ['local-readiness-loop'],
        reason: 'terminal_host_unreachable',
      });
    });
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(4);

    abortController.abort();
    await expect(result).resolves.toEqual({ type: 'exit', code: 1 });
  });

  it('surfaces terminal-host startup failures as structured runtime issues and exits without generic fatal handling', async () => {
    setProcessTty(false);
    const session = createSession();
    const signal = abortLauncherOnEmptyQueueWait(session);
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after bootstrap cleanup',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(startupError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
      signal,
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('does not surface recoverable ambiguous terminal injection failures as primary turn failures', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      userMessageLocalIds: [],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => void | Promise<void>;
    }) => {
      await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
  });

  it('surfaces Windows-console submit failures after Enter as primary turn failures', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      recoverable: true,
      userMessageLocalIds: ['pending-local-visible-after-enter'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => void | Promise<void>;
    }) => {
      await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('surfaces provider-acceptance timeouts that have no pending delivery owner', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: [],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => void | Promise<void>;
    }) => {
      await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('blocks provider-owned pending delivery for deterministic oversized terminal prompts', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'payload_too_large',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: true,
      userMessageLocalIds: ['pending-local-too-large'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => void | Promise<void>;
    }) => {
      await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-local-too-large'],
      reason: 'payload_too_large',
    });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
  });

  it('routes provider-acceptance timeout uncertainty through the typed generation before later exact acceptance', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    const observeProviderInputOutcome = vi.fn();
    (session.client as unknown as {
      bindProviderInputOutcomeProducer: ReturnType<typeof vi.fn>;
    }).bindProviderInputOutcomeProducer = vi.fn(() => observeProviderInputOutcome);
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      maxUserMessageSeq: 87,
      userMessageLocalIds: ['pending-local-timeout'],
    });
    let failureHandlingResult: unknown;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => unknown;
      onPromptAcceptedByProvider?: (input: {
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
      }) => void;
    }) => {
      failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
      opts.onPromptAcceptedByProvider?.({
        maxUserMessageSeq: 87,
        userMessageLocalIds: ['pending-local-timeout'],
      });
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    expect(observeProviderInputOutcome.mock.calls).toEqual([
      [{ kind: 'effect_may_have_occurred', localId: 'pending-local-timeout' }],
      [{ kind: 'accepted', localId: 'pending-local-timeout' }],
    ]);
    expect(failureHandlingResult).toEqual({ action: 'surfaced_runtime_issue' });
    expect(session.queue.unshift).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('preserves a fresh primary usage-limit cause when pending delivery acceptance times out', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    const resetAtMs = Date.now() + 60_000;
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: ['pending-local-rate-limited'],
    });
    let failureHandlingResult: unknown;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onUsageLimitDetails?: (details: unknown) => void | Promise<void>;
      onTerminalInjectionFailure?: (error: Error) => unknown;
    }) => {
      opts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'rate_limit',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
      failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    expect(failureHandlingResult).toEqual({ action: 'surfaced_runtime_issue' });
    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'claude',
          usageLimit: expect.objectContaining({
            providerLimitId: 'rate_limit',
            resetAtMs,
          }),
        }),
      });
    });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
      }),
      allocateWhenIdle: true,
    });
  });

  it('preserves a usage-limit screen dialog cause when pending delivery acceptance times out', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValue(true);
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
      userMessageLocalIds: ['pending-local-screen-rate-limited'],
    });
    let failureHandlingResult: unknown;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalScreenObserved?: (observation: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        userMessageLocalIds?: readonly string[];
      }) => void;
      onTerminalInjectionFailure?: (error: Error) => unknown;
    }) => {
      const screenState = parseClaudeScreenState(USAGE_LIMIT_DIALOG);
      expect(screenState.usageLimitDialogVisible).toBe(true);
      opts.onTerminalScreenObserved?.({
        screenState,
        userMessageLocalIds: ['pending-local-screen-rate-limited'],
      });
      failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-local-screen-rate-limited'],
      reason: 'provider_unavailable_before_acceptance',
    });
    expect(failureHandlingResult).toEqual({ action: 'surfaced_runtime_issue' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
      }),
      allocateWhenIdle: true,
    });
  });

  it('wakes the shared pending-materialization owner without retrying rows when a usage-limit dialog clears', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalScreenObserved?: (observation: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        userMessageLocalIds?: readonly string[];
      }) => void;
    }) => {
      opts.onTerminalScreenObserved?.({
        screenState: parseClaudeScreenState(USAGE_LIMIT_DIALOG),
        userMessageLocalIds: ['retry-provider-unavailable-local'],
      });
      await Promise.resolve();
      opts.onTerminalScreenObserved?.({
        screenState: parseClaudeScreenState(IDLE_COMPOSER),
        userMessageLocalIds: ['retry-provider-unavailable-local'],
      });
      opts.onTerminalScreenObserved?.({
        screenState: parseClaudeScreenState(IDLE_COMPOSER),
        userMessageLocalIds: ['retry-provider-unavailable-local'],
      });
      await vi.waitFor(() => {
        expect(session.client.wakePendingMaterialization).toHaveBeenCalledTimes(1);
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

  });

  it('blocks provider-owned pending delivery when the terminal host is lost after writing', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'host_unreachable',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      recoverable: true,
      userMessageLocalIds: ['pending-local-host-lost'],
    });
    let failureHandlingResult: unknown;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => unknown;
    }) => {
      failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-local-host-lost'],
      reason: 'terminal_host_unreachable',
    });
    expect(failureHandlingResult).toEqual({ action: 'claimed_pending_delivery' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
  });

  it('blocks an exact pre-write no-target steer without terminalizing the provider turn', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    const injectionError = Object.assign(new Error('Claude unified terminal steer target is unavailable'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'no_target',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
      pendingProviderAction: 'steer',
      userMessageLocalIds: ['pending-local-steer'],
    });
    let failureHandlingResult: unknown;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => unknown;
    }) => {
      failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
      localIds: ['pending-local-steer'],
      reason: 'steering_unavailable',
      providerEffect: 'none',
    });
    expect(failureHandlingResult).toEqual({ action: 'claimed_pending_delivery' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
  });

  it.each([
    ['is unavailable', 'unavailable'],
    ['returns false', 'returns_false'],
    ['rejects', 'rejects'],
  ] as const)(
    'keeps the foreground provider turn open when exact steer rejection bookkeeping %s',
    async (_label, bookkeepingOutcome) => {
      setProcessTty(false);
      const session = createSession();
      const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
      if (!blockPendingMessageDelivery) {
        throw new Error('test fixture missing blockPendingMessageDelivery');
      }
      const hasActiveCanonicalTurn = session.client.hasActiveCanonicalTurn;
      if (!hasActiveCanonicalTurn) {
        throw new Error('test fixture missing hasActiveCanonicalTurn');
      }
      vi.mocked(hasActiveCanonicalTurn).mockReturnValue(true);
      if (bookkeepingOutcome === 'unavailable') {
        session.client.blockPendingMessageDelivery = undefined;
      } else if (bookkeepingOutcome === 'rejects') {
        vi.mocked(blockPendingMessageDelivery).mockRejectedValueOnce(new Error('pending block write failed'));
      } else {
        vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(false);
      }
      const injectionError = Object.assign(new Error('Claude unified terminal steer target is unavailable'), {
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
        reason: 'no_target',
        phase: 'before_write',
        duplicateRisk: 'none',
        recoverable: false,
        pendingProviderAction: 'steer',
        userMessageLocalIds: ['pending-local-steer-bookkeeping-failure'],
      });
      let failureHandlingResult: unknown;
      mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
        onThinkingChange?: (thinking: boolean) => void;
        onTerminalInjectionFailure?: (error: Error) => unknown;
      }) => {
        opts.onThinkingChange?.(true);
        failureHandlingResult = await opts.onTerminalInjectionFailure?.(injectionError);
      });

      await expect(claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'tmux',
        },
      })).resolves.toEqual({ type: 'exit', code: 0 });

      if (bookkeepingOutcome === 'unavailable') {
        expect(blockPendingMessageDelivery).not.toHaveBeenCalled();
      } else {
        expect(blockPendingMessageDelivery).toHaveBeenCalledWith({
          localIds: ['pending-local-steer-bookkeeping-failure'],
          reason: 'steering_unavailable',
          providerEffect: 'none',
        });
      }
      expect(failureHandlingResult).toBeUndefined();
      expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
      expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
    },
  );

  it('registers UI abort as a terminal-host turn interrupt for CLI-started unified sessions', async () => {
    setProcessTty(false);
    const session = createSession();
    const turnInterrupt = vi.fn(async () => {});
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
      setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void;
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
    }) => {
      runnerSignal = opts.signal;
      opts.setTurnInterrupt?.(turnInterrupt);
      await opts.onTerminalPromptInjected?.({
        message: 'please stop this',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await abortHandler?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.client.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(turnInterrupt).toHaveBeenCalledTimes(1);
    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(runnerSignal?.aborted).toBe(false);
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Aborted by user' });
  });

  it('does not stop the unified terminal host when UI abort is requested before an interrupt handler is ready', async () => {
    setProcessTty(false);
    const session = createSession();
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
    }) => {
      runnerSignal = opts.signal;
      expect(await abortHandler?.()).toBe(true);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(runnerSignal?.aborted).toBe(false);
  });

  it('does not stop the unified terminal host when terminal turn interruption fails', async () => {
    setProcessTty(false);
    const session = createSession();
    const turnInterrupt = vi.fn(async () => {
      throw new Error('terminal unavailable');
    });
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
      setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void;
    }) => {
      runnerSignal = opts.signal;
      opts.setTurnInterrupt?.(turnInterrupt);
      expect(await abortHandler?.()).toBe(true);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(turnInterrupt).toHaveBeenCalledTimes(1);
    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(runnerSignal?.aborted).toBe(false);
  });

  it('wires blocked-apply starvation honesty (F2): escalation surfaces ONE user-visible session message', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: { consecutiveBlockedApplies: number }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({ consecutiveBlockedApplies: 6 });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    const messageEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string })
      .filter((event) => event.type === 'message');
    expect(messageEvents).toHaveLength(1);
  });

  it('wires blocked-apply user-draft starvation to the clearable terminal composer event', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: { consecutiveBlockedApplies: number; blockedReason?: string | null }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'user_draft',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await vi.waitFor(() => {
      const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
        .map(([event]) => event as { type?: string; reason?: string })
        .filter((event) => event.type === 'terminal-composer-draft-blocked');
      expect(draftBlockedEvents).toEqual([
        expect.objectContaining({
          type: 'terminal-composer-draft-blocked',
          reason: 'idle_draft_guard',
        }),
      ]);
    });
    expect(session.client.updateAgentState).toHaveBeenCalledWith(expect.any(Function));
    const published = vi.mocked(session.client.updateAgentState).mock.calls
      .map(([updater]) => updater({ capabilities: {} } as never) as { capabilities?: Record<string, unknown> });
    expect(published.some((state) =>
      state.capabilities?.terminalComposerDraftPresent === true
      && state.capabilities?.terminalComposerClearSupported === true
    )).toBe(true);
  });

  it('blocks a pending row for sustained runtime-config blockers without a duplicate composer event', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: {
          consecutiveBlockedApplies: number;
          blockedReason?: string | null;
          userMessageLocalIds?: readonly string[];
        }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'user_draft',
        userMessageLocalIds: ['pending-local-runtime-config'],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
        localIds: ['pending-local-runtime-config'],
        reason: 'runtime_config_blocked',
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([]);
  });

  it('keeps active-turn runtime-config user-draft starvation transient', async () => {
    setProcessTty(false);
    const session = createSession();
    const hasActiveCanonicalTurn = session.client.hasActiveCanonicalTurn;
    if (!hasActiveCanonicalTurn) {
      throw new Error('test fixture missing hasActiveCanonicalTurn');
    }
    vi.mocked(hasActiveCanonicalTurn).mockReturnValue(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: {
          consecutiveBlockedApplies: number;
          blockedReason?: string | null;
          userMessageLocalIds?: readonly string[];
          isCanonicalTurnActive?: boolean;
        }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'user_draft',
        userMessageLocalIds: ['active-runtime-config-local'],
        isCanonicalTurnActive: true,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string; reason?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([
      expect.objectContaining({ reason: 'idle_draft_guard' }),
    ]);
  });

  it('wires idle draft-guard starvation honesty: escalation surfaces ONE user-visible session message', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'foreign_draft';
        originKind: 'ui_pending';
        draftLength: number;
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'foreign_draft',
        originKind: 'ui_pending',
        draftLength: 32,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await vi.waitFor(() => {
      const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
        .map(([event]) => event as { type?: string; reason?: string; message?: string })
        .filter((event) => event.type === 'terminal-composer-draft-blocked');
      expect(draftBlockedEvents).toEqual([expect.objectContaining({
        reason: 'idle_draft_guard',
        message: expect.stringContaining('terminal composer'),
      })]);
    });
    expect(session.client.updateAgentState).toHaveBeenCalledWith(expect.any(Function));
    const published = vi.mocked(session.client.updateAgentState).mock.calls
      .map(([updater]) => updater({ capabilities: {} } as never) as { capabilities?: Record<string, unknown> });
    expect(published.some((state) =>
      state.capabilities?.terminalComposerClearSupported === true
      && state.capabilities?.terminalComposerDraftPresent === true
    )).toBe(true);
  });

  it('blocks a pending row for sustained foreign-draft guard blockers without a duplicate composer event', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'foreign_draft';
        originKind: 'ui_pending';
        draftLength: number;
        userMessageLocalIds?: readonly string[];
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'foreign_draft',
        originKind: 'ui_pending',
        draftLength: 32,
        userMessageLocalIds: ['pending-local-foreign-draft'],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
        localIds: ['pending-local-foreign-draft'],
        reason: 'terminal_composer_draft',
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([]);
  });

  it('durably blocks a pending row when a recognized dialog starves idle injection', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'blocked_non_input_state';
        blockedReason: string;
        originKind: 'ui_pending';
        userMessageLocalIds?: readonly string[];
        isCanonicalTurnActive?: boolean;
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'blocked_non_input_state',
        blockedReason: 'safeguard_pause_dialog',
        originKind: 'ui_pending',
        userMessageLocalIds: ['pending-local-dialog'],
        isCanonicalTurnActive: false,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.blockPendingMessageDelivery).toHaveBeenCalledWith({
        localIds: ['pending-local-dialog'],
        reason: 'runtime_config_blocked',
      });
    });
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([]);
  });

  it('keeps active-turn draft-guard starvation transient until turn end', async () => {
    setProcessTty(false);
    const session = createSession();
    const hasActiveCanonicalTurn = session.client.hasActiveCanonicalTurn;
    if (!hasActiveCanonicalTurn) {
      throw new Error('test fixture missing hasActiveCanonicalTurn');
    }
    vi.mocked(hasActiveCanonicalTurn).mockReturnValue(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'foreign_draft';
        originKind: 'ui_pending';
        draftLength: number;
        userMessageLocalIds?: readonly string[];
        isCanonicalTurnActive?: boolean;
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'foreign_draft',
        originKind: 'ui_pending',
        draftLength: 32,
        userMessageLocalIds: ['active-turn-draft-local'],
        isCanonicalTurnActive: true,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string; reason?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([
      expect.objectContaining({ reason: 'idle_draft_guard' }),
    ]);
  });

  it.each([
    'capture_style_unavailable',
    'clear_failed',
  ] as const)('keeps %s draft-guard starvation transient even while idle', async (guardStatus) => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: typeof guardStatus;
        originKind: 'ui_pending';
        draftLength: number;
        userMessageLocalIds?: readonly string[];
        isCanonicalTurnActive?: boolean;
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus,
        originKind: 'ui_pending',
        draftLength: 32,
        userMessageLocalIds: [`${guardStatus}-local`],
        isCanonicalTurnActive: false,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string; reason?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([
      expect.objectContaining({ reason: 'idle_draft_guard' }),
    ]);
  });

  it('wakes the shared pending-materialization owner without retrying rows when the draft guard clears', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'foreign_draft';
        originKind: 'ui_pending';
        draftLength: number;
        userMessageLocalIds?: readonly string[];
        isCanonicalTurnActive?: boolean;
      }) => void;
      onDraftGuardClear?: () => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'foreign_draft',
        originKind: 'ui_pending',
        draftLength: 32,
        userMessageLocalIds: ['retry-draft-local'],
        isCanonicalTurnActive: false,
      });
      await Promise.resolve();
      opts.onDraftGuardClear?.();
      opts.onDraftGuardClear?.();
      await vi.waitFor(() => {
        expect(session.client.wakePendingMaterialization).toHaveBeenCalledTimes(2);
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

  });

  it('wakes the shared pending-materialization owner without retrying rows when runtime config clears', async () => {
    setProcessTty(false);
    const session = createSession();
    const blockPendingMessageDelivery = session.client.blockPendingMessageDelivery;
    if (!blockPendingMessageDelivery) {
      throw new Error('test fixture missing blockPendingMessageDelivery');
    }
    vi.mocked(blockPendingMessageDelivery).mockResolvedValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: {
          consecutiveBlockedApplies: number;
          blockedReason?: string | null;
          userMessageLocalIds?: readonly string[];
          isCanonicalTurnActive?: boolean;
        }) => void;
        onBlockedApplyClear?: () => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'user_draft',
        userMessageLocalIds: ['retry-runtime-config-local'],
        isCanonicalTurnActive: false,
      });
      await Promise.resolve();
      opts.tuiRuntimeControl?.onBlockedApplyClear?.();
      opts.tuiRuntimeControl?.onBlockedApplyClear?.();
      await vi.waitFor(() => {
        expect(session.client.wakePendingMaterialization).toHaveBeenCalledTimes(2);
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

  });

  it('applies metadata-only permission changes through the standalone unified runtime-control bridge', async () => {
    setProcessTty(false);
    const session = createSession();
    const applyMode = vi.fn(async () => ({ promptMayProceed: true, attempted: true } as const));
    let queueReady = true;
    vi.mocked(session.client.getMetadataSnapshot).mockReturnValue({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 25,
    } as never);
    vi.mocked(session.queue.size).mockImplementation(() => queueReady ? 1 : 0);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueReady = false;
      return {
        message: 'after metadata',
        mode: {
          permissionMode: 'yolo',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        },
        isolate: false,
        hash: 'mode-yolo',
        maxUserMessageSeq: 25,
        userMessageLocalIds: ['pending-after-metadata'],
      };
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{ message: string } | null>;
      tuiRuntimeControl?: {
        registerMetadataRuntimeModeApplier?: (
          apply: (mode: Record<string, unknown>) => Promise<{ promptMayProceed: boolean; attempted: boolean }>,
        ) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.registerMetadataRuntimeModeApplier?.(applyMode);
      await opts.nextMessage();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(applyMode).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      claudeUnifiedTerminalEnabled: true,
    }));
  });

  it('does not block pending delivery when a metadata-only permission change is runtime-control blocked', async () => {
    setProcessTty(false);
    const session = createSession();
    let queueReady = true;
    const applyMode = vi.fn(async () => {
      return {
        promptMayProceed: false,
        attempted: true,
        blockedReason: 'user_draft',
      } as const;
    });
    vi.mocked(session.client.getMetadataSnapshot).mockReturnValue({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 25,
    } as never);
    vi.mocked(session.queue.size).mockImplementation(() => queueReady ? 1 : 0);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementationOnce(async () => {
      queueReady = false;
      return {
        message: 'after blocked metadata apply',
        mode: {
          permissionMode: 'yolo',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        },
        hash: 'mode-yolo-blocked',
        maxUserMessageSeq: 26,
        userMessageLocalIds: ['pending-after-blocked-metadata'],
      } as never;
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{ message: string } | null>;
      tuiRuntimeControl?: {
        registerMetadataRuntimeModeApplier?: (
          apply: (mode: Record<string, unknown>) => Promise<{ promptMayProceed: boolean; attempted: boolean }>,
        ) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.registerMetadataRuntimeModeApplier?.(applyMode);
      await opts.nextMessage();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(applyMode).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      claudeUnifiedTerminalEnabled: true,
    }));
    expect(session.client.blockPendingMessageDelivery).not.toHaveBeenCalled();
  });

  // QA-B B6 (live 2026-06-12, session cmqawdqzj): gate OFF dropped a permission-mode change
  // between turns SILENTLY (no requires_restart notice, prompt ran under the stale mode). The
  // standalone launcher must surface the same legacy notices as the daemon launcher.
  it('gate OFF: surfaces the legacy requires_restart notice when a batch mode changes (B6)', async () => {
    setProcessTty(false);
    const previousGateEnv = process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
    process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = '0';
    try {
      const session = createSession();
      let queueSize = 2;
      vi.mocked(session.queue.size).mockImplementation(() => queueSize);
      mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
        nextMessage: () => Promise<{ message: string; mode: Record<string, unknown> } | null>;
        tuiRuntimeControl?: { featureEnabled: boolean };
      }) => {
        expect(opts.tuiRuntimeControl?.featureEnabled).toBe(false);
        await opts.nextMessage();
        await opts.nextMessage();
      });
      vi.mocked(session.queue.waitForMessagesAndGetAsString)
        .mockImplementationOnce(async () => {
          queueSize -= 1;
          return { message: 'first', mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true }, isolate: false, hash: 'h1', maxUserMessageSeq: null, userMessageLocalIds: ['pending-first-mode'] };
        })
        .mockImplementationOnce(async () => {
          queueSize -= 1;
          return { message: 'second', mode: { permissionMode: 'plan', claudeUnifiedTerminalEnabled: true }, isolate: false, hash: 'h2', maxUserMessageSeq: null, userMessageLocalIds: ['pending-second-mode'] };
        });

      await claudeUnifiedTerminalLauncher(session, {});

      const events = vi.mocked(session.client.sendSessionEvent).mock.calls.map(([event]) => event as Record<string, unknown>);
      const messageEvents = events.filter((event) => event.type === 'message');
      expect(messageEvents.some((event) => String(event.message).includes('apply when Claude restarts'))).toBe(true);
      const outcomeEvents = events.filter((event) => event.type !== 'message');
      expect(JSON.stringify(outcomeEvents)).toContain('requires_restart');
    } finally {
      if (previousGateEnv === undefined) delete process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
      else process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = previousGateEnv;
    }
  });

  // RULING-14. This launcher's teardown IS the observation that the Claude process is gone, so a
  // workflow run and its agents that were still live at that moment must be resolved — otherwise the
  // roster paints them "Working" forever. The remote launcher already did this; this one only
  // drained, which is why the fix was live on one launcher out of three.
  it('resolves live workflow runs and agents when the provider dies (RULING-14)', async () => {
    setProcessTty(false);
    const lifecycle: string[] = [];
    mocks.createClaudeWorkflowActivitySourceForSession.mockResolvedValueOnce({
      observeTranscriptMessage: vi.fn(),
      getWorkflowOwnedAgentToolUseIds: vi.fn(() => new Set<string>()),
      isWorkflowOwnedProviderTaskId: vi.fn(() => false),
      isWorkflowOwnedTaskReference: vi.fn(() => false),
      finalizeInterruptedActivityOnShutdown: vi.fn(() => { lifecycle.push('finalize'); }),
      flush: vi.fn(async () => { lifecycle.push('flush'); }),
      reconcileStartupInterruptedRuns: vi.fn(async () => {}),
      armStartupReconciliation: vi.fn(),
      dispose: vi.fn(() => { lifecycle.push('dispose'); }),
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async () => {});

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
    });

    // Resolve BEFORE the drain, or the durable write carries the still-live state.
    expect(lifecycle).toEqual(['finalize', 'flush', 'dispose']);
  });

  // A background shell is the one kind nothing ever finalizes, and it is also the one kind that can
  // OUTLIVE its parent — so it may only be resolved when the kill was ours and we watched it. The
  // explicit-stop path destroys the terminal host the shell lives in, which is that observation.
  // Every other way out of this launcher (a provider crash, a runtime issue, a plain exit that
  // leaves the detached host running) is NOT, and must leave the record alone.
  it('resolves background-task records only when it destroyed the host for an explicit stop', async () => {
    setProcessTty(false);
    const terminal = {
      mode: 'tmux',
      tmux: { target: 'happy:unified-window' },
    } as NonNullable<TerminalAttachmentInfo['terminal']>;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };

    const runLauncher = async (explicitStop: boolean): Promise<string[]> => {
      const lifecycle: string[] = [];
      // The wrapper the launcher hands UP to its caller — the one `requestClaudeExplicitRunnerStop`
      // actually invokes on a user stop.
      let forwardedDestroyOwnedHost: (() => Promise<void>) | null = null;
      mocks.createClaudeWorkflowActivitySourceForSession.mockResolvedValueOnce({
        observeTranscriptMessage: vi.fn(),
        getWorkflowOwnedAgentToolUseIds: vi.fn(() => new Set<string>()),
        isWorkflowOwnedProviderTaskId: vi.fn(() => false),
        isWorkflowOwnedTaskReference: vi.fn(() => false),
        finalizeInterruptedActivityOnShutdown: vi.fn(),
        finalizeBackgroundTaskRecordsOnOrderlyStop: vi.fn(() => { lifecycle.push('finalize-background'); }),
        flush: vi.fn(async () => { lifecycle.push('flush'); }),
        reconcileStartupInterruptedRuns: vi.fn(async () => {}),
        armStartupReconciliation: vi.fn(),
        dispose: vi.fn(),
      });
      mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
        onTerminalHostReady?: (params: Readonly<{
          handle: TerminalHostHandle;
          terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
          destroyOwnedHostForExplicitStop: () => Promise<void>;
        }>) => void | Promise<void>;
      }) => {
        await opts.onTerminalHostReady?.({
          handle,
          terminal,
          destroyOwnedHostForExplicitStop: async () => { lifecycle.push('destroy-host'); },
        });
        if (explicitStop) await forwardedDestroyOwnedHost?.();
      });

      await claudeUnifiedTerminalLauncher(createSession(), {
        initialMode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
        onTerminalHostReady: ({ destroyOwnedHostForExplicitStop }) => {
          forwardedDestroyOwnedHost = destroyOwnedHostForExplicitStop;
        },
      });
      return lifecycle;
    };

    // Explicit stop: we destroyed the host, so the shells inside it died with it — a recorded
    // observation, and the resolution must land BEFORE the drain that writes it.
    expect(await runLauncher(true)).toEqual(['destroy-host', 'finalize-background', 'flush']);
    // Same teardown, no explicit stop: the detached host may still be running the shell. Silence.
    expect(await runLauncher(false)).toEqual(['flush']);
  });

  // INV-R C-1. Workflow-agent transcript import was built in wave 23 and wired on exactly ONE
  // launcher — the remote one. This runtime is the one the reporting user actually runs, so the
  // whole vertical was dormant here: no registrar reached the journal follower, no sidechain id was
  // ever minted, and zero workflow-agent rows could open. Bind it to the SAME importer that already
  // owns `Task` sub-agent transcripts (one follower budget, one dedupe, one marking rule), through
  // the same late holder the remote launcher uses — and keep wave 25's fail-closed rule: with no
  // importer the registration must FAIL so the follower withholds the id, never silently no-op.
  it('registers workflow-agent sidecars with the session sidechain importer, fail-closed (INV-R C-1)', async () => {
    setProcessTty(false);
    let publishImporter: ((collector: unknown) => void) | null = null;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onSubagentFileCollectorChanged?: (collector: unknown) => void;
    }) => {
      publishImporter = opts.onSubagentFileCollectorChanged ?? null;
    });

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
    });

    const sourceParams = mocks.createClaudeWorkflowActivitySourceForSession.mock.calls.at(-1)?.[0] as
      | Readonly<{
        registerWorkflowAgentTranscript?: (registration: Readonly<{
          sidechainId: string;
          agentId: string;
          filePath: string;
        }>) => Promise<void>;
      }>
      | undefined;
    const register = sourceParams?.registerWorkflowAgentTranscript;
    if (typeof register !== 'function') {
      throw new Error('unified launcher did not hand the workflow source a transcript registrar');
    }
    const registration = {
      sidechainId: 'workflow_agent_sidechain:toolu_1:agent-a',
      agentId: 'agent-a',
      filePath: '/tmp/wf/agent-agent-a.jsonl',
    };

    // No importer yet (the runtime never reached transcript observation): claim nothing.
    await expect(register(registration)).rejects.toThrow(/no sidechain importer/i);

    const registerSidechainFile = vi.fn(async () => {});
    const publish = publishImporter as unknown as ((collector: unknown) => void) | null;
    if (!publish) {
      throw new Error('unified launcher did not subscribe to the session sidechain importer');
    }
    publish({ registerSidechainFile });
    await register(registration);
    expect(registerSidechainFile).toHaveBeenCalledWith({
      ...registration,
      source: 'workflow-agent',
    });

    // The importer dies with its scanner; a later journal entry must not attach a follower to it.
    publish(null);
    await expect(register(registration)).rejects.toThrow(/no sidechain importer/i);
  });
});
