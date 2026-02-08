import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: vi.fn(),
}));

import { ensureDaemonRunningForSessionCommand } from './ensureDaemon';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from './controlClient';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

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
    vi.mocked(spawnHappyCLI).mockReturnValue({ unref } as any);

    vi.useFakeTimers();
    const promise = ensureDaemonRunningForSessionCommand();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(spawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], expect.any(Object));
    expect(unref).toHaveBeenCalledTimes(1);
    expect(isRunning).toHaveBeenCalledTimes(3);
  });
});
