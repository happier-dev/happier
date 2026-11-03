import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TransferSessionStore } from './transferSessionStore';

describe('native transfer record custody', () => {
  it('keeps the producer deadline instead of extending native custody from a second host TTL', async () => {
    vi.useFakeTimers();
    const store = new TransferSessionStore({ ttlMs: 10_000, expiryTrigger: 'self' });
    let expiresAt = Date.now() + 1000;
    let disposed = 0;
    try {
      expect(store.retainNativeSession).toBeTypeOf('function');
      store.retainNativeSession('download', 'native-deadline', { invoke: async () => undefined, verifyInvocation: async () => {},
        promote: () => {}, readExpiry: () => expiresAt, dispose: async () => { disposed++; } });
      await vi.advanceTimersByTimeAsync(500);
      expiresAt = Date.now() + 1000;
      store.refreshDownloadExpiry('native-deadline');
      await vi.advanceTimersByTimeAsync(999);
      expect(disposed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await store.settleClosures();
      expect(disposed).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await store.dispose(); vi.useRealTimers(); }
  });

  it('uses the existing expiry deadline once and adds no recurring idle work', async () => {
    vi.useFakeTimers();
    const store = new TransferSessionStore({ ttlMs: 1000, expiryTrigger: 'self' });
    let disposed = 0;
    try {
      expect(store.retainNativeSession).toBeTypeOf('function');
      store.retainNativeSession('upload', 'expired-native', { invoke: async () => undefined, verifyInvocation: async () => {},
        promote: () => {}, dispose: async () => { disposed++; } });
      await vi.advanceTimersByTimeAsync(999);
      expect(disposed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await store.settleClosures();
      expect(disposed).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(disposed).toBe(1);
    } finally { await store.dispose(); vi.useRealTimers(); }
  });

  it.each(['upload', 'download'] as const)('retains the %s process in the existing record, protects active work from expiry, and awaits physical close', async direction => {
    const store = new TransferSessionStore({ ttlMs: 1000 });
    const pipe = new PassThrough();
    let promoted = false;
    let disposalStarted = false;
    let releaseClose!: () => void;
    const physicalClose = new Promise<void>(resolve => { releaseClose = resolve; });
    const owner = { invoke: async () => ({ success: true }), verifyInvocation: async () => {},
      promote: () => { promoted = true; }, dispose: async () => { disposalStarted = true; pipe.end(); await physicalClose; } };
    expect(store.retainNativeSession).toBeTypeOf('function');
    store.retainNativeSession(direction, 'native-transfer', owner);
    expect(promoted).toBe(true);
    expect(direction === 'upload' ? store.countUploadSessions() : store.listDownloadSessionIds().length).toBe(1);
    // A native record cannot be treated as a daemon file descriptor by the
    // ordinary byte lifecycle.
    expect(direction === 'upload' ? store.getUploadSession('native-transfer') : store.getDownloadSession('native-transfer')).toBeNull();
    const operation = store.beginNativeSessionOperation(direction, 'native-transfer');
    expect(operation?.owner).toBe(owner);
    await store.cleanupExpired(Number.MAX_SAFE_INTEGER);
    expect(disposalStarted).toBe(false);
    operation?.release();
    let settled = false;
    const expired = store.cleanupExpired(Number.MAX_SAFE_INTEGER).then(() => { settled = true; });
    expect(disposalStarted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseClose();
    await expired;
    expect(settled).toBe(true);
    expect(pipe.writableEnded).toBe(true);
    expect(store.beginNativeSessionOperation(direction, 'native-transfer')).toBeNull();
    await store.dispose();
  });
});
