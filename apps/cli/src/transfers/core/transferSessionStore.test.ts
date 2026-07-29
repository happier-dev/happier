import { createHash } from 'node:crypto';
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
});
