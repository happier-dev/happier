import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: (value: T) => resolveFn?.(value) };
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

let loopStarted: Deferred<void> = createDeferred<void>();
let loopExit: Deferred<number> = createDeferred<number>();
let lastLoopOpts: any = null;
let autoSessionReady = true;

vi.mock('@/backends/claude/loop', () => ({
  loop: vi.fn(async (opts: any) => {
    lastLoopOpts = opts;
    loopStarted.resolve();
    if (autoSessionReady) {
      opts?.onSessionReady?.({
        cleanup: vi.fn(),
        setPushSender: vi.fn(),
        getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
      });
    }
    return await loopExit.promise;
  }),
}));

let initResolved = false;
let backendInitDelayMs = 200;
const getOrCreateSessionSpy = vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 }));
const sendSessionEventSpy = vi.fn();
const sessionSyncClientSpy = vi.fn((resp: any) => ({
  sessionId: resp?.id ?? 'sess_1',
  rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
  ensureMetadataSnapshot: vi.fn(async () => ({})),
  getMetadataSnapshot: vi.fn(() => ({})),
  onUserMessage: vi.fn(),
  sendSessionEvent: sendSessionEventSpy,
  updateMetadata: vi.fn(),
  updateAgentState: vi.fn(),
  sendSessionDeath: vi.fn(),
  flush: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));
vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, backendInitDelayMs));
    initResolved = true;
    return {
      api: {
        getOrCreateSession: getOrCreateSessionSpy,
        sessionSyncClient: sessionSyncClientSpy,
        push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
      },
      machineId: 'machine_1',
    };
  }),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    infoDeveloper: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happier.log',
  },
}));

vi.mock('@/ui/doctor', () => ({
  getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:1234',
    toolNames: [],
    stop: vi.fn(),
  })),
}));

vi.mock('@/backends/claude/utils/startHookServer', () => ({
  startHookServer: vi.fn(async () => ({ port: 12345, stop: vi.fn() })),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
  generateHookSettingsFile: vi.fn(() => '/tmp/happier-hooks.json'),
  cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: vi.fn(() => false),
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/agent/runtime/startupSideEffects', () => ({
  primeAgentStateForUi: vi.fn(),
  persistTerminalAttachmentInfoIfNeeded: vi.fn(async () => {}),
  reportSessionToDaemonIfRunning: vi.fn(async () => {}),
  sendTerminalFallbackMessageIfNeeded: vi.fn(),
}));

vi.mock('@/agent/runtime/startupMetadataUpdate', () => ({
  applyStartupMetadataUpdateToSession: vi.fn(),
  buildAcpSessionModeOverride: vi.fn(() => null),
  buildModelOverride: vi.fn(() => null),
  buildPermissionModeOverride: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/permission/startupPermissionModeSeed', () => ({
  resolveStartupPermissionModeFromSession: vi.fn(async () => null),
}));

vi.mock('@/agent/runtime/runnerTerminationOutcome', () => ({
  computeRunnerTerminationOutcome: vi.fn(() => ({ kind: 'exit', code: 0 })),
}));

vi.mock('@/backends/claude/sdk/metadataExtractor', () => ({
  extractSDKMetadataAsync: vi.fn(),
}));

type OfflineReconnectionConfig<TSession> = {
  serverUrl: string;
  onReconnected: () => Promise<TSession>;
  onNotify: (message: string) => void;
  onCleanup?: () => void;
  healthCheck?: () => Promise<void>;
  initialDelayMs?: number;
  backoffDelayMs?: (failureCount: number) => number;
};

let lastOfflineReconnectionConfig: OfflineReconnectionConfig<any> | null = null;
const startOfflineReconnectionSpy = vi.fn((config: OfflineReconnectionConfig<any>) => {
  lastOfflineReconnectionConfig = config;
  return { cancel: vi.fn(), getSession: () => null, isReconnected: () => false };
});
vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
  startOfflineReconnection: startOfflineReconnectionSpy,
}));

vi.mock('@/agent/runtime/runnerTerminationHandlers', () => ({
  registerRunnerTerminationHandlers: vi.fn(() => ({
    requestTermination: vi.fn(),
    whenTerminated: Promise.resolve(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateAgentStateBestEffort: vi.fn(),
  updateMetadataBestEffort: vi.fn(),
}));

describe('runClaude fast-start', () => {
  const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    void code;
    return undefined as never;
  }) as any);

  beforeAll(() => {
    process.env.HAPPIER_STARTUP_TIMING_ENABLED = '1';
  });

  afterAll(() => {
    if (prevTiming === undefined) delete process.env.HAPPIER_STARTUP_TIMING_ENABLED;
    else process.env.HAPPIER_STARTUP_TIMING_ENABLED = prevTiming;
    exitSpy.mockRestore();
  });

  it('invokes vendor spawn without waiting for backend API initialization', async () => {
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 200;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');

    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, 75)).resolves.toBeUndefined();
      expect(initResolved).toBe(false);
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('starts offline reconnection when create-session fails, then attaches once reconnected', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    sendSessionEventSpy.mockClear();

    let createCalls = 0;
    getOrCreateSessionSpy.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) return null as any;
      return { id: 'sess_2', metadataVersion: 1 } as any;
    });

    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const { persistTerminalAttachmentInfoIfNeeded } = await import('@/agent/runtime/startupSideEffects');
    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local', terminalRuntime: { mode: 'tmux' } }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, 150)).resolves.toBeUndefined();

      // Wait for offline reconnection to be scheduled.
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (startOfflineReconnectionSpy.mock.calls.length > 0) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for startOfflineReconnection'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      expect(lastOfflineReconnectionConfig).not.toBeNull();
      await lastOfflineReconnectionConfig!.onReconnected();

      // The offline status message should flush to the real session on attach.
      expect(sendSessionEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          message: expect.stringContaining('Server unreachable'),
        }),
        undefined,
      );

      // Startup side effects should run once the real session is available (persist terminal attachment, etc).
      expect(persistTerminalAttachmentInfoIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess_2' }),
      );
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('emits a startup timing summary line after session attach when enabled', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = true;
    initResolved = false;
    backendInitDelayMs = 0;
    sendSessionEventSpy.mockClear();
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const { logger } = await import('@/ui/logger');
    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(loopStarted.promise, 150)).resolves.toBeUndefined();
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (initResolved) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for initializeBackendApiContext'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      const debugCalls = (logger.debug as any).mock?.calls?.map((c: any[]) => c[0]) ?? [];
      const timingLine = debugCalls.find(
        (line: unknown) =>
          typeof line === 'string' &&
          line.includes('[claude-startup]') &&
          line.includes('vendor_spawn_invoked=') &&
          line.includes('initialize_backend_api_context=') &&
          line.includes('initialize_backend_run_session='),
      );
      expect(Boolean(timingLine)).toBe(true);
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });

  it('sets push sender even when the loop session becomes ready after the server session is available', async () => {
    vi.resetModules();
    loopStarted = createDeferred<void>();
    loopExit = createDeferred<number>();
    lastLoopOpts = null;
    autoSessionReady = false;
    initResolved = false;
    backendInitDelayMs = 0;
    getOrCreateSessionSpy.mockImplementation(async () => ({ id: 'sess_1', metadataVersion: 1 }));
    startOfflineReconnectionSpy.mockClear();
    lastOfflineReconnectionConfig = null;

    const { runClaude } = await import('./runClaude');
    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runClaude(credentials, { startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    const sessionReady = {
      cleanup: vi.fn(),
      setPushSender: vi.fn(),
      getOrCreatePermissionRpcRouter: () => ({ registerConsumer: vi.fn() }),
    };

    try {
      await expect(waitFor(loopStarted.promise, 150)).resolves.toBeUndefined();

      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (initResolved) return resolve();
              if (Date.now() - startedAt > 500) return reject(new Error('Timed out waiting for initializeBackendApiContext'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();

      // Allow the background init task to resume after the await and publish its artifacts (pushSender, etc).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(lastLoopOpts).not.toBeNull();
      lastLoopOpts?.onSessionReady?.(sessionReady);
      expect(sessionReady.setPushSender).toHaveBeenCalled();
    } catch (e) {
      testError = e;
    } finally {
      loopExit.resolve(0);
      await runPromise;
    }

    if (testError) {
      throw testError;
    }
  });
});
