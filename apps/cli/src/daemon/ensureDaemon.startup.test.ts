import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(),
}));

import { ensureDaemonRunningForSessionCommand } from './ensureDaemon';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';

describe('ensureDaemonRunningForSessionCommand', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls daemon readiness after spawning', async () => {
    const isRunning = vi.mocked(isDaemonRunningCurrentlyInstalledHappyVersion);
    isRunning
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const unref = vi.fn();
    vi.mocked(spawnDetachedDaemonStartSync).mockResolvedValue({ unref } as any);

    vi.useFakeTimers();
    const promise = ensureDaemonRunningForSessionCommand();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(spawnDetachedDaemonStartSync).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(isRunning).toHaveBeenCalledTimes(3);
  });
});
