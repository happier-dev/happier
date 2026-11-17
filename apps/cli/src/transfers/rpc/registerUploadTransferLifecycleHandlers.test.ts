import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { logger } from '@/ui/logger';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { TransferSessionStore } from '@happier-dev/transfers/node';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';
import { uploadBytesViaLocalRpc } from './uploadComposerMediaStageViaLocalRpc';

describe('registerUploadTransferLifecycleHandlers (hardening)', () => {
  it.each(['registered', 'local', 'requester'] as const)('retains finalize diagnostics through the %s response builder and host log', async route => {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const rpcHandlerManager: RpcHandlerRegistrar = { registerHandler(method, handler) {
      handlers.set(method, handler as (data: unknown) => Promise<unknown>);
    } };
    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const directory = await mkdtemp(join(tmpdir(), 'happier-upload-finalize-cause-'));
    const logged = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      let fail = false;
      const methods = { init: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, chunk: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
        finalize: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, abort: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT };
      const rpc = registerUploadTransferLifecycleHandlers({ rpcHandlerManager, store,
        methods, enableChunkEncryption: route === 'requester',
        resolveInit: async () => ({ kind: 'accepted', diagnosticContext: { transferKind: 'session_file' },
          target: { destPath: join(directory, 'dest.bin'), destDisplayPath: 'dest.bin', expectedSizeBytes: 0, overwrite: false,
            finalizeUpload: async ({ tempPath }) => {
              await copyFile(tempPath, join(directory, ...(fail ? ['missing', 'dest.bin'] : ['dest.bin'])));
              return { success: true, path: 'dest.bin', sizeBytes: 0 };
            } } }),
        buildInitSuccessResponse: ({ session }) => ({ success: true, uploadId: session.uploadId,
          chunkSizeBytes: session.chunkSizeBytes, recipientPublicKeyBase64: session.recipientPublicKeyBase64 }),
        buildFinalizeMissingUploadIdResponse: () => ({ success: false }),
        buildFinalizeMissingSessionResponse: () => ({ success: false }),
        buildFinalizeSizeMismatchResponse: () => ({ success: false }),
        buildFinalizeHashMismatchResponse: () => ({ success: false }),
        buildFinalizeErrorResponse: () => ({ success: false }),
        buildFinalizeFailureResponse: (_error, errorCode) => ({ success: false, errorCode }),
        buildFinalizeSuccessResponse: () => ({ success: true }),
      });
      const invoke = async (method: string, data: unknown) => route === 'local'
        ? rpc.invokeLocal(method, data) : handlers.get(method)!(data);
      const upload = async () => {
        if (route === 'requester') return await uploadBytesViaLocalRpc({ rpc, bytes: new Uint8Array(0), initRequest: {} });
        const init = await invoke(methods.init, {}) as { uploadId: string };
        return await invoke(methods.finalize, { uploadId: init.uploadId });
      };
      expect(await upload()).toEqual(route === 'requester' ? { success: true, response: { success: true } } : { success: true });
      fail = true;
      const result = await upload();
      expect(result).toEqual(route === 'requester' ? { success: false, code: 'transfer_failed' } : { success: false, errorCode: 'ENOENT' });
      expect.soft(readActionOutputDiagnostic(result)).toMatchObject({ phase: 'transfer.upload.finalize',
        failureCause: { errorClass: 'Error', errorCode: 'ENOENT' } });
      expect.soft(logged).toHaveBeenCalledOnce();
      expect.soft(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        phase: 'transfer.upload.finalize', errorClass: 'Error', errorCode: 'ENOENT',
      }));
      expect(JSON.stringify([result, logged.mock.calls])).not.toContain(directory);
    } finally {
      logged.mockRestore();
      await store.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps chunk retries idempotent and logs the closed cause of a failed write', async () => {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler as (data: unknown) => Promise<unknown>);
      },
    };

    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-upload-idempotency-test-'));
    const logged = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      registerUploadTransferLifecycleHandlers({
        rpcHandlerManager,
        store,
        methods: { init: 'init', chunk: 'chunk', finalize: 'finalize', abort: 'abort' },
        resolveInit: async () => ({ kind: 'rejected', response: { ok: false } }),
        buildInitSuccessResponse: () => ({ ok: true }),
        buildFinalizeMissingUploadIdResponse: () => ({ ok: false }),
        buildFinalizeMissingSessionResponse: () => ({ ok: false }),
        buildFinalizeSizeMismatchResponse: () => ({ ok: false }),
        buildFinalizeHashMismatchResponse: () => ({ ok: false }),
        buildFinalizeErrorResponse: () => ({ ok: false }),
        buildFinalizeFailureResponse: () => ({ ok: false }),
        buildFinalizeSuccessResponse: () => ({ ok: true }),
      });

      const session = await store.createUploadSession({
        destPath: join(tempDir, 'dest.bin'),
        destDisplayPath: 'dest.bin',
        overwrite: true,
        expectedSizeBytes: 4,
        finalizeUpload: async () => ({ success: true, path: join(tempDir, 'dest.bin'), sizeBytes: 0 }),
        chunkSizeBytes: 2,
        hash: createHash('sha256'),
      });

      const chunkHandler = handlers.get('chunk');
      expect(chunkHandler).toBeTruthy();

      const base64 = Buffer.from('ab', 'utf8').toString('base64');
      await expect(chunkHandler?.({ uploadId: session.uploadId, index: 0, contentBase64: base64 })).resolves.toEqual({ success: true });
      expect(session.nextIndex).toBe(1);
      expect(session.receivedBytes).toBe(2);

      await expect(chunkHandler?.({ uploadId: session.uploadId, index: 0 })).resolves.toEqual({ success: true });
      expect(session.nextIndex).toBe(1);
      expect(session.receivedBytes).toBe(2);

      await session.file.close();
      const result = await chunkHandler?.({ uploadId: session.uploadId, index: 1,
        contentBase64: Buffer.from('cd').toString('base64') });
      expect(result).toMatchObject({ success: false, error: expect.any(String) });
      // EBADF is omitted by the existing closed diagnostic-code policy.
      expect.soft(readActionOutputDiagnostic(result)).toMatchObject({ phase: 'transfer.upload.write_chunk',
        failureCause: { errorClass: 'Error', errorCode: null } });
      expect.soft(logged).toHaveBeenCalledOnce();
      expect.soft(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        phase: 'transfer.upload.write_chunk', errorClass: 'Error', errorCode: null,
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain(tempDir);
    } finally {
      logged.mockRestore();
      await store.dispose();
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects encrypted chunks that exceed size limits before attempting to decrypt them', async () => {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler as (data: unknown) => Promise<unknown>);
      },
    };

    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-upload-hardening-test-'));
    try {
      registerUploadTransferLifecycleHandlers({
        rpcHandlerManager,
        store,
        methods: { init: 'init', chunk: 'chunk', finalize: 'finalize', abort: 'abort' },
        resolveInit: async () => ({ kind: 'rejected', response: { ok: false } }),
        buildInitSuccessResponse: () => ({ ok: true }),
        buildFinalizeMissingUploadIdResponse: () => ({ ok: false }),
        buildFinalizeMissingSessionResponse: () => ({ ok: false }),
        buildFinalizeSizeMismatchResponse: () => ({ ok: false }),
        buildFinalizeHashMismatchResponse: () => ({ ok: false }),
        buildFinalizeErrorResponse: () => ({ ok: false }),
        buildFinalizeFailureResponse: () => ({ ok: false }),
        buildFinalizeSuccessResponse: () => ({ ok: true }),
      });

      const session = await store.createUploadSession({
        destPath: join(tempDir, 'dest.bin'),
        destDisplayPath: 'dest.bin',
        overwrite: true,
        expectedSizeBytes: 1024,
        finalizeUpload: async () => ({ success: true, path: join(tempDir, 'dest.bin'), sizeBytes: 0 }),
        chunkSizeBytes: 1,
        recipientSecretKeySeed: new Uint8Array(32).fill(9),
        recipientPublicKeyBase64: Buffer.alloc(32, 1).toString('base64'),
        hash: createHash('sha256'),
      });

      const chunkHandler = handlers.get('chunk');
      expect(chunkHandler).toBeTruthy();

      const oversizedBase64 = 'A'.repeat(4096); // valid base64 chars; massive decoded payload
      const response = await chunkHandler?.({
        uploadId: session.uploadId,
        index: 0,
        payloadBase64: oversizedBase64,
        encryptedDataKeyEnvelopeBase64: oversizedBase64,
      });

      expect(response).toEqual({ success: false, error: 'Chunk exceeds configured chunk size' });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
