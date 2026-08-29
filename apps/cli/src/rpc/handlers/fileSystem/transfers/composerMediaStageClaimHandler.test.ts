import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

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

describe('Composer media stage claim handler', () => {
  const temporaryDirectories: string[] = [];
  const registrations: Array<ReturnType<typeof registerFileSystemHandlers>> = [];

  afterEach(async () => {
    await Promise.all(registrations.splice(0).map(async (registration) => await registration.dispose()));
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('claims an unclaimed stage for one exact attachment and refuses a second claimant over the wire', async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-claim-'));
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
      name: 'attached.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const manager = createRpcHandlerManager();
    registrations.push(registerFileSystemHandlers(manager as unknown as RpcHandlerManager, rootDirectory, {
      composerMediaStage: { executionTarget, store },
    }));
    const claim = manager.handlers.get(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM);
    if (!claim) throw new Error('expected Composer media claim handler');

    const firstClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-a' },
      attachmentInstanceId: 'attachment-a',
    };
    const secondClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-b' },
      attachmentInstanceId: 'attachment-b',
    };

    await expect(claim({ handle: finalized.handle, claimant: firstClaimant }))
      .resolves.toEqual({ success: true, newlyAcquired: true });
    // Same claimant re-claims idempotently (restart/rejoin).
    await expect(claim({ handle: finalized.handle, claimant: firstClaimant }))
      .resolves.toEqual({ success: true, newlyAcquired: false });
    // Another document/attachment resolves the typed custody conflict.
    await expect(claim({ handle: finalized.handle, claimant: secondClaimant }))
      .resolves.toEqual({
        success: false,
        error: 'Composer media stage is claimed elsewhere',
        claimedElsewhere: true,
      });
    // A claim request without its exact attachment claimant is invalid.
    await expect(claim({ handle: finalized.handle }))
      .resolves.toEqual({ success: false, error: 'Invalid Composer media claim request' });

    await expect(store.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: firstClaimant,
    })).resolves.toEqual({ status: 'released' });
  });
});
