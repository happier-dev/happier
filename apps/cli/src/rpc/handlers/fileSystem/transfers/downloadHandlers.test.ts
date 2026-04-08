import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';

import { configuration } from '@/configuration';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '@/transfers/policy/serverRoutedTransferPolicy';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';

type Handler = (data: any) => Promise<any>;

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

async function downloadAllChunks(input: {
  init: Handler;
  chunk: Handler;
  finalize: Handler;
  path: string;
  asZip?: boolean;
}): Promise<Buffer> {
  const recipientKeyPair = createTransferRecipientKeyPair();
  const initResp = await input.init({
    t: 'session_file_download_v1',
    path: input.path,
    asZip: input.asZip,
    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
  });
  expect(initResp).toMatchObject({ success: true });

  const downloadId = initResp.downloadId;
  const chunks: Buffer[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const res = await input.chunk({ downloadId, index });
    expect(res).toMatchObject({ success: true });
    chunks.push(decryptEncryptedTransferChunkEnvelope({
      transferId: downloadId,
      sequence: index,
      payloadBase64: res.payloadBase64 as string,
      encryptedDataKeyEnvelopeBase64: res.encryptedDataKeyEnvelopeBase64 as string,
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
    }));
    if (res.isLast) break;
  }
  await input.finalize({ downloadId });
  return Buffer.concat(chunks);
}

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

describe('file transfers (download)', () => {
  it('downloads a file in chunks', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');

    const bytes = await downloadAllChunks({ init, chunk, finalize, path: 'file.txt' });
    expect(bytes.toString('utf8')).toBe('hello\n');
  });

  it('allows downloading an os_temp attachment uploaded through registerFileSystemHandlers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const uploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const uploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK);
    const uploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE);
    const downloadInit = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const downloadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const downloadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!uploadInit || !uploadChunk || !uploadFinalize || !downloadInit || !downloadChunk || !downloadFinalize) {
      throw new Error('expected upload and download handlers');
    }

    const uploadInitResp = await uploadInit({
      t: 'session_attachment_upload_v1',
      messageLocalId: 'message-1',
      fileName: 'note.txt',
      sizeBytes: 3,
      uploadLocation: 'os_temp',
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
    });
    expect(uploadInitResp).toMatchObject({ success: true, recipientPublicKeyBase64: expect.any(String) });

    await expect(uploadChunk(createEncryptedUploadChunkRequest({
      uploadId: uploadInitResp.uploadId,
      index: 0,
      payload: Buffer.from('hey', 'utf8'),
      recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
    }))).resolves.toEqual({ success: true });

    const uploadFinalizeResp = await uploadFinalize({ uploadId: uploadInitResp.uploadId });
    expect(uploadFinalizeResp).toMatchObject({ success: true });

    const recipientKeyPair = createTransferRecipientKeyPair();
    const downloadInitResp = await downloadInit({
      t: 'session_file_download_v1',
      path: uploadFinalizeResp.path,
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    expect(downloadInitResp).toMatchObject({ success: true });

    const downloadChunkResp = await downloadChunk({ downloadId: downloadInitResp.downloadId, index: 0 });
    expect(downloadChunkResp).toMatchObject({ success: true, isLast: true });
    expect(decryptEncryptedTransferChunkEnvelope({
      transferId: downloadInitResp.downloadId,
      sequence: 0,
      payloadBase64: downloadChunkResp.payloadBase64 as string,
      encryptedDataKeyEnvelopeBase64: downloadChunkResp.encryptedDataKeyEnvelopeBase64 as string,
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
    }).toString('utf8')).toBe('hey');

    await expect(downloadFinalize({ downloadId: downloadInitResp.downloadId })).resolves.toEqual({ success: true });
  });

  it('downloads a directory as a zip and excludes configured top-level dirs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    mkdirSync(join(workspace, 'folder'), { recursive: true });
    writeFileSync(join(workspace, 'folder', 'hello.txt'), 'hello\n', 'utf8');
    mkdirSync(join(workspace, 'folder', '.git'), { recursive: true });
    writeFileSync(join(workspace, 'folder', '.git', 'config'), 'ignored\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');

    const bytes = await downloadAllChunks({ init, chunk, finalize, path: 'folder', asZip: true });
    expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(bytes.toString('utf8')).toContain('hello.txt');
    expect(bytes.toString('utf8')).not.toContain('.git/');
  });

  it('removes temp zip files when archive creation fails before a download session opens', async () => {
    const previousMaxEntryCount = process.env.HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT;
    process.env.HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT = '5';
    try {
      // This test must not scale with production defaults (10k entries), otherwise it can
      // time out on slower filesystems. Reload configuration-sensitive modules with the
      // smaller limit so the failure path remains deterministic and fast.
      vi.resetModules();
      const [{ configuration: localConfiguration }, { registerTransferDownloadRpcHandlers: localRegisterDownload }] =
        await Promise.all([
          import('@/configuration'),
          import('@/transfers/rpc/registerTransferDownloadRpcHandlers'),
        ]);

      const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
      mkdirSync(join(workspace, 'folder'), { recursive: true });
      for (let index = 0; index <= localConfiguration.filesZipMaxEntryCount; index += 1) {
        writeFileSync(join(workspace, 'folder', `file-${index}.txt`), `file-${index}\n`, 'utf8');
      }

      const store = new TransferSessionStore({ ttlMs: 1000 });
      const mgr = createRpcHandlerManager();
      localRegisterDownload(mgr as unknown as RpcHandlerManager, {
        workingDirectory: workspace,
        store,
      });

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
      if (!init) throw new Error('expected download init handler');
      const recipientKeyPair = createTransferRecipientKeyPair();

      const zipDir = join(tmpdir(), 'happier', 'file-zips');
      mkdirSync(zipDir, { recursive: true });
      const beforeEntries = new Set(readdirSync(zipDir));

      await expect(init({
        t: 'session_file_download_v1',
        path: 'folder',
        asZip: true,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
      })).resolves.toEqual({
        success: false,
        error: 'Zip exceeds entry count limit',
      });

      const afterEntries = readdirSync(zipDir).filter((entry) => !beforeEntries.has(entry));
      expect(afterEntries).toEqual([]);
    } finally {
      if (previousMaxEntryCount === undefined) {
        delete process.env.HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT;
      } else {
        process.env.HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT = previousMaxEntryCount;
      }
    }
  });

  it('refreshes download session expiry on chunk progress so long downloads use idle timeout semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    const content = Buffer.concat([Buffer.alloc(configuration.filesTransferChunkBytes, 'a'), Buffer.from('b')]);
    writeFileSync(join(workspace, 'file.bin'), content);

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, { workingDirectory: workspace, store });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');
    const recipientKeyPair = createTransferRecipientKeyPair();

    const initResp = await init({
      t: 'session_file_download_v1',
      path: 'file.bin',
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    expect(initResp).toMatchObject({ success: true });

    const downloadId = initResp.downloadId;
    vi.setSystemTime(900);
    expect(await chunk({ downloadId, index: 0 })).toMatchObject({ success: true, isLast: false });

    vi.setSystemTime(1500);
    expect(await chunk({ downloadId, index: 1 })).toMatchObject({ success: true, isLast: true });

    vi.setSystemTime(2400);
    expect(await finalize({ downloadId })).toMatchObject({ success: true });
  });

  it('rejects session-routed downloads that exceed the advertised server-routed size limit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      sessionRpcTransferMaxBytes: 4,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    if (!init) throw new Error('expected download init handler');
    const recipientKeyPair = createTransferRecipientKeyPair();

    await expect(init({
      t: 'session_file_download_v1',
      path: 'file.txt',
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    })).resolves.toEqual({
      success: false,
      error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('fails closed when recipientPublicKeyBase64 is invalid (rejects at init instead of crashing during chunk encryption)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    if (!init) throw new Error('expected download init handler');

    await expect(init({
      t: 'session_file_download_v1',
      path: 'file.txt',
      recipientPublicKeyBase64: 'not-base64',
    })).resolves.toEqual({
      success: false,
      error: 'Invalid transfer recipient public key',
    });
  });

  it('rejects downloads that exceed the advertised server-routed size limit when registered via registerFileSystemHandlers (no bypass)', async () => {
    vi.stubEnv('HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES', '4');

    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    if (!init) throw new Error('expected download init handler');
    const recipientKeyPair = createTransferRecipientKeyPair();

    await expect(init({
      t: 'session_file_download_v1',
      path: 'file.txt',
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    })).resolves.toEqual({
      success: false,
      error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('allows downloads from additional allowed read dirs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'happier-files-download-external-'));
    const externalPath = join(externalRoot, 'note.txt');
    writeFileSync(externalPath, 'external\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      getAdditionalAllowedReadDirs: () => [externalRoot],
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');

    const bytes = await downloadAllChunks({ init, chunk, finalize, path: externalPath });
    expect(bytes.toString('utf8')).toBe('external\n');
  });
});
