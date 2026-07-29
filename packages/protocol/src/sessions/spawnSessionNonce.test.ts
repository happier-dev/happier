import { describe, expect, it, vi } from 'vitest';

import { normalizeSpawnSessionNonceResolution, settleSpawnSessionNonce } from './spawnSessionNonce.js';

describe('normalizeSpawnSessionNonceResolution', () => {
  it('normalizes the shared machine/local nonce result contract without inventing a second reader', () => {
    expect(normalizeSpawnSessionNonceResolution({ status: 'success', sessionId: ' session-settled ' }))
      .toEqual({ status: 'success', sessionId: 'session-settled' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'unsupported' })).toEqual({ status: 'unsupported' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'success', sessionId: ' ' })).toEqual({ status: 'not_found' });
    expect(normalizeSpawnSessionNonceResolution({ status: 'invented' })).toEqual({ status: 'not_found' });
    expect(normalizeSpawnSessionNonceResolution(null)).toEqual({ status: 'not_found' });
  });
});

describe('settleSpawnSessionNonce', () => {
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
    expect(resolve).toHaveBeenCalledWith('remote-predecessor-spawn-nonce');
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
});
