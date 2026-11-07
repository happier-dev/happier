import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';

import { registerSessionTransferRpcHandlers } from './registerSessionTransferRpcHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('registerSessionTransferRpcHandlers lifecycle ownership', () => {
  it('returns an authenticated Tailnet link for an authorised file without starting a chunk transfer', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-direct-download-'));
    const configPath = join(workspace, 'file-service.json');
    await writeFile(join(workspace, 'report #1%.pdf'), 'download me');
    await writeFile(configPath, JSON.stringify({ origin: 'https://files.example.ts.net:9443', roots: { projects: workspace } }));
    vi.stubEnv('HAPPIER_FILES_DOWNLOAD_LINK_CONFIG', configPath);
    const { handlers, registrar } = createRegistrar();
    const registration = registerSessionTransferRpcHandlers(registrar, { workingDirectory: workspace });
    try {
      const handler = handlers.get('daemon.bulkTransfer.download.url');
      expect(handler).toBeDefined();
      expect(await handler!({ path: 'report #1%.pdf' })).toEqual({
        success: true, name: 'report #1%.pdf',
        url: 'https://files.example.ts.net:9443/browse/projects/report%20%231%25.pdf?download=1',
      });
    } finally {
      vi.unstubAllEnvs();
      await registration.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('preserves the service scope and filesystem policy, including missing-service fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-direct-download-scope-'));
    const configPath = join(workspace, 'file-service.json');
    const served = join(workspace, 'served');
    await mkdir(served);
    await writeFile(join(served, 'source.txt'), 'download me');
    await writeFile(join(workspace, 'outside.txt'), 'not served');
    await writeFile(configPath, JSON.stringify({ origin: 'https://files.example.ts.net:9443', roots: { projects: served } }));
    vi.stubEnv('HAPPIER_FILES_DOWNLOAD_LINK_CONFIG', configPath);
    const { handlers, registrar } = createRegistrar();
    const registration = registerSessionTransferRpcHandlers(registrar, {
      workingDirectory: workspace, accessPolicy: { kind: 'restrictedRoots', roots: [served] },
    });
    try {
      const handler = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_URL)!;
      expect(await handler({ path: 'outside.txt' })).toMatchObject({ success: false });
      expect(await handler({ path: 'served/source.txt', asZip: true })).toEqual({ success: true, url: null });
      await link(join(served, 'source.txt'), join(served, 'hardlink.txt'));
      expect(await handler({ path: 'served/hardlink.txt' })).toMatchObject({ success: true, url: null });
      await writeFile(join(served, 'single.txt'), 'download me');
      if (process.platform !== 'win32') {
        await symlink(join(served, 'single.txt'), join(served, 'symlink.txt'));
        expect(await handler({ path: 'served/symlink.txt' })).toMatchObject({ success: true, url: null });
      }
      vi.stubEnv('HAPPIER_FILES_DOWNLOAD_LINK_CONFIG', join(workspace, 'absent.json'));
      expect(await handler({ path: 'served/single.txt' })).toMatchObject({ success: true, url: null });
      vi.stubEnv('HAPPIER_FILES_DOWNLOAD_LINK_CONFIG', configPath);
      await writeFile(configPath, JSON.stringify({ origin: 'http://files.example.ts.net:9443', roots: { projects: served } }));
      expect(await handler({ path: 'served/single.txt' })).toMatchObject({ success: false });
    } finally {
      vi.unstubAllEnvs();
      await registration.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('does not dispose a caller-owned injected store', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-transfer-injected-store-'));
    const { registrar } = createRegistrar();
    const store = new TransferSessionStore({ ttlMs: 1000 });

    try {
      const registration = registerSessionTransferRpcHandlers(registrar, {
        workingDirectory: workspace,
        store,
      });

      await registration.dispose();

      await expect(store.ensureTempRoot()).resolves.toBeUndefined();
    } finally {
      await store.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('disposes abandoned upload and download resources for the default store path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-transfer-registration-'));
    const { handlers, registrar } = createRegistrar();

    try {
      const registration = registerSessionTransferRpcHandlers(registrar, {
        workingDirectory: workspace,
      });

      const uploadInit = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
      const downloadInit = handlers.get(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT);
      if (!uploadInit || !downloadInit) {
        throw new Error('expected transfer init handlers');
      }

      const uploadInitResult = await uploadInit({
        t: 'session_file_upload_v1',
        path: 'abandoned-upload.txt',
        sizeBytes: 4,
        overwrite: false,
      });
      expect(uploadInitResult).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadId = (uploadInitResult as { uploadId: string }).uploadId;
      const uploadSession = registration.transferSessionStore.getUploadSession(uploadId);
      expect(uploadSession).toBeTruthy();
      const uploadTempPath = uploadSession?.tempPath ?? '';
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const downloadDir = join(workspace, 'download-dir');
      await mkdir(downloadDir, { recursive: true });
      await writeFile(join(downloadDir, 'source.txt'), 'download me', 'utf8');
      const recipient = createTransferRecipientKeyPair();
      const downloadInitResult = await downloadInit({
        t: 'session_file_download_v1',
        path: 'download-dir',
        asZip: true,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(downloadInitResult).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadId = (downloadInitResult as { downloadId: string }).downloadId;
      const downloadSession = registration.transferSessionStore.getDownloadSession(downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession?.filePath ?? '';
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await registration.dispose();
      await registration.dispose();

      expect(registration.transferSessionStore.getUploadSession(uploadId)).toBeNull();
      expect(registration.transferSessionStore.getDownloadSession(downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
