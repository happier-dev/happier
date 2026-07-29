import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';

import { registerMachineDownloadTransferRpcHandlers } from './registerMachineDownloadTransferRpcHandlers';

type Handler = (data: unknown) => Promise<any>;

const METHODS = {
  init: 'test.machine.download.init',
  chunk: 'test.machine.download.chunk',
  finalize: 'test.machine.download.finalize',
  abort: 'test.machine.download.abort',
} as const;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('registerMachineDownloadTransferRpcHandlers lifecycle ownership', () => {
  it('disposes the default store it creates', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-machine-download-owned-'));

    try {
      const sourcePath = join(workspace, 'owned-download.txt');
      await writeFile(sourcePath, 'owned', 'utf8');
      const mgr = createRpcHandlerManager();
      const registration = registerMachineDownloadTransferRpcHandlers({
        rpcHandlerManager: mgr as any,
        methods: METHODS,
        parseRequest: (data) => data,
        resolveSource: async () => ({
          source: {
            filePath: sourcePath,
            deleteFileOnClose: true,
            sizeBytes: 5,
            name: 'owned-download.txt',
          },
        }),
        initFailureMessage: 'download failed',
      });
      const init = mgr.handlers.get(METHODS.init);
      if (!init) {
        throw new Error('expected init handler');
      }

      const recipient = createTransferRecipientKeyPair();
      const started = await init({ recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 });
      expect(started).toMatchObject({ success: true, downloadId: expect.any(String) });
      expect(registration.transferSessionStore.getDownloadSession(started.downloadId)).toBeTruthy();

      await registration.dispose();
      await registration.dispose();

      expect(registration.transferSessionStore.getDownloadSession(started.downloadId)).toBeNull();
      await expectPathMissing(sourcePath);
      await expect(registration.transferSessionStore.createDownloadSession({
        filePath: join(workspace, 'later.txt'),
        deleteFileOnClose: false,
        chunkSizeBytes: 1,
      })).rejects.toThrow('Transfer session store is disposed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('leaves an injected store caller-owned', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'happier-machine-download-injected-'));
    const store = new TransferSessionStore({ ttlMs: 10_000 });

    try {
      const sourcePath = join(workspace, 'injected-download.txt');
      await writeFile(sourcePath, 'injected', 'utf8');
      const mgr = createRpcHandlerManager();
      const registration = registerMachineDownloadTransferRpcHandlers({
        rpcHandlerManager: mgr as any,
        methods: METHODS,
        store,
        parseRequest: (data) => data,
        resolveSource: async () => ({
          source: {
            filePath: sourcePath,
            deleteFileOnClose: true,
            sizeBytes: 8,
            name: 'injected-download.txt',
          },
        }),
        initFailureMessage: 'download failed',
      });
      const init = mgr.handlers.get(METHODS.init);
      if (!init) {
        throw new Error('expected init handler');
      }

      const recipient = createTransferRecipientKeyPair();
      const started = await init({ recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 });
      expect(started).toMatchObject({ success: true, downloadId: expect.any(String) });
      expect(registration.transferSessionStore).toBe(store);

      await registration.dispose();

      expect(store.getDownloadSession(started.downloadId)).toBeTruthy();
      await expect(access(sourcePath)).resolves.toBeUndefined();

      await store.dispose();
      expect(store.getDownloadSession(started.downloadId)).toBeNull();
      await expectPathMissing(sourcePath);
    } finally {
      await store.dispose().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
