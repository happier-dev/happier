import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fatalSpy, infoFileSpy, flushSyncSpy } = vi.hoisted(() => ({
  fatalSpy: vi.fn(),
  infoFileSpy: vi.fn(),
  flushSyncSpy: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { fatal: fatalSpy, infoFile: infoFileSpy, flushSync: flushSyncSpy },
}));

import { runInHostedSessionScope } from './lifecycle/hostedSessionScope';
import { registerRunnerTerminationHandlers } from './lifecycle/runnerTerminationHandlers';

function createFakeProcess() {
  return new EventEmitter();
}

describe('registerRunnerTerminationHandlers', () => {
  it('honors each hosted Session termination grace instead of the physical host policy', async () => {
    vi.useFakeTimers();
    const registrations = [250, 500].map(timeoutMs => runInHostedSessionScope({
      environment: { HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS: String(timeoutMs) },
    }, () => {
      const process = createFakeProcess();
      const exit = vi.fn();
      const handlers = registerRunnerTerminationHandlers({ process, exit,
        onTerminate: async () => await new Promise<void>(() => {}) });
      process.emit('SIGTERM');
      return { handlers, exit };
    }));
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(registrations[0]!.exit).toHaveBeenCalledWith(0);
      expect(registrations[1]!.exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(registrations[1]!.exit).toHaveBeenCalledWith(0);
    } finally {
      for (const { handlers } of registrations) handlers.dispose();
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    fatalSpy.mockClear();
    infoFileSpy.mockReset();
    flushSyncSpy.mockReset();
  });

  it('forces process exit even if onTerminate hangs (bounded by env timeout)', async () => {
    vi.useFakeTimers();
    const previousTimeout = process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS;
    process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS = '250';

    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async () => await new Promise<void>(() => undefined));

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
    });

    try {
      fakeProcess.emit('SIGTERM');

      await vi.advanceTimersByTimeAsync(300);

      expect(exit).toHaveBeenCalledWith(0);
      await expect(handlers.whenTerminated).resolves.toEqual(
        expect.objectContaining({
          event: expect.objectContaining({ kind: 'signal', signal: 'SIGTERM' }),
        }),
      );
    } finally {
      handlers.dispose();
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS = previousTimeout;
      }
      vi.useRealTimers();
    }
  });

  it('invokes onTerminate once for unhandledRejection and exits non-zero', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async () => undefined);

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
    });

    try {
      const error = new Error('boom');
      fakeProcess.emit('unhandledRejection', error, Promise.resolve());
      fakeProcess.emit('uncaughtException', new Error('ignored')); // should be ignored after first termination

      await handlers.whenTerminated;

      expect(onTerminate).toHaveBeenCalledTimes(1);
      expect(fatalSpy).toHaveBeenCalledTimes(1);
      expect(fatalSpy).toHaveBeenCalledWith(error);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      handlers.dispose();
    }
  });

  it('durably reports an uncaughtException exactly once before exiting non-zero', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const error = new Error('uncaught boom');
    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate: async () => undefined,
    });

    try {
      fakeProcess.emit('uncaughtException', error);
      fakeProcess.emit('unhandledRejection', new Error('ignored'), Promise.resolve());
      await handlers.whenTerminated;

      expect(fatalSpy).toHaveBeenCalledTimes(1);
      expect(fatalSpy).toHaveBeenCalledWith(error);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      handlers.dispose();
    }
  });

  it('can ignore specific unhandledRejection reasons and keep running', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async () => undefined);

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
      shouldTerminateOnUnhandledRejection: () => false,
    });

    try {
      fakeProcess.emit('unhandledRejection', new Error('ignored'), Promise.resolve());

      await expect(Promise.race([handlers.whenTerminated, Promise.resolve('nope')])).resolves.toBe('nope');
      expect(fatalSpy).not.toHaveBeenCalled();
      expect(onTerminate).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      fakeProcess.emit('SIGTERM');
      await handlers.whenTerminated;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      handlers.dispose();
    }
  });

  // Termination does not decide archiving — that authority was removed, and this
  // is the test that has to notice if it comes back.
  //
  // It is deliberately written to assert AFTER termination rather than inside the
  // callback. Production catches rejected `onTerminate` cleanup, so an
  // assertion that throws in there is swallowed and the test passes no matter what
  // it claimed. That is exactly how this test previously asserted `archive === true`
  // — the opposite of the shipped contract — while staying green.
  it('gives the termination callback an outcome with no archive authority', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    let observedOutcome: unknown = null;
    let callbackError: unknown = null;
    const onTerminate = vi.fn(async (_event, outcome) => {
      try {
        observedOutcome = outcome;
      } catch (error) {
        callbackError = error;
      }
    });

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
    });

    try {
      fakeProcess.emit('SIGTERM');
      await handlers.whenTerminated;

      expect(callbackError).toBeNull();
      expect(onTerminate).toHaveBeenCalledTimes(1);
      // The control that makes the assertion below meaningful: the callback really
      // ran and really received an outcome, so `archive` being absent is a fact
      // about the contract rather than about an outcome nobody looked at.
      expect(observedOutcome).toEqual({ exitCode: 0, terminationReason: 'Signal SIGTERM' });
      expect(Object.keys(observedOutcome as object)).not.toContain('archive');
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      handlers.dispose();
    }
  });

  it.each(['synchronous', 'asynchronous'] as const)('reports a %s cleanup failure while preserving the signal outcome', async (failureKind) => {
    const fakeProcess = createFakeProcess();
    // The file sink buffers until flushed; observe its persisted output at the exit boundary.
    let persistedDiagnostic: unknown = null;
    let diagnosticAtExit: unknown = null;
    infoFileSpy.mockImplementation((...args: unknown[]) => {
      flushSyncSpy.mockImplementationOnce(() => { persistedDiagnostic = args; });
    });
    const exit = vi.fn(() => { diagnosticAtExit = persistedDiagnostic; });
    const cleanupError = new Error('cleanup failed');
    const onTerminate = vi.fn(() => {
      if (failureKind === 'asynchronous') return Promise.reject(cleanupError);
      throw cleanupError;
    });

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
    });

    try {
      expect(() => fakeProcess.emit('SIGTERM')).not.toThrow();

      await handlers.whenTerminated;

      expect(onTerminate).toHaveBeenCalledTimes(1);
      expect(diagnosticAtExit).toEqual([expect.any(String), {
        phase: 'termination-cleanup',
        terminationKind: 'signal',
        cause: expect.stringContaining('cleanup failed'),
      }]);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      handlers.dispose();
    }
  });

  it('preserves the original failure exit when cleanup diagnostics fail', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    infoFileSpy.mockImplementationOnce(() => { throw new Error('log unavailable'); });
    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate: async () => { throw new Error('cleanup failed'); },
    });
    try {
      fakeProcess.emit('uncaughtException', new Error('original failure'));
      await handlers.whenTerminated;
      expect(infoFileSpy).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      handlers.dispose();
    }
  });

  it('writes a semantic exit report before bounded cleanup can hang', async () => {
    vi.useFakeTimers();
    const previousTimeout = process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS;
    process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS = '250';
    const baseDir = await mkdtemp(join(tmpdir(), 'happy-runner-termination-report-'));

    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async () => await new Promise<void>(() => undefined));

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
      sessionExitReport: {
        baseDir,
        sessionId: 'session_signal',
        pid: 1234,
        now: () => 42,
      },
    });

    try {
      fakeProcess.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(300);

      const parsed = JSON.parse(
        await readFile(join(baseDir, 'session-session_signal-pid-1234.json'), 'utf8'),
      );
      expect(parsed).toMatchObject({
        sessionId: 'session_signal',
        pid: 1234,
        observedAt: 42,
        observedBy: 'session',
        reason: 'runner-termination',
        terminationKind: 'signal',
        terminationSignal: 'SIGTERM',
        terminationRequestedAt: 42,
        terminationReason: 'Signal SIGTERM',
      });
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      handlers.dispose();
      if (previousTimeout === undefined) {
        delete process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS;
      } else {
        process.env.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS = previousTimeout;
      }
      vi.useRealTimers();
    }
  });

  it('removes listeners on dispose', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate: async () => undefined,
    });

    handlers.dispose();
    fakeProcess.emit('unhandledRejection', new Error('boom'), Promise.resolve());

    // If listeners are removed, termination should never happen.
    await expect(Promise.race([handlers.whenTerminated, Promise.resolve('nope')])).resolves.toBe('nope');
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves process listeners and exit to an external lifecycle owner', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async () => undefined);

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
      processLifecycleOwnership: 'caller',
    });

    expect(fakeProcess.listenerCount('SIGTERM')).toBe(0);
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakeProcess.listenerCount('unhandledRejection')).toBe(0);
    expect(fakeProcess.listenerCount('uncaughtException')).toBe(0);

    handlers.requestTermination({ kind: 'killSession' });
    await expect(handlers.whenTerminated).resolves.toEqual(
      expect.objectContaining({ event: { kind: 'killSession' } }),
    );
    expect(onTerminate).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('registerRunnerTerminationHandlers with several Sessions in one process', () => {
  beforeEach(() => {
    fatalSpy.mockClear();
  });

  // Each Session enters its own scope; `emitInScope` replays a process event
  // from inside that Session's async context, as a throw in its work would.
  async function registerInScope(fakeProcess: EventEmitter, exit: (code: number) => void) {
    const onTerminate = vi.fn(async () => undefined);
    return await runInHostedSessionScope({ environment: {} }, async () => ({
      onTerminate,
      handlers: registerRunnerTerminationHandlers({ process: fakeProcess, exit, onTerminate }),
      emitInScope: AsyncResource.bind((event: string, value: unknown) => {
        fakeProcess.emit(event, value, Promise.resolve());
      }),
    }));
  }

  it('installs one process listener set for every Session it hosts', async () => {
    const fakeProcess = createFakeProcess();
    const a = await registerInScope(fakeProcess, vi.fn());
    const b = await registerInScope(fakeProcess, vi.fn());
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(1);
    expect(fakeProcess.listenerCount('uncaughtException')).toBe(1);
    a.handlers.dispose();
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(1);
    b.handlers.dispose();
    expect(fakeProcess.listenerCount('SIGTERM')).toBe(0);
    expect(fakeProcess.listenerCount('unhandledRejection')).toBe(0);
  });

  it('ends only the Session whose work threw and keeps the process for the others', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const a = await registerInScope(fakeProcess, exit);
    const b = await registerInScope(fakeProcess, exit);
    try {
      const failure = new Error('session A bug');
      a.emitInScope('uncaughtException', failure);
      await a.handlers.whenTerminated;
      expect(a.onTerminate).toHaveBeenCalledOnce();
      expect(b.onTerminate).not.toHaveBeenCalled();
      expect(fatalSpy).toHaveBeenCalledWith(failure);
      expect(exit).not.toHaveBeenCalled();

      b.handlers.requestTermination({ kind: 'exit', code: 0 });
      await b.handlers.whenTerminated;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      a.handlers.dispose();
      b.handlers.dispose();
    }
  });

  it('keeps every Session running when a failure cannot be attributed to one of several', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const a = await registerInScope(fakeProcess, exit);
    const b = await registerInScope(fakeProcess, exit);
    try {
      const failure = new Error('host-level bug');
      fakeProcess.emit('uncaughtException', failure);
      fakeProcess.emit('unhandledRejection', failure, Promise.resolve());
      await Promise.resolve();
      expect(fatalSpy).toHaveBeenCalledWith(failure);
      expect(a.onTerminate).not.toHaveBeenCalled();
      expect(b.onTerminate).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      a.handlers.dispose();
      b.handlers.dispose();
    }
  });

  it('ends every hosted Session on a process signal and exits once after the last one', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const a = await registerInScope(fakeProcess, exit);
    const b = await registerInScope(fakeProcess, exit);
    try {
      fakeProcess.emit('SIGTERM');
      await Promise.all([a.handlers.whenTerminated, b.handlers.whenTerminated]);
      await new Promise(resolve => setImmediate(resolve));
      expect(a.onTerminate).toHaveBeenCalledOnce();
      expect(b.onTerminate).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      a.handlers.dispose();
      b.handlers.dispose();
    }
  });
});

