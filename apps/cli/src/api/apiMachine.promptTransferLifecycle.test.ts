import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

type RpcInvoker = Readonly<{
  invokeLocal: (method: string, params: unknown) => Promise<any>;
}>;

function createMachine(): Machine {
  return {
    id: 'machine-test',
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Happier Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'Happier Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    },
  });
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function getMachineRpcLifecycleRegistration(client: ApiMachineClient): any {
  const registrations = (client as any).rpcLifecycleRegistrations as readonly unknown[] | undefined;
  return registrations?.find((registration: any) => (
    registration?.promptAssetTransfers || registration?.promptRegistryTransfers
  ));
}

describe('ApiMachineClient prompt transfer lifecycle', () => {
  it('disposes abandoned prompt asset upload and download resources on shutdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-assets-home-'));
    const client = new ApiMachineClient('token', createMachine());

    try {
      await mkdir(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      await writeFile(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');

      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      }, {
        promptAssetsHomedir: () => homeDir,
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptAssetTransfers.transferSessionStore;
      const rpc = (client as any).rpcHandlerManager as RpcInvoker;

      const upload = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, { sizeBytes: 4 });
      expect(upload).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadSession = store.getUploadSession(upload.uploadId);
      expect(uploadSession).toBeTruthy();
      const uploadTempPath = uploadSession.tempPath;
      await expect(access(uploadTempPath)).resolves.toBeUndefined();

      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { skillName: 'reviewer' },
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadSession = store.getDownloadSession(download.downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession.filePath;
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await client.shutdown();
      await client.shutdown();

      expect(store.getUploadSession(upload.uploadId)).toBeNull();
      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(uploadTempPath);
      await expectPathMissing(downloadTempPath);
      await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, { sizeBytes: 1 }))
        .rejects.toThrow('Transfer session store is disposed');
    } finally {
      await client.shutdown().catch(() => undefined);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('disposes abandoned prompt registry download resources on shutdown', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-registry-repo-'));
    const happierHomeDir = await mkdtemp(join(tmpdir(), 'happier-machine-prompt-registry-home-'));
    const client = new ApiMachineClient('token', createMachine());

    try {
      await mkdir(join(repo, 'reviewer'), { recursive: true });
      await writeFile(join(repo, 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      git(repo, ['init', '-b', 'main']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'init']);

      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      }, {
        promptAssetsHappierHomeDir: () => happierHomeDir,
      });

      const lifecycle = getMachineRpcLifecycleRegistration(client);
      expect(lifecycle).toBeTruthy();
      const store = lifecycle.promptRegistryTransfers.transferSessionStore;
      const rpc = (client as any).rpcHandlerManager as RpcInvoker;
      const configuredSources = [{
        id: 'local-skills',
        adapterId: 'git',
        title: 'Local skills',
        enabled: true,
        config: { repositoryUrl: repo },
      }];
      const scan = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE, {
        sourceId: 'git:local-skills',
        configuredSources,
      });
      expect(scan).toMatchObject({ ok: true, items: [expect.objectContaining({ itemId: expect.any(String) })] });
      const recipient = createTransferRecipientKeyPair();
      const download = await rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT, {
        sourceId: 'git:local-skills',
        itemId: scan.items[0].itemId,
        configuredSources,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      expect(download).toMatchObject({ success: true, downloadId: expect.any(String) });
      const downloadSession = store.getDownloadSession(download.downloadId);
      expect(downloadSession).toBeTruthy();
      const downloadTempPath = downloadSession.filePath;
      await expect(access(downloadTempPath)).resolves.toBeUndefined();

      await client.shutdown();
      await client.shutdown();

      expect(store.getDownloadSession(download.downloadId)).toBeNull();
      await expectPathMissing(downloadTempPath);
    } finally {
      await client.shutdown().catch(() => undefined);
      await rm(repo, { recursive: true, force: true });
      await rm(happierHomeDir, { recursive: true, force: true });
    }
  });

  it('waits for active local prompt transfer RPC handlers before disposing lifecycle stores', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const handlerStarted = createDeferredVoid();
    const releaseHandler = createDeferredVoid();
    let handlerRunning = false;
    let disposeSawHandlerRunning: boolean | null = null;

    try {
      client.setRPCHandlers({
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      });

      (client as any).rpcHandlerManager.registerHandler(
        RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
        async () => {
          handlerRunning = true;
          handlerStarted.resolve();
          await releaseHandler.promise;
          handlerRunning = false;
          return { success: true, uploadId: 'slow-local-upload' };
        },
      );
      (client as any).rpcLifecycleRegistrations.push({
        dispose: async () => {
          disposeSawHandlerRunning = handlerRunning;
        },
      });

      const rpc = client.getPeerMediationMachineRpcHandlerManager();
      const invokePromise = rpc.invokeLocal(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT, {});
      await handlerStarted.promise;

      const shutdownPromise = client.shutdown();
      await Promise.resolve();
      await Promise.resolve();

      expect(disposeSawHandlerRunning).toBeNull();

      releaseHandler.resolve();
      await invokePromise;
      await shutdownPromise;

      expect(disposeSawHandlerRunning).toBe(false);
    } finally {
      releaseHandler.resolve();
      await client.shutdown().catch(() => undefined);
    }
  });
});
