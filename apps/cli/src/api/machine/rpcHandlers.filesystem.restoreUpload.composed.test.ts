import { createNativeFilesystemMemberFixture, nativeFilesystemMemberBoundary, assertNativeInvocation, resetNativeFilesystemMemberBoundary } from './filesystemMemberReceiver.testkit';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';

const nativeOs = nativeFilesystemMemberBoundary();

const cleanups: Array<() => void | Promise<void>> = [];
async function cleanupFixture(): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  resetNativeFilesystemMemberBoundary();
  if (failures.length) throw new AggregateError(failures, 'Requester fixture cleanup failed');
}
afterAll(cleanupFixture);

// Cold source loading belongs to fixture setup, outside the operation budget.
// Keep the real child import after the production requester frame/environment.
const setup = process.platform === 'linux' ? await (async () => {
  try {
    const f = await createNativeFilesystemMemberFixture({ registerCleanup: cleanup => cleanups.push(cleanup) });
    const bytes = Buffer.concat([Buffer.from('PGDMP'), Buffer.from([0, 255, 128]), Buffer.from('requester-owned-restore')]);
    const opened = z.object({ success: z.literal(true), uploadId: z.string(), recipientPublicKeyBase64: z.string() })
      .parse(await f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      { t: 'deployment_restore_upload_v1', environmentId: 'environment', sizeBytes: bytes.length }));
    return { f, bytes, opened };
  } catch (error) {
    try { await cleanupFixture(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Requester fixture startup failed');
    }
    throw error;
  }
})() : null;

describe.skipIf(process.platform !== 'linux')('completed restore upload requester custody', () => {
  it('lends completed restore bytes through the actual requester child when daemon scratch reads are denied', async () => {
    if (!setup) throw new Error('Linux requester fixture was not initialized');
    const { f, bytes, opened } = setup;
    const encrypted = createEncryptedTransferChunkEnvelope({ transferId: opened.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: opened.recipientPublicKeyBase64 });
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: opened.uploadId, index: 0,
      payloadBase64: encrypted.payloadBase64, encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 }))
      .resolves.toMatchObject({ success: true });
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: opened.uploadId }))
      .resolves.toMatchObject({ success: true, transferId: opened.uploadId });
    const admitted = await f.machine.acquireDeploymentRestoreUpload({ transferId: opened.uploadId, environmentId: 'environment' },
      { runtimeAccountId: 'member-a' });
    if (!admitted) throw new Error('Requester source was not retained');
    nativeOs.daemonUnreadableSource = admitted.source.filePath;
    try {
      // This is the real topology consequence of requester0700 scratch. Only
      // the OS boundary denies the parent; the real child channel lends bytes.
      await expect(readFile(admitted.source.filePath)).rejects.toMatchObject({ code: 'EACCES' });
      expect(await admitted.source.readChunk({ offset: 0, length: bytes.length })).toEqual(bytes);
      expect(f.children[0]?.exitCode).toBeNull();
    } finally { admitted.release(); nativeOs.daemonUnreadableSource = undefined; }
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: opened.uploadId }))
      .resolves.toMatchObject({ success: true });
    assertNativeInvocation(f);
    expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  }, 120_000);
});
