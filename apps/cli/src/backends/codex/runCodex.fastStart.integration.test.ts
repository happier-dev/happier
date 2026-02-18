import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

let localStarted: Deferred<void> = createDeferred<void>();
let localExit: Deferred<{ type: 'exit'; code: number }> = createDeferred<{ type: 'exit'; code: number }>();

const codexLocalLauncherSpy = vi.fn(async (opts: any) => {
  void opts;
  localStarted.resolve();
  return await localExit.promise;
});
vi.mock('@/backends/codex/codexLocalLauncher', () => ({ codexLocalLauncher: codexLocalLauncherSpy }));

let initResolved = false;
vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
  initializeBackendApiContext: vi.fn(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    initResolved = true;
    return {
      api: {
        getOrCreateSession: vi.fn(async () => ({ id: 'sess_1', metadataVersion: 1 })),
        sessionSyncClient: vi.fn(() => ({
          sessionId: 'sess_1',
          rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
          ensureMetadataSnapshot: vi.fn(async () => ({})),
          getMetadataSnapshot: vi.fn(() => ({})),
          onUserMessage: vi.fn(),
          sendSessionEvent: vi.fn(),
          updateMetadata: vi.fn(),
          updateAgentState: vi.fn(),
          keepAlive: vi.fn(),
          sendSessionDeath: vi.fn(),
          flush: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
        })),
        push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
      },
      machineId: 'machine_1',
    };
  }),
}));

let initializeBackendRunSessionImpl: ((opts: any) => Promise<any>) | null = null;
const initializeBackendRunSessionSpy = vi.fn(async (opts: any) => {
  if (initializeBackendRunSessionImpl) {
    return await initializeBackendRunSessionImpl(opts);
  }
  const session = opts.api.sessionSyncClient({ id: 'sess_1', metadataVersion: 1 });
  return {
    session,
    reconnectionHandle: null,
    reportedSessionId: 'sess_1',
    attachedToExistingSession: false,
  };
});
vi.mock('@/agent/runtime/initializeBackendRunSession', () => ({ initializeBackendRunSession: initializeBackendRunSessionSpy }));

vi.mock('@/backends/codex/experiments', () => ({
  isExperimentalCodexAcpEnabled: vi.fn(() => true),
  isExperimentalCodexVendorResumeEnabled: vi.fn(() => false),
}));

vi.mock('@/backends/codex/utils/resolveCodexStartingMode', () => ({
  resolveCodexStartingMode: vi.fn(() => 'local'),
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

vi.mock('@/api/offline/serverConnectionErrors', () => ({
  connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
}));

vi.mock('@/integrations/caffeinate', () => ({
  stopCaffeinate: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
  registerKillSessionHandler: vi.fn(),
}));

describe('runCodex fast-start', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    void code;
    return undefined as never;
  }) as any);

  beforeEach(() => {
    localStarted = createDeferred<void>();
    localExit = createDeferred<{ type: 'exit'; code: number }>();
    initResolved = false;
    codexLocalLauncherSpy.mockClear();
    initializeBackendRunSessionSpy.mockClear();
    initializeBackendRunSessionImpl = null;
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  it('invokes local TUI spawn without waiting for backend API initialization', async () => {
    const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
    process.env.HAPPIER_STARTUP_TIMING_ENABLED = '1';

    const { runCodex } = await import('./runCodex');
    const { logger } = await import('@/ui/logger');

    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runCodex({ credentials, startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(localStarted.promise, 75)).resolves.toBeUndefined();
      expect(initResolved).toBe(false);
    } catch (e) {
      testError = e;
    } finally {
      localExit.resolve({ type: 'exit', code: 0 });
      await runPromise;

      if (prevTiming === undefined) delete process.env.HAPPIER_STARTUP_TIMING_ENABLED;
      else process.env.HAPPIER_STARTUP_TIMING_ENABLED = prevTiming;
    }

    const debugCalls = (logger.debug as any).mock?.calls?.map((c: any[]) => c[0]) ?? [];
    const timingLine = debugCalls.find(
      (line: unknown) =>
        typeof line === 'string' &&
        line.includes('[codex-startup]') &&
        line.includes('vendor_spawn_invoked=') &&
        line.includes('initialize_backend_api_context='),
    );
    expect(Boolean(timingLine)).toBe(true);

    if (testError) {
      throw testError;
    }

  });

  it('fast-starts local TUI for --resume sessions when permission mode is explicit', async () => {
    const { runCodex } = await import('./runCodex');

    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runCodex({
      credentials,
      startedBy: 'terminal',
      startingMode: 'local',
      resume: 'resume-123',
      permissionMode: 'default',
      permissionModeUpdatedAt: 1,
    } as any).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(localStarted.promise, 75)).resolves.toBeUndefined();
      expect(initResolved).toBe(false);
    } catch (e) {
      testError = e;
    } finally {
      localExit.resolve({ type: 'exit', code: 0 });
      await runPromise;
    }

    const firstCall = codexLocalLauncherSpy.mock.calls[0]?.[0];
    expect(firstCall?.resumeId).toBe('resume-123');

    if (testError) {
      throw testError;
    }
  });

  it('does not attach the deferred session to an offline stub; flushes buffered writes only after reconnection swap', async () => {
    const prevTiming = process.env.HAPPIER_STARTUP_TIMING_ENABLED;
    process.env.HAPPIER_STARTUP_TIMING_ENABLED = '1';

    const offlineStubCalls: Array<'sendSessionEvent' | 'updateMetadata'> = [];
    const offlineStub = {
      sessionId: 'offline-sess',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
      ensureMetadataSnapshot: vi.fn(async () => ({})),
      getMetadataSnapshot: vi.fn(() => ({})),
      onUserMessage: vi.fn(),
      sendSessionEvent: vi.fn(() => offlineStubCalls.push('sendSessionEvent')),
      updateMetadata: vi.fn(() => offlineStubCalls.push('updateMetadata')),
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      sendCodexMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      waitForMetadataUpdate: vi.fn(async () => false),
    };

    const realSendSessionEvent = vi.fn();
    const realUpdateMetadata = vi.fn();
    const realSession = {
      sessionId: 'sess_real',
      rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
      ensureMetadataSnapshot: vi.fn(async () => ({})),
      getMetadataSnapshot: vi.fn(() => ({})),
      onUserMessage: vi.fn(),
      sendSessionEvent: realSendSessionEvent,
      updateMetadata: realUpdateMetadata,
      updateAgentState: vi.fn(),
      keepAlive: vi.fn(),
      sendSessionDeath: vi.fn(),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      sendCodexMessage: vi.fn(),
      sendAgentMessage: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      sendUserTextMessage: vi.fn(),
      popPendingMessage: vi.fn(async () => false),
      peekPendingMessageQueueV2Count: vi.fn(async () => 0),
      discardPendingMessageQueueV2All: vi.fn(async () => 0),
      discardCommittedMessageLocalIds: vi.fn(async () => 0),
      waitForMetadataUpdate: vi.fn(async () => false),
    };

    let lastOnSessionSwap: ((next: any) => void) | undefined;
    initializeBackendRunSessionImpl = async (opts: any) => {
      lastOnSessionSwap = opts.onSessionSwap;
      return {
        session: offlineStub,
        reconnectionHandle: { cancel: vi.fn() },
        reportedSessionId: null,
        attachedToExistingSession: false,
      };
    };

    codexLocalLauncherSpy.mockImplementationOnce(async (opts: any) => {
      opts.session.sendSessionEvent({ type: 'message', message: 'buffered' });
      void opts.session.updateMetadata((current: any) => ({ ...current, codexSessionId: 'thread_1' }));
      localStarted.resolve();
      return await localExit.promise;
    });

    const { runCodex } = await import('./runCodex');
    const credentials = { token: 'test' } as Credentials;

    let testError: unknown = null;
    const runPromise = runCodex({ credentials, startedBy: 'terminal', startingMode: 'local' }).catch((e) => {
      testError = e;
    });

    try {
      await expect(waitFor(localStarted.promise, 150)).resolves.toBeUndefined();
      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (initResolved) return resolve();
              if (Date.now() - startedAt > 750) return reject(new Error('Timed out waiting for backend API initialization'));
              setTimeout(tick, 0);
            };
            tick();
          }),
          1500,
        ),
      ).resolves.toBeUndefined();

      expect(initializeBackendRunSessionSpy).toHaveBeenCalled();
      expect(offlineStubCalls).toEqual([]);

      if (typeof lastOnSessionSwap !== 'function') {
        throw new Error('Expected initializeBackendRunSession to provide an onSessionSwap callback');
      }
      lastOnSessionSwap(realSession);

      await expect(
        waitFor(
          new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            const tick = () => {
              if (realSendSessionEvent.mock.calls.length > 0 && realUpdateMetadata.mock.calls.length > 0) {
                resolve();
                return;
              }
              if (Date.now() - startedAt > 500) {
                reject(new Error('Timed out waiting for deferred flush after reconnection swap'));
                return;
              }
              setTimeout(tick, 0);
            };
            tick();
          }),
          1000,
        ),
      ).resolves.toBeUndefined();
    } catch (e) {
      testError = e;
    } finally {
      localExit.resolve({ type: 'exit', code: 0 });
      await runPromise;
      if (prevTiming === undefined) delete process.env.HAPPIER_STARTUP_TIMING_ENABLED;
      else process.env.HAPPIER_STARTUP_TIMING_ENABLED = prevTiming;
    }

    if (testError) {
      throw testError;
    }
  });
});
