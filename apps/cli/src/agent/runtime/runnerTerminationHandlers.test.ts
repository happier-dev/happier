import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { registerRunnerTerminationHandlers } from './runnerTerminationHandlers';

function createFakeProcess() {
  return new EventEmitter();
}

describe('registerRunnerTerminationHandlers', () => {
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
      fakeProcess.emit('unhandledRejection', new Error('boom'), Promise.resolve());
      fakeProcess.emit('uncaughtException', new Error('ignored')); // should be ignored after first termination

      await handlers.whenTerminated;

      expect(onTerminate).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
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
