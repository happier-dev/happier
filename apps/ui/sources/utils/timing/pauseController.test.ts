import { describe, expect, it, vi } from 'vitest';

import { PauseController } from './pauseController';

describe('PauseController', () => {
  it('waitUntilResumed resolves immediately when not paused', async () => {
    const pause = new PauseController();
    await pause.waitUntilResumed();
  });

  it('waitUntilResumed blocks while paused and resolves on resume', async () => {
    vi.useFakeTimers();
    try {
      const pause = new PauseController();
      pause.pause();

      let resolved = false;
      const p = pause.waitUntilResumed().then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(resolved).toBe(false);

      pause.resume();
      await vi.runAllTicks();
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves multiple waiters on resume', async () => {
    const pause = new PauseController();
    pause.pause();

    const a = pause.waitUntilResumed();
    const b = pause.waitUntilResumed();

    pause.resume();
    await Promise.all([a, b]);
  });

  it('remains paused until all pause reasons are resumed', async () => {
    vi.useFakeTimers();
    try {
      const pause = new PauseController();
      pause.pause('app');
      pause.pause('endpoint');

      expect(pause.isPaused()).toBe(true);
      pause.resume('endpoint');
      expect(pause.isPaused()).toBe(true);

      let resolved = false;
      const p = pause.waitUntilResumed().then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(resolved).toBe(false);

      pause.resume('app');
      await vi.runAllTicks();
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
