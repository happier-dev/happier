import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

type Handler = (data: unknown) => Promise<unknown>;

const executionTarget = { serverId: 'server-current', machineId: 'machine-current' } as const;
const owner = { pluginId: 'com.example.media', localId: 'composer' } as const;
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlW6UYAAAAASUVORK5CYII=',
  'base64',
);

function createRpcHandlerManager(): Readonly<{
  handlers: Map<string, Handler>;
  registerHandler: (method: string, handler: Handler) => void;
}> {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler: (method, handler) => {
      handlers.set(method, handler);
    },
  };
}

describe('Composer media stage download handler', () => {
  const temporaryDirectories: string[] = [];
  const registrations: Array<ReturnType<typeof registerFileSystemHandlers>> = [];

  afterEach(async () => {
    await Promise.all(registrations.splice(0).map(async (registration) => await registration.dispose()));
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('streams only an exact completed target/owner-bound inspection range and releases it idempotently', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-download-'));
    temporaryDirectories.push(rootDirectory);
    const sourcePath = join(rootDirectory, 'incoming.png');
    await writeFile(sourcePath, pngBytes);
    const store = createComposerMediaStageStore({
      rootDirectory: join(rootDirectory, 'stages'),
      executionTarget,
    });
    const finalized = await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'camera.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const manager = createRpcHandlerManager();
    registrations.push(registerFileSystemHandlers(manager as unknown as RpcHandlerManager, rootDirectory, {
      composerMediaStage: { executionTarget, store },
    }));
    const capability = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1);
    const init = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT);
    const chunk = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK);
    const finalize = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE);
    if (!capability || !init || !chunk || !finalize) throw new Error('expected Composer media transfer handlers');

    await expect(capability({})).resolves.toEqual({
      success: true,
      available: true,
      capability: 'composer.mediaContent.v1',
    });
    await expect(capability({ unexpected: true })).rejects.toThrow('Invalid Composer media capability request');

    const recipient = createTransferRecipientKeyPair();
    const initResponse = await init({
      t: 'composer_media_stage_inspect_v1',
      handle: finalized.handle,
      offset: 2,
      maxBytes: 5,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as Readonly<{ success: boolean; downloadId?: string; sizeBytes?: number; name?: string }>;
    expect(initResponse).toEqual(expect.objectContaining({
      success: true,
      sizeBytes: 5,
      name: finalized.handle.name,
    }));
    if (initResponse.success !== true || !initResponse.downloadId) throw new Error('expected download session');

    const chunkResponse = await chunk({ downloadId: initResponse.downloadId, index: 0 }) as Readonly<{
      success: boolean;
      payloadBase64?: string;
      encryptedDataKeyEnvelopeBase64?: string;
      isLast?: boolean;
    }>;
    expect(chunkResponse).toEqual(expect.objectContaining({ success: true, isLast: true }));
    expect(decryptEncryptedTransferChunkEnvelope({
      transferId: initResponse.downloadId,
      sequence: 0,
      payloadBase64: chunkResponse.payloadBase64 ?? '',
      encryptedDataKeyEnvelopeBase64: chunkResponse.encryptedDataKeyEnvelopeBase64 ?? '',
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
    })).toEqual(pngBytes.subarray(2, 7));
    await expect(finalize({ downloadId: initResponse.downloadId })).resolves.toEqual({ success: true });

    const forgedOwner = { pluginId: owner.pluginId, localId: 'another-composer' };
    const forgedResponse = await init({
      t: 'composer_media_stage_inspect_v1',
      handle: { ...finalized.handle, owner: forgedOwner },
      offset: 0,
      maxBytes: 1,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    });
    expect(forgedResponse).toEqual({ success: false, error: 'Composer media stage is unavailable' });
    await expect(store.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toMatchObject({ status: 'ready' });

    const release = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE);
    expect(release).toEqual(expect.any(Function));
    if (!release) throw new Error('expected Composer media release handler');
    await expect(release({
      handle: { ...finalized.handle, owner: forgedOwner },
    })).resolves.toEqual({ success: false, error: 'Composer media stage is unavailable' });
    await expect(store.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toMatchObject({ status: 'ready' });
    const claimant = {
      composer: { kind: 'session' as const, sessionId: 'session-1' },
      attachmentInstanceId: 'attachment-1',
    };
    await expect(store.claim({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toEqual({ status: 'claimed', newlyAcquired: true });
    await expect(release({
      handle: finalized.handle,
      claimant: {
        composer: { kind: 'session', sessionId: 'session-2' },
        attachmentInstanceId: 'attachment-1',
      },
    })).resolves.toEqual({ success: false, error: 'Composer media stage is unavailable' });
    await expect(release({ handle: finalized.handle })).resolves.toEqual({
      success: false,
      error: 'Composer media stage is unavailable',
    });
    await expect(release({ handle: finalized.handle, claimant })).resolves.toEqual({ success: true });
    await expect(release({ handle: finalized.handle, claimant })).resolves.toEqual({ success: true });
  });
});
