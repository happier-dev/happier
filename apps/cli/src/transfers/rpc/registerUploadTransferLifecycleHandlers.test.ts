import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { TransferSessionStore } from '../core/transferSessionStore';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';

describe('registerUploadTransferLifecycleHandlers (hardening)', () => {
  it('treats already-written chunk indices as idempotent success (supports route fallback retries)', async () => {
    const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler as (data: unknown) => Promise<unknown>);
      },
    };

    const store = new TransferSessionStore({ ttlMs: 30_000 });
    const tempDir = await mkdtemp(join(tmpdir(), 'happier-upload-idempotency-test-'));
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
    } finally {
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
