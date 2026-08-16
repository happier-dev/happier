import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fatalSpy } = vi.hoisted(() => ({
  fatalSpy: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
  logger: { fatal: fatalSpy },
}));

vi.mock('../../configuration', () => ({
  configuration: {
    happyHomeDir: '',
  },
}));

import { registerRunnerTerminationHandlers } from './runnerTerminationHandlers';

function createFakeProcess() {
  return new EventEmitter();
}

describe('registerRunnerTerminationHandlers', () => {
  beforeEach(() => {
    fatalSpy.mockClear();
  });

  it('closes runtime input admission synchronously before asynchronous termination cleanup starts', async () => {
    const fakeProcess = createFakeProcess();
    const events: string[] = [];
    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit: () => undefined,
      onTerminationRequested: () => {
        events.push('admission-closed');
      },
      onTerminate: async () => {
        events.push('cleanup-started');
      },
    });

    try {
      handlers.requestTermination({ kind: 'killSession' });

      expect(events).toEqual(['admission-closed']);
      await handlers.whenTerminated;
      expect(events).toEqual(['admission-closed', 'cleanup-started']);
    } finally {
      handlers.dispose();
    }
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

  it('archives on SIGTERM (exit 0) by default outcome', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(async (_event, outcome) => {
      expect(outcome.archive).toBe(true);
    });

    const handlers = registerRunnerTerminationHandlers({
      process: fakeProcess,
      exit,
      onTerminate,
    });

    try {
      fakeProcess.emit('SIGTERM');
      await handlers.whenTerminated;

      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      handlers.dispose();
    }
  });

  it('still exits when onTerminate throws synchronously', async () => {
    const fakeProcess = createFakeProcess();
    const exit = vi.fn();
    const onTerminate = vi.fn(() => {
      throw new Error('cleanup failed');
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
      expect(exit).toHaveBeenCalledWith(0);
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
});
