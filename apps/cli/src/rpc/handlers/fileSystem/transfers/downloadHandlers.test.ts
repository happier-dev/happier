import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';

import { configuration } from '@/configuration';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '@/transfers/policy/sessionRpcTransferPolicy';
import { registerBulkTransferDownloadRpcHandlers } from '@/transfers/rpc/registerBulkTransferDownloadRpcHandlers';

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

describe('file transfers (download)', () => {
  it('downloads a file in chunks', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');

    const bytes = await downloadAllChunks({ init, chunk, finalize, path: 'file.txt' });
    expect(bytes.toString('utf8')).toBe('hello\n');
  });

  it('downloads a directory as a zip and excludes configured top-level dirs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    mkdirSync(join(workspace, 'folder'), { recursive: true });
    writeFileSync(join(workspace, 'folder', 'hello.txt'), 'hello\n', 'utf8');
    mkdirSync(join(workspace, 'folder', '.git'), { recursive: true });
    writeFileSync(join(workspace, 'folder', '.git', 'config'), 'ignored\n', 'utf8');

    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE);
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
      const [{ configuration: localConfiguration }, { registerBulkTransferDownloadRpcHandlers: localRegisterDownload }] =
        await Promise.all([
          import('@/configuration'),
          import('@/transfers/rpc/registerBulkTransferDownloadRpcHandlers'),
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

      const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
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
    registerBulkTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, { workingDirectory: workspace, store });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE);
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
    registerBulkTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      sessionRpcTransferMaxBytes: 4,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    if (!init) throw new Error('expected download init handler');
    const recipientKeyPair = createTransferRecipientKeyPair();

    await expect(init({
      t: 'session_file_download_v1',
      path: 'file.txt',
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    })).resolves.toEqual({
      success: false,
      error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('fails closed when recipientPublicKeyBase64 is invalid (rejects at init instead of crashing during chunk encryption)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerBulkTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
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

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    if (!init) throw new Error('expected download init handler');
    const recipientKeyPair = createTransferRecipientKeyPair();

    await expect(init({
      t: 'session_file_download_v1',
      path: 'file.txt',
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    })).resolves.toEqual({
      success: false,
      error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
    });
  });

  it('allows downloads from additional allowed read dirs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-download-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'happier-files-download-external-'));
    const externalPath = join(externalRoot, 'note.txt');
    writeFileSync(externalPath, 'external\n', 'utf8');

    const store = new TransferSessionStore({ ttlMs: 1000 });
    const mgr = createRpcHandlerManager();
    registerBulkTransferDownloadRpcHandlers(mgr as unknown as RpcHandlerManager, {
      workingDirectory: workspace,
      store,
      getAdditionalAllowedReadDirs: () => [externalRoot],
    });

    const init = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
    const chunk = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = mgr.handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE);
    if (!init || !chunk || !finalize) throw new Error('expected download handlers');

    const bytes = await downloadAllChunks({ init, chunk, finalize, path: externalPath });
    expect(bytes.toString('utf8')).toBe('external\n');
  });
});
