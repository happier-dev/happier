import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

type RpcHandler = (data: unknown) => Promise<unknown>;

describe('transfer lifecycle logging privacy', () => {
  const originalLogLevel = process.env.HAPPIER_LOG_LEVEL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'happier-transfer-log-privacy-'));
    process.env.HAPPIER_HOME_DIR = tempRoot;
    process.env.HAPPIER_LOG_LEVEL = 'debug';
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalLogLevel === undefined) {
      delete process.env.HAPPIER_LOG_LEVEL;
    } else {
      process.env.HAPPIER_LOG_LEVEL = originalLogLevel;
    }
    if (originalHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHomeDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('writes fixed transfer taxonomy and bounded facts without paths, capabilities, IDs, URLs, or raw errors', async () => {
    const [
      { registerTransferUploadRpcHandlers },
      { registerTransferDownloadRpcHandlers },
      { registerDownloadTransferLifecycleHandlers },
      { TransferSessionStore },
      { createTransferRecipientKeyPair },
      { RPC_METHODS },
      { logger },
    ] = await Promise.all([
      import('./registerTransferUploadRpcHandlers'),
      import('./registerTransferDownloadRpcHandlers'),
      import('./registerDownloadTransferLifecycleHandlers'),
      import('../core/transferSessionStore'),
      import('@/machines/transfer/transferChunkEncryption'),
      import('@happier-dev/protocol/rpc'),
      import('@/ui/logger'),
    ]);

    const workspace = join(tempRoot, 'workspace');
    const hostileDirectory = 'private-bearer-token-supersecret';
    const hostileUploadPath = `${hostileDirectory}/upload.txt`;
    const hostileDownloadPath = `${hostileDirectory}/download.txt`;
    const hostileUrl = 'https://user:supersecret@example.test/private?token=supersecret';
    const hostileError = `failed at ${join(workspace, hostileDownloadPath)} via ${hostileUrl}`;
    const hostilePayloadText = 'raw-payload-private-text';
    await mkdir(join(workspace, hostileDirectory), { recursive: true });
    await writeFile(join(workspace, hostileDownloadPath), 'download payload', 'utf8');

    const handlers = new Map<string, RpcHandler>();
    const rpcHandlerManager: RpcHandlerRegistrar = {
      registerHandler(method, handler) {
        handlers.set(method, handler as RpcHandler);
      },
    };
    const store = new TransferSessionStore({ ttlMs: 30_000 });
    let failingDownloadInitCount = 0;

    registerTransferUploadRpcHandlers(rpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });
    registerTransferDownloadRpcHandlers(rpcHandlerManager, {
      workingDirectory: workspace,
      store,
    });
    registerDownloadTransferLifecycleHandlers({
      rpcHandlerManager,
      store,
      methods: {
        init: 'privacy.download.init',
        chunk: 'privacy.download.chunk',
        finalize: 'privacy.download.finalize',
        abort: 'privacy.download.abort',
      },
      resolveInit: async () => {
        failingDownloadInitCount += 1;
        if (failingDownloadInitCount === 1) {
          throw new Error(hostileError);
        }
        throw {
          path: join(workspace, hostileDownloadPath),
          token: 'supersecret',
          url: hostileUrl,
          payload: hostilePayloadText,
        };
      },
      buildInitSuccessResponse: () => ({ success: false as const, error: 'Download init failed' }),
      buildInitErrorResponse: () => ({ success: false as const, error: 'Download init failed' }),
    });

    const uploadInit = handlers.get(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT);
    const downloadInit = handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const failingDownloadInit = handlers.get('privacy.download.init');
    if (!uploadInit || !downloadInit || !failingDownloadInit) {
      throw new Error('expected transfer init handlers');
    }

    const uploadResponse = await uploadInit({
      t: 'session_file_upload_v1',
      path: hostileUploadPath,
      sizeBytes: 0,
    }) as Readonly<{
      success: true;
      uploadId: string;
      recipientPublicKeyBase64: string;
    }>;
    expect(uploadResponse.success).toBe(true);

    const recipient = createTransferRecipientKeyPair();
    const downloadResponse = await downloadInit({
      t: 'session_file_download_v1',
      path: hostileDownloadPath,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as Readonly<{ success: true; downloadId: string }>;
    expect(downloadResponse.success).toBe(true);
    await expect(failingDownloadInit({})).resolves.toEqual({
      success: false,
      error: 'Download init failed',
    });
    await expect(failingDownloadInit({})).resolves.toEqual({
      success: false,
      error: 'Download init failed',
    });

    logger.flushSync();
    const log = await readFile(logger.getLogPath(), 'utf8');

    expect(log).toContain('transfer_upload_initialized');
    expect(log).toContain('transfer_download_initialized');
    expect(log).toContain('transfer_download_init_failed');
    expect(log).toContain('"transferKind":"session_file"');
    expect(log).toContain('"failureClass":"exception"');
    expect(log).toContain('"failureClass":"non_error_throwable"');

    for (const forbidden of [
      hostileUploadPath,
      hostileDownloadPath,
      hostileUrl,
      hostilePayloadText,
      'supersecret',
      uploadResponse.uploadId,
      uploadResponse.recipientPublicKeyBase64,
      downloadResponse.downloadId,
      recipient.recipientPublicKeyBase64,
    ]) {
      expect(log).not.toContain(forbidden);
    }
  });
});
