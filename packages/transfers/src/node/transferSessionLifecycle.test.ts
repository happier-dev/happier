import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTransferSessionLifecycle } from './transferSessionLifecycle.js';
import { TransferSessionStore } from './transferSessionStore.js';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';

it('retains the filesystem cause when writing an upload chunk fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-transfer-write-cause-'));
  const store = new TransferSessionStore({ ttlMs: 30_000 });
  const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
  try {
    const session = await lifecycle.openUploadTransferSession({ target: {
      destPath: join(directory, 'dest.bin'), destDisplayPath: 'dest.bin', expectedSizeBytes: 2, overwrite: false,
      finalizeUpload: async () => ({ success: true, path: 'dest.bin', sizeBytes: 2 }),
    } });
    expect(await lifecycle.writeUploadTransferChunk({ uploadId: session.uploadId, index: 0,
      contentBase64: Buffer.from('a').toString('base64') })).toEqual({ success: true });
    await session.file.close();
    const result = await lifecycle.writeUploadTransferChunk({ uploadId: session.uploadId, index: 1,
      contentBase64: Buffer.from('b').toString('base64') });
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    // EBADF is omitted by the existing closed diagnostic-code policy.
    expect(readActionOutputDiagnostic(result)).toMatchObject({ phase: 'transfer.upload.write_chunk',
      failureCause: { errorClass: 'Error', errorCode: null } });
    expect(JSON.stringify(readActionOutputDiagnostic(result))).not.toContain(directory);
    expect(session.receivedBytes).toBe(1);
  } finally {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a filesystem finalization code without disclosing its paths or exception message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-transfer-finalize-code-'));
  const store = new TransferSessionStore({ ttlMs: 30_000 });
  const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
  try {
    const control = await lifecycle.openUploadTransferSession({ target: {
      destPath: join(directory, 'dest.bin'), destDisplayPath: 'dest.bin', expectedSizeBytes: 0, overwrite: false,
      finalizeUpload: async ({ tempPath }) => {
        await copyFile(tempPath, join(directory, 'dest.bin'));
        return { success: true, path: 'dest.bin', sizeBytes: 0 };
      },
    } });
    expect(await lifecycle.finalizeUploadTransferSession({ uploadId: control.uploadId })).toMatchObject({ success: true });
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
    expect(readActionOutputDiagnostic(result)).toMatchObject({ phase: 'transfer.upload.finalize',
      failureCause: { errorClass: 'Error', errorCode: 'ENOENT' } });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(store.getUploadSession(session.uploadId)).toBeNull();
  } finally {
    await store.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
