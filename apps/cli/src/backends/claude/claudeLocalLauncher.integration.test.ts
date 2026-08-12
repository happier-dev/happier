import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { Session } from './session';
import { EventEmitter } from 'node:events';
import type { EnhancedMode } from './loop';

vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: vi.fn(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:1234', stop: vi.fn() },
    mcpServers: {
      happier: {
        command: 'node',
        args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'],
      },
    },
  })),
}));

type MetadataSnapshot = { permissionMode?: PermissionMode; permissionModeUpdatedAt?: number };
type RpcHandler = (params?: unknown) => unknown | Promise<unknown>;
type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;
type LocalLaunchOptions = Parameters<(typeof import('./claudeLocal'))['claudeLocal']>[0];
type SessionScannerOptions = Parameters<(typeof import('./utils/sessionScanner'))['createSessionScanner']>[0];
type SessionScannerResult = Awaited<ReturnType<(typeof import('./utils/sessionScanner'))['createSessionScanner']>>;

let readlineAnswer = 'n';
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(readlineAnswer),
    close: () => {},
  }),
}));

const mockClaudeLocal = vi.fn<(opts: LocalLaunchOptions) => Promise<void>>();
vi.mock('./claudeLocal', () => ({
  claudeLocal: mockClaudeLocal,
  ExitCodeError: class ExitCodeError extends Error {
    exitCode: number;
    constructor(exitCode: number) {
      super(`ExitCodeError(${exitCode})`);
      this.exitCode = exitCode;
    }
  },
}));

const mockCreateSessionScanner = vi.fn<(opts: SessionScannerOptions) => Promise<SessionScannerResult>>();
vi.mock('./utils/sessionScanner', () => ({
  createSessionScanner: mockCreateSessionScanner,
}));

const mockCreateClaudeWorkflowActivitySourceForSession = vi.fn();
vi.mock('./workflows/createClaudeWorkflowActivitySourceForSession', () => ({
  createClaudeWorkflowActivitySourceForSession: mockCreateClaudeWorkflowActivitySourceForSession,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon', () => ({
  reportConnectedServiceRuntimeAuthFailureToDaemon: vi.fn(async () => {}),
}));

// Transform the launcher dependency graph during test-file collection so the
// first case's timeout measures launcher behavior rather than Vite compilation.
await import('./claudeLocalLauncher');

type SessionClientStub = EventEmitter &
  SessionClientPort & {
    getMetadataSnapshot?: () => MetadataSnapshot;
  };

type LocalHarness = {
  session: Session;
  client: SessionClientStub;
  sendSessionEvent: ReturnType<typeof vi.fn>;
  switchHandlerReady: Promise<RpcHandler>;
  abortHandlerReady: Promise<RpcHandler>;
};

const createdSessions: Session[] = [];
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

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

function restoreTTY(stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutIsTTY, configurable: true });
}

function createSessionScannerStub(
  subagentFileCollector: SessionScannerResult['subagentFileCollector'] = createSidechainImporterStub().collector,
): SessionScannerResult {
  return {
    cleanup: vi.fn(async () => {}),
    onNewSession: vi.fn(),
    subagentFileCollector,
  };
}

/**
 * The scanner's ONE sidechain importer, reduced to the single method a workflow-agent registration
 * uses. Everything past registration (follow, dedupe, mark, emit) is the collector's own tested
 * path; what matters here is that the launcher hands registrations to THIS object and to no other.
 */
function createSidechainImporterStub(): {
  collector: SessionScannerResult['subagentFileCollector'];
  registerSidechainFile: ReturnType<typeof vi.fn>;
} {
  const registerSidechainFile = vi.fn(async () => {});
  return {
    collector: { registerSidechainFile } as unknown as SessionScannerResult['subagentFileCollector'],
    registerSidechainFile,
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function hookWithTranscript(transcriptPath: string): SessionFoundHookData {
  return { transcript_path: transcriptPath };
}

function createLocalHarness(options?: {
  metadataSnapshot?: MetadataSnapshot;
  providerTasks?: NonNullable<ConstructorParameters<typeof Session>[0]['runtimeActivityContributions']>['providerTasks'];
}): LocalHarness {
  const switchDeferred = createDeferred<RpcHandler>();
  const abortDeferred = createDeferred<RpcHandler>();
  const sendSessionEvent = vi.fn();

  const client = Object.assign(new EventEmitter(), {
    sessionId: 'happy_sess_1',
    keepAlive: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    sessionTurnLifecycle: {
      failTurn: vi.fn(async () => {}),
    },
    getMetadataSnapshot: options?.metadataSnapshot ? vi.fn(() => options.metadataSnapshot) : undefined,
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: RpcHandler) => {
        if (method === 'switch') {
          switchDeferred.resolve(handler);
        }
        if (method === 'abort') {
          abortDeferred.resolve(handler);
        }
      }),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendClaudeSessionMessage: vi.fn(),
    sendClaudeSessionMessageCommitted: vi.fn(async () => ({
      persisted: true,
      delivered: true,
    })),
    fetchCommittedClaudeJsonlMessageBaseline: vi.fn(async () => ({
      keys: new Set<string>(),
      complete: true,
      oldestCoveredAtMs: null,
    })),
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    sendSessionEvent,
    peekPendingMessageQueueV2Count: vi.fn().mockResolvedValue(0),
    discardPendingMessageQueueV2All: vi.fn().mockResolvedValue(0),
    discardCommittedMessageLocalIds: vi.fn().mockResolvedValue(0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }) as unknown as SessionClientStub;

  const session = new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
    runtimeActivityContributions: options?.providerTasks
      ? { providerTasks: options.providerTasks }
      : undefined,
  });
  createdSessions.push(session);

  return {
    session,
    client,
    sendSessionEvent,
    switchHandlerReady: switchDeferred.promise,
    abortHandlerReady: abortDeferred.promise,
  };
}

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('claudeLocalLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeLocal.mockReset();
    mockCreateSessionScanner.mockReset();
    readlineAnswer = 'n';
    mockClaudeLocal.mockResolvedValue(undefined);
    mockCreateSessionScanner.mockResolvedValue(createSessionScannerStub());
    mockCreateClaudeWorkflowActivitySourceForSession.mockReset();
    mockCreateClaudeWorkflowActivitySourceForSession.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreTTY(originalStdinIsTTY, originalStdoutIsTTY);
    for (const session of createdSessions.splice(0)) {
      session.cleanup();
    }
  });

  it('surfaces Claude process errors to the UI', async () => {
    const { session, sendSessionEvent } = createLocalHarness();

    mockClaudeLocal
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toEqual({ type: 'exit', code: 0 });
    expect(sendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.any(String),
      }),
    );
  });

  it('offers Runtime Activity only after the local transcript observer installs', async () => {
    const order: string[] = [];
    const providerTasks = {
      report: vi.fn(async () => { order.push('runtime-offered'); }),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const { session } = createLocalHarness({ providerTasks });
    mockCreateSessionScanner.mockImplementationOnce(async () => {
      order.push('scanner-installed');
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async () => {
      order.push('provider-started');
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await claudeLocalLauncher(session);

    expect(order).toEqual(['scanner-installed', 'runtime-offered', 'provider-started']);
    expect(providerTasks.report).toHaveBeenCalledWith(
      { state: 'idle', activeCount: 0 },
      'claude-local-provider-observer-installed',
    );
  });

  it('configures local resume scanning to backfill only uncommitted Claude rows before provider startup', async () => {
    const order: string[] = [];
    const { session, client } = createLocalHarness();
    session.sessionId = 'claude-resume-session';
    session.transcriptPath = '/tmp/claude-resume-session.jsonl';
    client.fetchCommittedClaudeJsonlMessageBaseline = vi.fn(async () => {
      order.push('baseline-loaded');
      return {
        keys: new Set(['main:assistant:already-committed']),
        complete: true,
        oldestCoveredAtMs: null,
      };
    });
    mockCreateSessionScanner.mockImplementationOnce(async (options) => {
      order.push('scanner-installed');
      expect(options.replayInitialMessages).toBe(true);
      expect(Array.from(options.initialProcessedMessageKeys ?? [])).toEqual([
        'main:assistant:already-committed',
      ]);
      expect(options.replaySuppressRowsBeforeMs).toBeNull();
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async () => {
      order.push('provider-started');
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await claudeLocalLauncher(session);

    expect(order).toEqual(['baseline-loaded', 'scanner-installed', 'provider-started']);
  });

  it('arms workflow startup reconciliation only after the local transcript observer installs', async () => {
    const order: string[] = [];
    mockCreateClaudeWorkflowActivitySourceForSession.mockResolvedValueOnce({
      armStartupReconciliation: vi.fn(() => { order.push('workflow-armed'); }),
      observeTranscriptMessage: vi.fn(),
      getWorkflowOwnedAgentToolUseIds: vi.fn(() => new Set<string>()),
      isWorkflowOwnedProviderTaskId: vi.fn(() => false),
      isWorkflowOwnedTaskReference: vi.fn(() => false),
      flush: vi.fn(async () => {}),
      reconcileStartupInterruptedRuns: vi.fn(async () => {}),
      dispose: vi.fn(),
    });
    const { session } = createLocalHarness();
    mockCreateSessionScanner.mockImplementationOnce(async () => {
      order.push('scanner-installed');
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async () => {
      order.push('provider-started');
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await claudeLocalLauncher(session);

    expect(order).toEqual(['scanner-installed', 'workflow-armed', 'provider-started']);
  });

  // RULING-14. Returning from `claudeLocal` IS the observation that the provider process is gone, so
  // every workflow run and agent still live at that moment must be resolved before the drain —
  // otherwise the roster paints them "Working" forever. Only the remote launcher used to do this.
  it('resolves live workflow runs and agents when the local provider dies (RULING-14)', async () => {
    const lifecycle: string[] = [];
    mockCreateClaudeWorkflowActivitySourceForSession.mockResolvedValueOnce({
      armStartupReconciliation: vi.fn(),
      observeTranscriptMessage: vi.fn(),
      getWorkflowOwnedAgentToolUseIds: vi.fn(() => new Set<string>()),
      isWorkflowOwnedProviderTaskId: vi.fn(() => false),
      isWorkflowOwnedTaskReference: vi.fn(() => false),
      finalizeInterruptedActivityOnShutdown: vi.fn(() => { lifecycle.push('finalize'); }),
      flush: vi.fn(async () => { lifecycle.push('flush'); }),
      reconcileStartupInterruptedRuns: vi.fn(async () => {}),
      dispose: vi.fn(() => { lifecycle.push('dispose'); }),
    });
    const { session } = createLocalHarness();
    mockCreateSessionScanner.mockImplementationOnce(async () => createSessionScannerStub());
    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await claudeLocalLauncher(session);

    // Resolve BEFORE the drain, or the durable write carries the still-live state.
    expect(lifecycle).toEqual(['finalize', 'flush', 'dispose']);
  });

  it('does not offer Runtime Activity or start Claude when local observer installation rejects', async () => {
    const providerTasks = {
      report: vi.fn(async () => {}),
      markUnknown: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const { session } = createLocalHarness({ providerTasks });
    mockCreateSessionScanner.mockRejectedValueOnce(new Error('scanner install failed'));

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await expect(claudeLocalLauncher(session)).rejects.toThrow('scanner install failed');

    expect(providerTasks.report).not.toHaveBeenCalled();
    expect(providerTasks.markUnknown).not.toHaveBeenCalled();
    expect(mockClaudeLocal).not.toHaveBeenCalled();
  });

  it('seeds the local Claude spawn permission mode from session metadata before the first launch', async () => {
    const { session } = createLocalHarness({
      metadataSnapshot: {
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 123,
      },
    });

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      expect(opts.claudeArgs).toEqual(['--permission-mode', 'bypassPermissions']);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('preserves CLI bypass-permissions intent on the first local launch before metadata catches up', async () => {
    const { session } = createLocalHarness();
    session.claudeArgs = ['--dangerously-skip-permissions'];

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      expect(opts.claudeArgs).toEqual(['--permission-mode', 'bypassPermissions']);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('does not block initial local startup on pending-queue inspection', async () => {
    const { session, client } = createLocalHarness();

    client.peekPendingMessageQueueV2Count = vi.fn(async () => {
      throw new Error('pending queue inspection should not run for initial local startup');
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    mockClaudeLocal.mockImplementationOnce(async () => {});

    const result = await claudeLocalLauncher(session);
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('does not pass a strict allowedTools allowlist to local Claude spawns by default', async () => {
    const { session } = createLocalHarness();

    const captured: { current: LocalLaunchOptions | null } = { current: null };
    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      captured.current = opts;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
    expect(captured.current ? 'allowedTools' in captured.current : true).toBe(false);
    expect(typeof captured.current?.happierMcpConfigJson).toBe('string');
    const parsed = JSON.parse(String(captured.current?.happierMcpConfigJson ?? 'null'));
    expect(parsed?.mcpServers?.happier).toBeTruthy();
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('routes fd3 lifecycle fallback telemetry through the safe CLI logger', async () => {
    const { session } = createLocalHarness();

    const captured: { current: LocalLaunchOptions | null } = { current: null };
    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      captured.current = opts;
    });

    const { logger } = await import('@/ui/logger');
    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toEqual({ type: 'exit', code: 0 });
    const capturedOptions = captured.current;
    if (!capturedOptions) throw new Error('Expected Claude local launch options to be captured');
    expect(typeof capturedOptions.onLifecycleGapDetected).toBe('function');

    capturedOptions.onLifecycleGapDetected?.({
      source: 'fd3_fetch_fallback',
      signal: 'fetch_start',
      activeFetchCount: 1,
    });

    expect(logger.debug).toHaveBeenCalledWith('[claude-unified-telemetry]', {
      activeFetchCount: 1,
      event: 'unified.lifecycle.gap_detected',
      signal: 'fetch_start',
      source: 'fd3_fetch_fallback',
    });
  });

  it('passes through user --mcp-config args and does not parse/merge them into happierMcpConfigJson', async () => {
    const { session } = createLocalHarness();

    const userMcpConfig = JSON.stringify({
      mcpServers: {
        custom: { type: 'http', url: 'http://127.0.0.1:9999' },
      },
    });
    session.claudeArgs = ['--mcp-config', userMcpConfig, '--max-turns', '3'];

    let captured: LocalLaunchOptions | null = null;
    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      captured = opts;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
    expect((captured as any)?.claudeArgs).toEqual(['--mcp-config', userMcpConfig, '--max-turns', '3']);

    const parsed = JSON.parse(String((captured as any)?.happierMcpConfigJson ?? 'null'));
    expect(parsed?.mcpServers?.happier).toBeTruthy();
    expect(parsed?.mcpServers?.custom).toBeUndefined();
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('inspects the pending queue when entering local mode from a remote switch', async () => {
    const { session, client } = createLocalHarness();

    const peek = vi.fn().mockResolvedValue(0);
    client.peekPendingMessageQueueV2Count = peek;

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session, { entry: 'switch' });

    expect(peek).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ type: 'exit', code: 0 });
  });

  it('arms the pending-queue watcher only after the remote→local discard gate completes', async () => {
    vi.useFakeTimers();
    const { session, client } = createLocalHarness();
    const discardDeferred = createDeferred<number>();
    let pendingCount = 1;

    const previousE2e = process.env.HAPPIER_E2E_PROVIDERS;
    process.env.HAPPIER_E2E_PROVIDERS = '1';

    client.peekPendingMessageQueueV2Count = vi.fn(async () => pendingCount);
    client.discardPendingMessageQueueV2All = vi.fn(async () => {
      const discarded = await discardDeferred.promise;
      pendingCount = 0;
      return discarded;
    });

    mockClaudeLocal.mockImplementationOnce(async () => {});

    try {
      const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
      const launcherPromise = claudeLocalLauncher(session, { entry: 'switch' });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(client.peekPendingMessageQueueV2Count).toHaveBeenCalledTimes(1);
      expect(mockClaudeLocal).not.toHaveBeenCalled();

      discardDeferred.resolve(1);
      await vi.advanceTimersByTimeAsync(0);

      await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });
      expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
      expect(client.discardPendingMessageQueueV2All).toHaveBeenCalledTimes(1);
    } finally {
      process.env.HAPPIER_E2E_PROVIDERS = previousE2e;
      vi.useRealTimers();
    }
  });

  it('adopts permission mode metadata updates during local mode for future spawns', async () => {
    const metadataSnapshot: MetadataSnapshot = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    };
    const { session, client, abortHandlerReady } = createLocalHarness({ metadataSnapshot });
    const localStarted = createDeferred<void>();

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    expect(mockClaudeLocal).toHaveBeenCalledTimes(1);

    metadataSnapshot.permissionMode = 'safe-yolo';
    metadataSnapshot.permissionModeUpdatedAt = 2;
    client.emit('metadata-updated');

    expect(session.lastPermissionMode).toBe('safe-yolo');

    session.sessionId = 'sid1';
    session.transcriptPath = '/tmp/claude.jsonl';
    const abortHandler = await abortHandlerReady;
    await abortHandler();

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
  });

  it('defers UI-triggered remote switch until the active local Claude turn settles', async () => {
    vi.useFakeTimers();
    const { session } = createLocalHarness();
    let scannerOptions: SessionScannerOptions | null = null;
    let abortObserved = false;
    const localStarted = createDeferred<void>();

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
      scannerOptions = opts;
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
      abortObserved = true;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    expect(scannerOptions).not.toBeNull();
    session.onSessionFound('sid1', hookWithTranscript('/tmp/sid1.jsonl'));

    scannerOptions!.onMessage({
      type: 'user',
      uuid: 'user_prompt_1',
      message: { content: 'do work' },
    } as any);

    session.queue.push('queued from ui', defaultMode);
    await Promise.resolve();
    expect(abortObserved).toBe(false);

    scannerOptions!.onMessage({
      type: 'assistant',
      uuid: 'assistant_draft',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'draft' }],
        stop_reason: 'end_turn',
      },
    } as any);
    await vi.advanceTimersByTimeAsync(250);
    scannerOptions!.onMessage({
      type: 'user',
      uuid: 'stop_feedback',
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Stop hook feedback:\nPlease finish.' }],
      },
    } as any);
    await vi.advanceTimersByTimeAsync(500);
    expect(abortObserved).toBe(false);

    scannerOptions!.onMessage({
      type: 'assistant',
      uuid: 'assistant_final',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    } as any);
    await vi.advanceTimersByTimeAsync(500);

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
    expect(abortObserved).toBe(true);
  });

  it('propagates hook-driven local lifecycle to ACP turn markers and ready events', async () => {
    vi.useFakeTimers();
    const { session, client, sendSessionEvent } = createLocalHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();

    mockClaudeLocal.mockImplementationOnce(async () => {
      localStarted.resolve(undefined);
      await releaseLocal.promise;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'UserPromptSubmit' });
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(500);

    releaseLocal.resolve(undefined);
    await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });

    const agentTypes = (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]?.type);
    expect(agentTypes).toEqual(expect.arrayContaining(['task_started', 'task_complete']));
    expect(sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('ignores fd3 idle-clear fallback while hook-driven lifecycle is active', async () => {
    vi.useFakeTimers();
    const { session, client } = createLocalHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();
    const capturedOptions: { current: LocalLaunchOptions | null } = { current: null };

    mockClaudeLocal.mockImplementationOnce(async (opts) => {
      capturedOptions.current = opts;
      localStarted.resolve(undefined);
      await releaseLocal.promise;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'UserPromptSubmit' });
    capturedOptions.current?.onThinkingChange?.(false);

    let agentTypes = (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]?.type);
    expect(agentTypes).toContain('task_started');
    expect(agentTypes).not.toContain('task_complete');

    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(500);
    releaseLocal.resolve(undefined);
    await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });

    agentTypes = (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]?.type);
    expect(agentTypes.filter((type) => type === 'task_complete')).toHaveLength(1);
  });

  it('ignores fd3 busy fallback after the hook-driven foreground turn has completed', async () => {
    vi.useFakeTimers();
    const { session, client } = createLocalHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();
    const capturedOptions: { current: LocalLaunchOptions | null } = { current: null };

    mockClaudeLocal.mockImplementationOnce(async (opts) => {
      capturedOptions.current = opts;
      localStarted.resolve(undefined);
      await releaseLocal.promise;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'UserPromptSubmit' });
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'Stop' });
    await vi.advanceTimersByTimeAsync(500);

    const beforeFd3BusyFallback = (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1]?.type);
    expect(beforeFd3BusyFallback.filter((type) => type === 'task_started')).toHaveLength(1);
    expect(beforeFd3BusyFallback.filter((type) => type === 'task_complete')).toHaveLength(1);

    capturedOptions.current?.onThinkingChange?.(true);

    const afterFd3BusyFallback = (client.sendAgentMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1]?.type);
    expect(afterFd3BusyFallback.filter((type) => type === 'task_started')).toHaveLength(1);
    expect(afterFd3BusyFallback.filter((type) => type === 'task_complete')).toHaveLength(1);

    releaseLocal.resolve(undefined);
    await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });
  });

  it('surfaces local StopFailure rate-limit hooks as runtime issues', async () => {
    const { session, client } = createLocalHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();

    mockClaudeLocal.mockImplementationOnce(async () => {
      localStarted.resolve(undefined);
      await releaseLocal.promise;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    session.onClaudeSessionHook({ session_id: 'sid1', hook_event_name: 'UserPromptSubmit' });
    session.onClaudeSessionHook({
      session_id: 'sid1',
      hook_event_name: 'StopFailure',
      error_type: 'rate_limit',
    } as any);

    await vi.waitFor(() => {
      expect(client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'usage_limit',
          usageLimit: expect.objectContaining({ providerLimitId: 'rate_limit' }),
        }),
      }));
    });

    releaseLocal.resolve(undefined);
    await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });
  });

  it('projects local TodoWrite transcript rows into session work-state metadata', async () => {
    const { session, client } = createLocalHarness();
    let scannerOptions: SessionScannerOptions | null = null;

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
      scannerOptions = opts;
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async () => {
      scannerOptions?.onMessage({
        type: 'assistant',
        uuid: 'assistant_todo_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_todo_1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Wire lifecycle parity', status: 'in_progress', activeForm: 'Wiring lifecycle parity' },
              ],
            },
          }],
        },
      } as any);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await expect(claudeLocalLauncher(session)).resolves.toEqual({ type: 'exit', code: 0 });

    const updateMetadata = client.updateMetadata as ReturnType<typeof vi.fn>;
    expect(updateMetadata).toHaveBeenCalled();
    const updater = updateMetadata.mock.calls.at(-1)?.[0] as ((metadata: any) => any) | undefined;
    expect(updater?.({})?.sessionWorkStateV1?.items).toEqual([
      expect.objectContaining({
        kind: 'todo',
        status: 'active',
        title: 'Wire lifecycle parity',
      }),
    ]);
  });

  it('emits local compaction lifecycle events from transcript markers', async () => {
    const { session, client, sendSessionEvent } = createLocalHarness();
    let scannerOptions: SessionScannerOptions | null = null;

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
      scannerOptions = opts;
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async () => {
      scannerOptions?.onMessage({
        type: 'user',
        uuid: 'compact_command_marker',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<command-name>/compact</command-name>' }],
        },
      } as any);
      scannerOptions?.onMessage({
        type: 'system',
        uuid: 'compact_boundary_1',
        subtype: 'compact_boundary',
        session_id: 'sid_after_compact',
      } as any);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await expect(claudeLocalLauncher(session)).resolves.toEqual({ type: 'exit', code: 0 });

    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-compaction',
      phase: 'started',
    }));
    expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-compaction',
      phase: 'completed',
      providerSessionId: 'sid_after_compact',
    }));
    const transcriptPayload = vi.mocked(client.sendClaudeSessionMessage).mock.calls
      .map(([message]) => JSON.stringify(message))
      .join('\n');
    expect(transcriptPayload).not.toContain('<command-name>/compact</command-name>');
    expect(transcriptPayload).not.toContain('<local-command-stdout>');
    expect(transcriptPayload).not.toContain('compact_boundary');
  });

  it('defers server-pending-queue remote switch until the active local Claude turn settles', async () => {
    vi.useFakeTimers();
    const { session, client } = createLocalHarness();
    let scannerOptions: SessionScannerOptions | null = null;
    let abortObserved = false;
    let pendingCount = 0;
    const wakePendingQueueUpdateRef: {
      current: ((value: boolean) => void) | null;
    } = { current: null };
    const localStarted = createDeferred<void>();

    client.peekPendingMessageQueueV2Count = vi.fn(async () => pendingCount);
    client.shouldAttemptPendingMaterialization = vi.fn(() => pendingCount > 0);
    client.waitForPendingEligibilityUpdate = vi.fn(async (signal?: AbortSignal) => {
      return await new Promise<boolean>((resolve) => {
        wakePendingQueueUpdateRef.current = resolve;
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      });
    });

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
      scannerOptions = opts;
      return createSessionScannerStub();
    });
    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
      abortObserved = true;
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    expect(scannerOptions).not.toBeNull();
    session.onSessionFound('sid1', hookWithTranscript('/tmp/sid1.jsonl'));

    scannerOptions!.onMessage({
      type: 'user',
      uuid: 'user_prompt_1',
      message: { content: 'do work' },
    } as any);

    pendingCount = 1;
    const wakePendingQueueUpdate = wakePendingQueueUpdateRef.current ?? (() => {
      throw new Error('Expected pending queue wait to be registered');
    });
    wakePendingQueueUpdate(true);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(client.waitForPendingEligibilityUpdate).toHaveBeenCalled();
    expect(client.peekPendingMessageQueueV2Count).not.toHaveBeenCalled();
    expect(abortObserved).toBe(false);

    scannerOptions!.onMessage({
      type: 'assistant',
      uuid: 'assistant_final',
      isSidechain: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final' }],
        stop_reason: 'end_turn',
      },
    } as any);
    await vi.advanceTimersByTimeAsync(500);

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
    expect(abortObserved).toBe(true);
  });

  it('returns switch after repeated Claude process failures (no infinite retry loop)', async () => {
    vi.useFakeTimers();
    const { session, sendSessionEvent } = createLocalHarness();

    mockClaudeLocal.mockImplementation(async () => {
      throw new Error('boom');
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
    expect(sendSessionEvent).toHaveBeenCalled();
  });

  it('surfaces transcript missing warnings to the UI', async () => {
    const previousWarningMs = process.env.HAPPIER_CLAUDE_TRANSCRIPT_MISSING_WARNING_MS;
    process.env.HAPPIER_CLAUDE_TRANSCRIPT_MISSING_WARNING_MS = '20000';
    vi.resetModules();
    try {
      const { session, sendSessionEvent } = createLocalHarness();

      mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
        expect(opts.transcriptMissingWarningMs).toBe(20000);
        opts.onTranscriptMissing?.({ sessionId: 'sess_1', filePath: '/tmp/sess_1.jsonl' });
        return createSessionScannerStub();
      });

      mockClaudeLocal.mockImplementationOnce(async () => {});

      const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
      const result = await claudeLocalLauncher(session);

      expect(result).toEqual({ type: 'exit', code: 0 });
      expect(sendSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          message: expect.stringContaining('transcript not available'),
        }),
      );
      expect(
        sendSessionEvent.mock.calls
          .flatMap((call) => call)
          .map((payload) => (payload as any)?.message)
          .filter((msg): msg is string => typeof msg === 'string')
          .some((msg) => msg.toLowerCase().includes('file not found')),
      ).toBe(false);
    } finally {
      process.env.HAPPIER_CLAUDE_TRANSCRIPT_MISSING_WARNING_MS = previousWarningMs;
      vi.resetModules();
    }
  });

  it('emits a canonical Diff transcript tool after a successful local write-like turn', async () => {
    const { session, client } = createLocalHarness();
    let scannerOptions: SessionScannerOptions | null = null;

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
      scannerOptions = opts;
      return createSessionScannerStub();
    });

    mockClaudeLocal.mockImplementationOnce(async () => {
      if (!scannerOptions) {
        throw new Error('scanner options not captured');
      }

      scannerOptions.onMessage({
        type: 'assistant',
        uuid: 'assistant_tool_use_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_write_1',
              name: 'Write',
              input: {
                file_path: '/Users/leeroy/Documents/Development/happier/dev/session-changes-qa-root.txt',
                content: 'gamma\n',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
      } as any);

      scannerOptions.onMessage({
        type: 'user',
        uuid: 'user_tool_result_1',
        isSidechain: false,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_write_1',
              content: 'updated',
              is_error: false,
            },
          ],
        },
        toolUseResult: {
          type: 'update',
          filePath: '/Users/leeroy/Documents/Development/happier/dev/session-changes-qa-root.txt',
          content: 'gamma\n',
          originalFile: 'beta\n',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-beta', '+gamma'],
            },
          ],
        },
      } as any);

      scannerOptions.onMessage({
        type: 'assistant',
        uuid: 'assistant_end_turn_1',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          stop_reason: 'end_turn',
        },
      } as any);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toEqual({ type: 'exit', code: 0 });

    const sendClaudeSessionMessageMock = client.sendClaudeSessionMessage as ReturnType<typeof vi.fn>;
    const diffCall = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    });

    expect(diffCall).toBeTruthy();
    const diffCallBlock = diffCall?.[0]?.message?.content?.find(
      (block: any) => block?.type === 'tool_use' && block?.name === 'Diff',
    );
    expect(diffCallBlock?.input?._happier).toMatchObject({
      protocol: 'claude',
      provider: 'claude',
      canonicalToolName: 'Diff',
      sessionChangeScope: 'turn',
      source: 'provider_tool',
      confidence: 'exact',
    });
    expect(diffCallBlock?.input?.files).toEqual([
      expect.objectContaining({
        file_path: '/Users/leeroy/Documents/Development/happier/dev/session-changes-qa-root.txt',
        oldText: 'beta\n',
        newText: 'gamma\n',
      }),
    ]);

    const finalAssistantIndex = sendClaudeSessionMessageMock.mock.calls.findIndex((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'text' && block?.text === 'Done.');
    });
    const diffCallIndex = sendClaudeSessionMessageMock.mock.calls.findIndex((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    });
    expect(finalAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(diffCallIndex).toBeGreaterThan(finalAssistantIndex);

    const diffResult = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_result' && typeof block?.tool_use_id === 'string');
    });
    expect(diffResult).toBeTruthy();
  });

  it('passes transcriptPath to sessionScanner when already known', async () => {
    const { session } = createLocalHarness();

    session.onSessionFound('sess_1', hookWithTranscript('/alt/sess_1.jsonl'));

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

    expect(result).toEqual({ type: 'exit', code: 0 });
    expect(mockCreateSessionScanner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_1',
        transcriptPath: '/alt/sess_1.jsonl',
      }),
    );
  });

  it('clears sessionId and transcriptPath before spawning a local resume session', async () => {
    const { session, switchHandlerReady } = createLocalHarness();
    const localStarted = createDeferred<void>();

    session.onSessionFound('sess_0', hookWithTranscript('/tmp/sess_0.jsonl'));

    let optsSessionId: string | null | undefined;
    let sessionIdAtSpawn: string | null | undefined;
    let transcriptPathAtSpawn: string | null | undefined;

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      optsSessionId = opts.sessionId;
      sessionIdAtSpawn = session.sessionId;
      transcriptPathAtSpawn = session.transcriptPath;
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    const switchHandler = await switchHandlerReady;
    await localStarted.promise;

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    expect(await switchHandler({ to: 'remote' })).toBe(true);
    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });

    expect(optsSessionId).toBe('sess_0');
    expect(sessionIdAtSpawn).toBeNull();
    expect(transcriptPathAtSpawn).toBeNull();

    expect(mockCreateSessionScanner).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_0',
        transcriptPath: '/tmp/sess_0.jsonl',
      }),
    );
  });

  it('respects switch RPC params and returns boolean', async () => {
    const { session, switchHandlerReady } = createLocalHarness();
    const localStarted = createDeferred<void>();

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    const switchHandler = await switchHandlerReady;
    await localStarted.promise;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    expect(await switchHandler({ to: 'remote' })).toBe(true);
    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
  });

  it('does not enter legacy remote mode when remote switching is disabled', async () => {
    const { session, switchHandlerReady } = createLocalHarness();
    const localStarted = createDeferred<void>();
    const releaseLocal = createDeferred<void>();
    let abortObserved = false;

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await Promise.race([
        releaseLocal.promise,
        waitForAbort(opts.abort).then(() => {
          abortObserved = true;
        }),
      ]);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session, { remoteSwitchingEnabled: false });

    const switchHandler = await switchHandlerReady;
    await localStarted.promise;

    expect(await switchHandler({ to: 'remote' })).toBe(false);

    session.queue.push('hello from app', defaultMode);
    await Promise.resolve();

    expect(abortObserved).toBe(false);

    releaseLocal.resolve(undefined);
    await expect(launcherPromise).resolves.toEqual({ type: 'exit', code: 0 });
  });

  it('returns switch (not exit) when Claude is terminated during app-triggered local→remote switch', async () => {
    const { session } = createLocalHarness();
    const localStarted = createDeferred<void>();

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    const { ExitCodeError } = await import('./claudeLocal');

    mockClaudeLocal.mockImplementationOnce(async (opts: LocalLaunchOptions) => {
      localStarted.resolve(undefined);
      await waitForAbort(opts.abort);
      throw new ExitCodeError(143);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const launcherPromise = claudeLocalLauncher(session);

    await localStarted.promise;
    session.queue.push('hello from app', defaultMode);

    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
  });

	  it('declines remote→local switch when queued messages exist and user does not confirm discard', async () => {
	    const { session } = createLocalHarness();

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

	    session.queue.push('hello from app', defaultMode);

	    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
	    const result = await claudeLocalLauncher(session, { entry: 'switch' });

    expect(result).toEqual({ type: 'switch' });
    expect(mockClaudeLocal).not.toHaveBeenCalled();
  });

	  it('discards queued messages when user confirms, then continues into local mode', async () => {
	    const { session, sendSessionEvent } = createLocalHarness();

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    readlineAnswer = 'y';
    session.queue.push('hello from app', defaultMode);

	    mockClaudeLocal.mockImplementationOnce(async () => {});

	    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
	    const result = await claudeLocalLauncher(session, { entry: 'switch' });

    expect(result).toEqual({ type: 'exit', code: 0 });
    expect(session.queue.size()).toBe(0);
    expect(sendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        message: expect.any(String),
      }),
    );
  });

  it('auto-discards queued messages in provider/e2e mode without prompting, then continues into local mode', async () => {
    const { session } = createLocalHarness();

    const prev = process.env.HAPPIER_E2E_PROVIDERS;
    process.env.HAPPIER_E2E_PROVIDERS = '1';
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

      // Default readlineAnswer is 'n' in this suite; if we still prompt, we'd decline and not start.
      session.queue.push('hello from app', defaultMode);

      mockClaudeLocal.mockImplementationOnce(async () => {});

      const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
      const result = await claudeLocalLauncher(session, { entry: 'switch' });

      expect(result).toEqual({ type: 'exit', code: 0 });
      expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
      expect(session.queue.size()).toBe(0);
    } finally {
      process.env.HAPPIER_E2E_PROVIDERS = prev;
    }
  });

  // INV-R C-1. The wave-23 workflow-agent transcript import was wired on the remote launcher only,
  // so on this launcher no registrar ever reached the journal follower and zero workflow-agent rows
  // could open. The scanner already owns the ONE sidechain importer for this runtime; the launcher
  // must hand workflow sidecars to that one rather than build a second. The source is constructed
  // BEFORE the scanner exists, so the holder is briefly empty — and while it is, wave 25's rule
  // stands: fail, so the follower withholds the id instead of stamping proof of a dead import.
  it('registers workflow-agent sidecars with the scanner sidechain importer, fail-closed (INV-R C-1)', async () => {
    const { session } = createLocalHarness();
    const importer = createSidechainImporterStub();
    mockCreateSessionScanner.mockImplementationOnce(async () => createSessionScannerStub(importer.collector));

    const registration = {
      sidechainId: 'workflow_agent_sidechain:toolu_1:agent-a',
      agentId: 'agent-a',
      filePath: '/tmp/wf/agent-agent-a.jsonl',
    };
    type RegisterWorkflowAgentTranscript = (input: typeof registration) => Promise<void>;
    let register: RegisterWorkflowAgentTranscript | undefined;
    let beforeScannerOutcome: unknown = 'never-attempted';
    mockCreateClaudeWorkflowActivitySourceForSession.mockImplementationOnce(async (params: Readonly<{
      registerWorkflowAgentTranscript?: RegisterWorkflowAgentTranscript;
    }>) => {
      register = params.registerWorkflowAgentTranscript;
      if (register) {
        beforeScannerOutcome = await register(registration).then(() => 'registered', (error) => error);
      }
      return null;
    });

    let afterScannerOutcome: unknown = 'never-attempted';
    mockClaudeLocal.mockImplementationOnce(async () => {
      if (!register) return;
      afterScannerOutcome = await register(registration).then(() => 'registered', (error) => error);
    });

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    await claudeLocalLauncher(session);

    if (typeof register !== 'function') {
      throw new Error('local launcher did not hand the workflow source a transcript registrar');
    }
    expect(beforeScannerOutcome).toBeInstanceOf(Error);
    expect(String(beforeScannerOutcome)).toMatch(/no sidechain importer/i);
    expect(afterScannerOutcome).toBe('registered');
    expect(importer.registerSidechainFile).toHaveBeenCalledWith({
      ...registration,
      source: 'workflow-agent',
    });
  });
});
