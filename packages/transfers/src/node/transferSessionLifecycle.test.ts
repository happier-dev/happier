import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTransferSessionLifecycle } from './transferSessionLifecycle.js';
import { TransferSessionStore } from './transferSessionStore.js';

it('keeps a filesystem finalization code without disclosing its paths or exception message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-transfer-finalize-code-'));
  const store = new TransferSessionStore({ ttlMs: 30_000 });
  const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
  try {
    const session = await lifecycle.openUploadTransferSession({ target: {
      destPath: join(directory, 'missing', 'dest.bin'), destDisplayPath: 'dest.bin',
      expectedSizeBytes: 0, overwrite: false,
      finalizeUpload: async ({ tempPath }) => {
        await copyFile(tempPath, join(directory, 'missing', 'dest.bin'));
        return { success: true, path: 'dest.bin', sizeBytes: 0 };
      },
    } });
    const result = await lifecycle.finalizeUploadTransferSession({ uploadId: session.uploadId });
    expect(result).toEqual({ success: false, error: 'Failed to finalize upload', errorCode: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(store.getUploadSession(session.uploadId)).toBeNull();
  } finally {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
