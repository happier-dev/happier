import { describe, expect, it, vi } from 'vitest';

import { settleSpawnSessionNonce } from './spawnSessionNonce.js';

const immediateSleep = async () => {};

describe('settleSpawnSessionNonce', () => {
  it('resolves success as soon as the resolver reports a session id', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'sess_1' });
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-1',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      sleep: immediateSleep,
      now: () => 0,
    });
    expect(result).toEqual({ status: 'success', sessionId: 'sess_1' });
    expect(resolve).toHaveBeenCalledWith('nonce-1', 5_000);
  });

  it('returns unsupported immediately without polling further', async () => {
    const resolve = vi.fn(async () => ({ status: 'unsupported' as const }));
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-2',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      sleep: immediateSleep,
    });
    expect(result).toEqual({ status: 'unsupported' });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('returns a terminal operation error immediately without polling further', async () => {
    const resolve = vi.fn(async () => ({
      status: 'error' as const,
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' as const,
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    }));
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-child-exit',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      sleep: immediateSleep,
    });
    expect(result).toEqual({
      status: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
      errorMessage: 'Child process exited before session webhook (pid=8892, code=1, signal=null)',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('times out while the resolver stays pending', async () => {
    let nowMs = 0;
    const resolve = vi.fn(async () => ({ status: 'pending' as const }));
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-3',
      resolve,
      timeoutMs: 100,
      pollIntervalMs: 10,
      sleep: async () => { nowMs += 10; },
      now: () => nowMs,
    });
    expect(result).toEqual({ status: 'timeout' });
  });

  it('keeps a native-owned resolution pending past a bounded deadline until terminal evidence arrives', async () => {
    let nowMs = 0;
    let probes = 0;
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-slow-native',
      resolve: async (_spawnNonce, remainingTimeoutMs) => {
        probes += 1;
        expect(remainingTimeoutMs).toBeUndefined();
        return probes === 2
          ? { status: 'success' as const, sessionId: 'sess_slow_native' }
          : { status: 'pending' as const };
      },
      timeoutMs: null,
      pollIntervalMs: 90_001,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    });

    expect(result).toEqual({ status: 'success', sessionId: 'sess_slow_native' });
    expect(nowMs).toBeGreaterThan(90_000);
  });

  it('passes the remaining deadline to each probe and bounds the final sleep', async () => {
    let nowMs = 0;
    const remainingBudgets: number[] = [];
    const sleepDurations: number[] = [];
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-deadline',
      resolve: async (_spawnNonce, remainingTimeoutMs) => {
        if (typeof remainingTimeoutMs !== 'number') {
          throw new Error('bounded nonce resolution must receive a remaining deadline');
        }
        remainingBudgets.push(remainingTimeoutMs);
        return { status: 'pending' as const };
      },
      timeoutMs: 10,
      pollIntervalMs: 1_000,
      sleep: async (ms) => {
        sleepDurations.push(ms);
        nowMs += ms;
      },
      now: () => nowMs,
    });

    expect(result).toEqual({ status: 'timeout' });
    expect(remainingBudgets).toEqual([10]);
    expect(sleepDurations).toEqual([10]);
  });

  it('fails fast with not_found when the nonce stays untracked beyond the grace window', async () => {
    let nowMs = 0;
    const resolve = vi.fn(async () => ({ status: 'not_found' as const }));
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-4',
      resolve,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      notFoundGraceMs: 100,
      sleep: async () => { nowMs += 10; },
      now: () => nowMs,
    });
    expect(result).toEqual({ status: 'not_found' });
    // Must settle at the grace window, not the full timeout.
    expect(nowMs).toBeLessThan(1_000);
  });

  it('resets the not_found grace window when the resolver reports pending again', async () => {
    let nowMs = 0;
    const sequence = ['not_found', 'not_found', 'pending', 'not_found', 'success'] as const;
    let idx = 0;
    const resolve = vi.fn(async () => {
      const status = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      return status === 'success'
        ? ({ status: 'success', sessionId: 'sess_5' } as const)
        : ({ status } as const);
    });
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-5',
      resolve,
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      notFoundGraceMs: 25,
      sleep: async () => { nowMs += 10; },
      now: () => nowMs,
    });
    expect(result).toEqual({ status: 'success', sessionId: 'sess_5' });
  });

  it('treats resolver throws as pending probes without aborting the loop', async () => {
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ status: 'success', sessionId: 'sess_6' });
    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-6',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      sleep: immediateSleep,
    });
    expect(result).toEqual({ status: 'success', sessionId: 'sess_6' });
  });

  it('treats a resolver transport throw as pending rather than terminal not-found evidence', async () => {
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error('transport disconnected'))
      .mockResolvedValueOnce({ status: 'success', sessionId: 'sess_7' });

    const result = await settleSpawnSessionNonce({
      spawnNonce: 'nonce-7',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      // A zero not-found grace would fail immediately if a transport throw
      // were conflated with definitive daemon evidence.
      notFoundGraceMs: 0,
      sleep: immediateSleep,
    });

    expect(result).toEqual({ status: 'success', sessionId: 'sess_7' });
  });
});
