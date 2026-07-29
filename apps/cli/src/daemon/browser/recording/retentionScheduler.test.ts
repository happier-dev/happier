import { describe, expect, it, vi } from 'vitest';

describe('browser recording retention cleanup scheduler', () => {
  it('runs retention cleanup with the current daemon time and reports cleanup results', async () => {
    const { BrowserRecordingRetentionCleanupScheduler } = await import('./retentionScheduler');
    const cleanupExpiredRecordings = vi.fn(async () => ({
      discardedRecordingIds: ['recording_expired'],
      failedRecordingIds: [],
    }));
    const scheduler = new BrowserRecordingRetentionCleanupScheduler({
      cleanupExpiredRecordings,
      nowMs: () => 12_000,
      intervalMs: 5_000,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      status: 'cleaned',
      discardedRecordingIds: ['recording_expired'],
      failedRecordingIds: [],
    });
    expect(cleanupExpiredRecordings).toHaveBeenCalledWith({ nowMs: 12_000 });
  });

  it('does not overlap retention cleanup runs and can stop a scheduled timer', async () => {
    const { BrowserRecordingRetentionCleanupScheduler } = await import('./retentionScheduler');
    let finishCleanup!: () => void;
    const cleanupExpiredRecordings = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      return {
        discardedRecordingIds: [],
        failedRecordingIds: [],
      };
    });
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn((callback: () => void, _delayMs: number) => {
      return { callback };
    });
    const scheduler = new BrowserRecordingRetentionCleanupScheduler({
      cleanupExpiredRecordings,
      nowMs: () => 12_000,
      intervalMs: 5_000,
      setTimeout,
      clearTimeout,
    });

    scheduler.start();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 5_000);
    const firstRun = scheduler.runOnce();

    await expect(scheduler.runOnce()).resolves.toEqual({
      status: 'skipped',
      reason: 'cleanup_already_running',
    });
    expect(cleanupExpiredRecordings).toHaveBeenCalledTimes(1);

    finishCleanup();
    await expect(firstRun).resolves.toEqual({
      status: 'cleaned',
      discardedRecordingIds: [],
      failedRecordingIds: [],
    });

    scheduler.stop();
    expect(clearTimeout).toHaveBeenCalledWith(setTimeout.mock.results[0]?.value);
  });
});
