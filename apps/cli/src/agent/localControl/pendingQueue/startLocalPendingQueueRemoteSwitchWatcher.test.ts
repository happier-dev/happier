import { describe, expect, it, vi } from 'vitest';

import { startLocalPendingQueueRemoteSwitchWatcher } from './startLocalPendingQueueRemoteSwitchWatcher';

describe('startLocalPendingQueueRemoteSwitchWatcher', () => {
  it('triggers a remote switch once when server pending queue rows appear', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('continues polling after a transient pending-count failure', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    watcher.stop();
    vi.useRealTimers();
  });

  it('re-arms after a rejected remote-switch request and retries on the next poll', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(100);
    expect(requestRemoteSwitch).toHaveBeenCalledTimes(2);

    watcher.stop();
    vi.useRealTimers();
  });

  it('stops polling without triggering a later switch', async () => {
    vi.useFakeTimers();
    const peekPendingCount = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const requestRemoteSwitch = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const watcher = startLocalPendingQueueRemoteSwitchWatcher({
      peekPendingCount,
      pollIntervalMs: 25,
      requestRemoteSwitch,
    });
    watcher.stop();

    await vi.advanceTimersByTimeAsync(50);

    expect(peekPendingCount).not.toHaveBeenCalled();
    expect(requestRemoteSwitch).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
