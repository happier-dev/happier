import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';

import { registerSessionHandlers } from './registerSessionHandlers';

function createEncryptedUploadChunkRequest(input: Readonly<{
  uploadId: string;
  index: number;
  payload: Buffer;
  recipientPublicKeyBase64: string;
}>) {
  const encryptedChunk = createEncryptedTransferChunkEnvelope({
    transferId: input.uploadId,
    sequence: input.index,
    payload: input.payload,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
  });

  return {
    uploadId: input.uploadId,
    index: input.index,
    payloadBase64: encryptedChunk.payloadBase64,
    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
  };
}

describe('registerSessionHandlers attachments uploads', () => {
  let workingDirectory: string;

  beforeEach(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), 'happier-attachments-'));
  });

  afterEach(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('registers workspace attachment uploads without a separate configure RPC', async () => {
    const handlers = new Map<string, RpcHandler>();
    const mgr: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    };

    registerSessionHandlers(mgr, workingDirectory);

    const init = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init) {
      throw new Error('expected attachment upload init handler to be registered');
    }
    if (!chunk || !finalize) {
      throw new Error('expected attachment upload lifecycle handlers to be registered');
    }

    const initResult: any = await init({
      t: 'session_attachment_upload_v1',
      messageLocalId: 'message-1',
      fileName: 'file.txt',
      sizeBytes: 11,
      uploadLocation: 'workspace',
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
    });
    expect(initResult).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    expect(await chunk(createEncryptedUploadChunkRequest({
      uploadId: initResult.uploadId,
      index: 0,
      payload: Buffer.from('hello world', 'utf8'),
      recipientPublicKeyBase64: initResult.recipientPublicKeyBase64,
    }))).toEqual({ success: true });

    const finalizeResult: any = await finalize({ uploadId: initResult.uploadId });
    expect(finalizeResult).toMatchObject({
      success: true,
      path: expect.stringMatching(/^\.happier\/uploads\/messages\/message-1\/[0-9a-f]{8}-file\.txt$/),
      sizeBytes: 11,
      sha256: expect.any(String),
    });
    expect(await readFile(join(workingDirectory, finalizeResult.path), 'utf8')).toBe('hello world');
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.init'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.chunk'].join(''))).toBe(false);
    expect(handlers.has(['daemon.sessionAttachments.', 'upload.finalize'].join(''))).toBe(false);
  });
});
