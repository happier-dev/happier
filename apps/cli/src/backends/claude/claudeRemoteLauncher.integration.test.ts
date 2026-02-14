import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { Session } from './session';
import type { EnhancedMode } from './loop';

type RpcHandler = (params?: unknown) => unknown | Promise<unknown>;
type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;
type RemoteDispatchMockOptions = {
  signal?: AbortSignal;
  onSessionFound?: (sessionId: string) => void;
};

const mockInkRender = vi.fn(() => ({ unmount: vi.fn() }));
vi.mock('ink', () => ({
  render: mockInkRender,
}));

const mockClaudeRemoteDispatch = vi.fn<(opts: unknown) => Promise<void>>();
vi.mock('./remote/claudeRemoteDispatch', () => ({
  claudeRemoteDispatch: mockClaudeRemoteDispatch,
}));

const mockResetParentChain = vi.fn();
const mockUpdateSessionId = vi.fn();
vi.mock('./utils/sdkToLogConverter', () => ({
  SDKToLogConverter: vi.fn().mockImplementation(() => ({
    resetParentChain: mockResetParentChain,
    updateSessionId: mockUpdateSessionId,
    convert: () => null,
    convertSidechainUserMessage: () => null,
    generateInterruptedToolResult: () => null,
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

type SessionClientStub = {
  sessionId: string;
  keepAlive: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  updateAgentState: ReturnType<typeof vi.fn>;
  rpcHandlerManager: {
    registerHandler: (method: string, handler: RpcHandler) => void;
  };
  sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
  sendSessionEvent: ReturnType<typeof vi.fn>;
};

type RemoteHarness = {
  session: Session;
  switchHandlerReady: Promise<RpcHandler>;
};

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

function createRemoteHarness(options?: { sessionId?: string | null }): RemoteHarness {
  const switchDeferred = createDeferred<RpcHandler>();

  const client: SessionClientStub = {
    sessionId: 'happy_sess_1',
    keepAlive: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn((updater) => updater({})),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: RpcHandler) => {
        if (method === 'switch') {
          switchDeferred.resolve(handler);
        }
      }),
    },
    sendClaudeSessionMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
  };

  const sendToAllDevices = vi.fn();
  const session = new Session({
    api: {
      push: () => ({ sendToAllDevices }),
    } as never,
    client: client as unknown as ApiSessionClient,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: options?.sessionId ?? null,
    mcpServers: {},
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });

  createdSessions.push(session);

  return {
    session,
    switchHandlerReady: switchDeferred.promise,
  };
}

describe.sequential('claudeRemoteLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const session of createdSessions.splice(0)) {
      session.cleanup();
    }
  });

  it('does not double-reset parent chain when sessionId changes during a remote run', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const secondDispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        dispatchOpts.onSessionFound?.('sess_1');
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        secondDispatchStarted.resolve(undefined);
        await waitForAbort(dispatchOpts.signal);
      });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await secondDispatchStarted.promise;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(2);
    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does not mount Ink UI for daemon-started sessions even when a TTY is available', async () => {
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStdinIsTTY = process.stdin.isTTY;

    process.stdout.isTTY = true;
    process.stdin.isTTY = true;

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    (session as any).startedBy = 'daemon';

    mockInkRender.mockClear();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    try {
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);
      });

      expect(mockInkRender).not.toHaveBeenCalled();

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      process.stdout.isTTY = originalStdoutIsTTY;
      process.stdin.isTTY = originalStdinIsTTY;
    }
  }, 30_000);

  it('respects switch RPC params and is idempotent', async () => {
    const { session, switchHandlerReady } = createRemoteHarness();

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'remote' })).toBe(false);
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('treats null sessionId as a new session boundary', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: null });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  });
});
