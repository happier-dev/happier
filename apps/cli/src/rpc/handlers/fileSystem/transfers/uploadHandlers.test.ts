import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdtempSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '@/transfers/policy/sessionRpcTransferPolicy';
import { registerBulkTransferUploadRpcHandlers } from '@/transfers/rpc/registerBulkTransferUploadRpcHandlers';

type Handler = (data: any) => Promise<any>;
type UploadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getUploadSession']>>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

describe('file transfers (upload)', () => {
  it('uploads a file in chunks and creates parent directories', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'hello world\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'nested/hello.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: false,
    });

    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));

    const done = await finalize({ uploadId });
    expect(done).toMatchObject({ success: true, sizeBytes: Buffer.byteLength(content) });
    expect(readFileSync(join(workspace, 'nested', 'hello.txt'), 'utf8')).toBe(content);
  });

  it('supports overwriting an existing file when overwrite=true', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    writeFileSync(join(workspace, 'file.txt'), 'old\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'new\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'file.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: true,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));
    const done = await finalize({ uploadId });
    expect(done).toMatchObject({ success: true });
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe(content);
  });

  it('rejects directory collision even when overwrite=true without deleting the existing directory tree', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    mkdirSync(join(workspace, 'existingdir', 'nested'), { recursive: true });
    writeFileSync(join(workspace, 'existingdir', 'nested', 'keep.txt'), 'important\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'file\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'existingdir',
      sizeBytes: Buffer.byteLength(content),
      overwrite: true,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));
    const done = await finalize({ uploadId });

    expect(done).toMatchObject({ success: false });
    expect(done.error).toMatch(/directory/i);

    // Verify directory and its contents are preserved
    expect(statSync(join(workspace, 'existingdir')).isDirectory()).toBe(true);
    expect(readFileSync(join(workspace, 'existingdir', 'nested', 'keep.txt'), 'utf8')).toBe('important\n');
  });

  it('refreshes upload session expiry on chunk progress so long uploads use idle timeout semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerBulkTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, { workingDirectory: workspace, store });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const firstChunk = Buffer.alloc(configuration.filesTransferChunkBytes, 'a');
    const secondChunk = Buffer.from('b');
    const content = Buffer.concat([firstChunk, secondChunk]);

    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'slow.bin',
      sizeBytes: content.length,
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    vi.setSystemTime(900);
    expect(await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: firstChunk,
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }))).toMatchObject({ success: true });

    vi.setSystemTime(1500);
    expect(await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 1,
      payload: secondChunk,
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }))).toMatchObject({ success: true });

    vi.setSystemTime(2400);
    expect(await finalize({ uploadId })).toMatchObject({ success: true, sizeBytes: content.length });
  });

  it('rejects malformed base64 chunks instead of silently decoding corrupted bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    if (!init || !chunk) throw new Error('expected upload handlers');

    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'broken.txt',
      sizeBytes: 3,
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(chunk({
      uploadId: initResp.uploadId,
      index: 0,
      payloadBase64: 'Zm9v*',
      encryptedDataKeyEnvelopeBase64: 'also-invalid',
    })).resolves.toEqual({
      success: false,
      error: `Invalid encrypted transfer data key for ${initResp.uploadId}`,
    });
  });

  it('keeps the upload session recoverable after finalize conflict so finalize can retry without re-uploading', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    writeFileSync(join(workspace, 'file.txt'), 'old\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerBulkTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected upload handlers');

    const content = 'new\n';
    const initResp = await init({
      t: 'session_file_upload_v1',
      path: 'file.txt',
      sizeBytes: Buffer.byteLength(content),
      overwrite: false,
    });
    expect(initResp).toMatchObject({
      success: true,
      recipientPublicKeyBase64: expect.any(String),
    });

    const uploadId = initResp.uploadId;
    await chunk(createEncryptedUploadChunkRequest({
      uploadId,
      index: 0,
      payload: Buffer.from(content, 'utf8'),
      recipientPublicKeyBase64: initResp.recipientPublicKeyBase64,
    }));

    const firstFinalize = await finalize({ uploadId });
    expect(firstFinalize).toMatchObject({ success: false });
    expect(firstFinalize.error).toMatch(/exists/i);
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe('old\n');
    const pending = store.getUploadSession(uploadId) as UploadSessionHandle | null;
    expect(pending).not.toBeNull();
    expect(pending?.file.fd).toBe(-1);
    expect(statSync(pending!.tempPath).isFile()).toBe(true);

    unlinkSync(join(workspace, 'file.txt'));

    const retryFinalize = await finalize({ uploadId });
    expect(retryFinalize).toMatchObject({ success: true, sizeBytes: Buffer.byteLength(content) });
    expect(readFileSync(join(workspace, 'file.txt'), 'utf8')).toBe(content);
  });

  it('rejects session-routed uploads that exceed the advertised server-routed size limit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerBulkTransferUploadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      sessionRpcTransferMaxBytes: 4,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    if (!init) throw new Error('expected upload init handler');

    await expect(
      init({
        t: 'session_file_upload_v1',
        path: 'too-large.txt',
        sizeBytes: 5,
        overwrite: false,
      }),
    ).resolves.toEqual({
      success: false,
      error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('rejects uploads that exceed the advertised server-routed size limit when registered via registerFileSystemHandlers (no bypass)', async () => {
    vi.stubEnv('HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES', '4');

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-upload-'));
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
    if (!init) throw new Error('expected upload init handler');

    await expect(
      init({
        t: 'session_file_upload_v1',
        path: 'too-large.txt',
        sizeBytes: 5,
        overwrite: false,
      }),
    ).resolves.toEqual({
      success: false,
      error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });
});
