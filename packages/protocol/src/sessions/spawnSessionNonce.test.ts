import { describe, expect, it, vi } from 'vitest';

import { normalizeSpawnSessionNonceResolution, settleSpawnSessionNonce } from './spawnSessionNonce.js';

describe('normalizeSpawnSessionNonceResolution', () => {
  it('normalizes the shared machine/local nonce result contract without inventing a second reader', () => {
    expect(normalizeSpawnSessionNonceResolution({ status: 'success', sessionId: ' session-settled ' }))
      .toEqual({ status: 'success', sessionId: 'session-settled' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'unsupported' })).toEqual({ status: 'unsupported' });
    expect(normalizeSpawnSessionNonceResolution({
      status: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
      errorMessage: 'Child process exited before session webhook',
    })).toEqual({
      status: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
      errorMessage: 'Child process exited before session webhook',
    });
    expect(normalizeSpawnSessionNonceResolution({ status: 'success', sessionId: ' ' })).toEqual({ status: 'not_found' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'invented' })).toEqual({ status: 'not_found' });
    expect(normalizeSpawnSessionNonceResolution(null)).toEqual({ status: 'not_found' });
  });

  it('preserves the authoritative create-or-rejoin outcome on success', () => {
    expect(normalizeSpawnSessionNonceResolution({
      status: 'success',
      sessionId: 'session-1',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
      },
    })).toEqual({
      status: 'success',
      sessionId: 'session-1',
      sessionCreationOutcome: {
        disposition: 'rejoined',
        organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] },
      },
    });
  });
});

describe('settleSpawnSessionNonce', () => {
  it('returns a terminal operation error immediately without polling further', async () => {
    const resolve = vi.fn(async () => ({
      status: 'error' as const,
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' as const,
      errorMessage: 'Child process exited before session webhook',
    }));
    await expect(settleSpawnSessionNonce({
      spawnNonce: 'accepted-nonce',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    })).resolves.toEqual({
      status: 'error',
      errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK',
      errorMessage: 'Child process exited before session webhook',
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('keeps a resolver transport failure pending instead of misclassifying it as a missing nonce', async () => {
    let nowMs = 0;
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error('resolver transport interrupted'))
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-recovered' });

    await expect(settleSpawnSessionNonce({
      spawnNonce: 'accepted-nonce',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      notFoundGraceMs: 0,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    })).resolves.toEqual({ status: 'success', sessionId: 'session-recovered' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('returns promptly as unresolved when caller cancellation interrupts pending nonce resolution', async () => {
    const controller = new AbortController();
    const resolve = vi.fn(async () => await new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    }));
    const settled = settleSpawnSessionNonce({
      spawnNonce: 'accepted-nonce',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    controller.abort(new Error('caller retired'));

    await expect(settled).resolves.toEqual({ status: 'timeout' });
  });

  it('settles one nonce across pending and transient resolver probes', async () => {
    let nowMs = 0;
    const resolve = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockRejectedValueOnce(new Error('transient resolver transport failure'))
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-settled' });

    await expect(settleSpawnSessionNonce({
      spawnNonce: 'remote-predecessor-spawn-nonce',
      resolve,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      notFoundGraceMs: 100,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    })).resolves.toEqual({ status: 'success', sessionId: 'session-settled' });
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledWith('remote-predecessor-spawn-nonce', expect.any(Number));
  });

  it('times out while a tracked accepted spawn remains pending', async () => {
    let nowMs = 0;
    await expect(settleSpawnSessionNonce({
      spawnNonce: 'still-pending',
      resolve: async () => ({ status: 'pending' }),
      timeoutMs: 100,
      pollIntervalMs: 10,
      sleep: async (ms) => { nowMs += ms; },
      now: () => nowMs,
    })).resolves.toEqual({ status: 'timeout' });
  });

  it('passes the remaining deadline to each probe and bounds the final sleep', async () => {
    let nowMs = 0;
    const remainingBudgets: number[] = [];
    const sleepDurations: number[] = [];

    await expect(settleSpawnSessionNonce({
      spawnNonce: 'deadline-bounded',
      resolve: async (_spawnNonce, remainingTimeoutMs) => {
        remainingBudgets.push(remainingTimeoutMs);
        return { status: 'pending' };
      },
      timeoutMs: 10,
      pollIntervalMs: 1_000,
      sleep: async (ms) => {
        sleepDurations.push(ms);
        nowMs += ms;
      },
      now: () => nowMs,
    })).resolves.toEqual({ status: 'timeout' });
    expect(remainingBudgets).toEqual([10]);
    expect(sleepDurations).toEqual([10]);
  });
});
