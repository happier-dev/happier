import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { Session } from './session';
import { EventEmitter } from 'node:events';
import type { EnhancedMode } from './loop';

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

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

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

function createSessionScannerStub(): SessionScannerResult {
  return {
    cleanup: vi.fn(async () => {}),
    onNewSession: vi.fn(),
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

function createLocalHarness(options?: { metadataSnapshot?: MetadataSnapshot }): LocalHarness {
  const switchDeferred = createDeferred<RpcHandler>();
  const abortDeferred = createDeferred<RpcHandler>();
  const sendSessionEvent = vi.fn();

  const client = Object.assign(new EventEmitter(), {
    sessionId: 'happy_sess_1',
    keepAlive: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn(),
    getMetadataSnapshot: options?.metadataSnapshot ? vi.fn(() => options.metadataSnapshot) : undefined,
    waitForMetadataUpdate: vi.fn(async () => false),
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
    sendAgentMessage: vi.fn(),
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
    mcpServers: {},
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
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
    readlineAnswer = 'n';
    mockCreateSessionScanner.mockResolvedValue(createSessionScannerStub());
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

  it('does not block initial local startup on pending-queue inspection', async () => {
    const { session, client } = createLocalHarness();

    client.peekPendingMessageQueueV2Count = vi.fn(async () => {
      throw new Error('pending queue inspection should not run for initial local startup');
    });

    mockClaudeLocal.mockImplementationOnce(async () => {});

    const { claudeLocalLauncher } = await import('./claudeLocalLauncher');
    const result = await claudeLocalLauncher(session);

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
    const { session, sendSessionEvent } = createLocalHarness();

    mockCreateSessionScanner.mockImplementation(async (opts: SessionScannerOptions) => {
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
        message: expect.any(String),
      }),
    );
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

    expect(await switchHandler({ to: 'local' })).toBe(false);
    expect(await switchHandler({ to: 'remote' })).toBe(true);
    await expect(launcherPromise).resolves.toEqual({ type: 'switch' });
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
});
