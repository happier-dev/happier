import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransferSessionStore } from './transferSessionStore';

const rootsToRemove: string[] = [];

describe('TransferSessionStore temp-root ownership', () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(rootsToRemove.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }));
  });

  it('removes a dead-process root while preserving live-process and unowned roots', async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), 'happier-transfer-store-ownership-'));
    rootsToRemove.push(baseRoot);
    const deadProcessRoot = join(baseRoot, '2147483647-11111111-1111-4111-8111-111111111111');
    const liveProcessRoot = join(baseRoot, `${process.pid}-22222222-2222-4222-8222-222222222222`);
    const legacyUnownedRoot = join(baseRoot, '33333333-3333-4333-8333-333333333333');
    await Promise.all([deadProcessRoot, liveProcessRoot, legacyUnownedRoot].map(async (root) => {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'partial.upload'), 'partial', 'utf8');
    }));

    const store = new TransferSessionStore({ ttlMs: 30_000, tempRoot: baseRoot });
    await store.ensureTempRoot();

    await expect(access(deadProcessRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(liveProcessRoot)).resolves.toBeUndefined();
    await expect(access(legacyUnownedRoot)).resolves.toBeUndefined();

    await store.dispose();
  });

  it('reports the refreshed earliest inactive session expiry and ignores stale deadlines', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const baseRoot = await mkdtemp(join(tmpdir(), 'happier-transfer-store-expiry-'));
    rootsToRemove.push(baseRoot);
    const store = new TransferSessionStore({ ttlMs: 1_000, tempRoot: baseRoot });
    const createUpload = async (name: string) => await store.createUploadSession({
      destPath: join(baseRoot, `${name}.bin`),
      destDisplayPath: `${name}.bin`,
      overwrite: true,
      expectedSizeBytes: 4,
      finalizeUpload: async () => ({
        success: true as const,
        path: `${name}.bin`,
        sizeBytes: 4,
      }),
      chunkSizeBytes: 4,
      hash: createHash('sha256'),
    });

    try {
      const first = await createUpload('first');
      const firstPreparedExpiryAt = first.expiresAt;
      nowSpy.mockReturnValue(1_200);
      const second = await createUpload('second');
      nowSpy.mockReturnValue(1_500);
      store.refreshUploadExpiry(first.uploadId);

      expect(store.getNextExpiryAt()).toBe(second.expiresAt);
      store.cleanupExpiredBestEffort(firstPreparedExpiryAt);
      expect(store.getUploadSession(first.uploadId)).toBe(first);
      expect(store.getUploadSession(second.uploadId)).toBe(second);

      store.cleanupExpiredBestEffort(second.expiresAt);
      expect(store.getUploadSession(first.uploadId)).toBe(first);
      expect(store.getUploadSession(second.uploadId)).toBeNull();
      expect(store.getNextExpiryAt()).toBe(first.expiresAt);

      store.cleanupExpiredBestEffort(first.expiresAt);
      expect(store.getUploadSession(first.uploadId)).toBeNull();
      expect(store.getNextExpiryAt()).toBeNull();
    } finally {
      await store.dispose();
    }
  });
  it('retires an abandoned session on its own when it owns its expiry trigger', async () => {
    vi.useFakeTimers();
    const baseRoot = await mkdtemp(join(tmpdir(), 'happier-transfer-store-autoexpiry-'));
    rootsToRemove.push(baseRoot);
    const store = new TransferSessionStore({
      ttlMs: 1_000,
      tempRoot: baseRoot,
      expiryTrigger: 'self',
    });
    try {
      const sourcePath = join(baseRoot, 'artifact.wav');
      await writeFile(sourcePath, 'audio', 'utf8');
      const session = await store.createDownloadSession({
        filePath: sourcePath,
        deleteFileOnClose: false,
        chunkSizeBytes: 4,
      });
      expect(store.getDownloadSession(session.downloadId)).toBe(session);

      // No further RPC arrives: the client died right after init. Only the
      // store's own deadline can release the descriptor it is holding.
      await vi.advanceTimersByTimeAsync(1_500);
      await store.settleClosures();

      expect(store.getDownloadSession(session.downloadId)).toBeNull();
      await expect(session.file.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      vi.useRealTimers();
      await store.dispose();
    }
  });

  it('resolves cleanupExpired only after every expired descriptor is closed', async () => {
    const baseRoot = await mkdtemp(join(tmpdir(), 'happier-transfer-store-cleanup-await-'));
    rootsToRemove.push(baseRoot);
    const store = new TransferSessionStore({ ttlMs: 1_000, tempRoot: baseRoot });
    try {
      const sourcePath = join(baseRoot, 'artifact.wav');
      await writeFile(sourcePath, 'audio', 'utf8');
      const session = await store.createDownloadSession({
        filePath: sourcePath,
        deleteFileOnClose: true,
        chunkSizeBytes: 4,
      });

      await store.cleanupExpired(session.expiresAt);

      // Asserted with no intervening await: a caller that deletes retention's
      // files next relies on close-then-unlink having already completed when
      // cleanupExpired resolves, not merely having been started.
      expect(existsSync(sourcePath)).toBe(false);
      expect(store.getDownloadSession(session.downloadId)).toBeNull();
      await expect(session.file.stat()).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      await store.dispose();
    }
  });
});
