import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerContentHandleV1 } from '@happier-dev/protocol';

import { createOneBitGrayscalePng } from '@/testkit/media/pngFixtures';

import {
  createComposerMediaStageStore,
  runComposerMediaStageStartupMaintenance,
} from './composerMediaStageStore';

const executionTarget = { serverId: 'server-current', machineId: 'machine-current' } as const;
const owner = { pluginId: 'com.example.media', localId: 'composer' } as const;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true).catch(() => false);
}

describe('Composer media stage store', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('atomically finalizes a verified stage that a restarted store can inspect without exposing a source path', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(4_096, 4_096);
    await writeFile(sourcePath, bytes);

    const store = createComposerMediaStageStore({
      rootDirectory: join(tempDirectory, 'stages'),
      executionTarget,
    });
    const finalized = await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'holiday photo.png',
    });

    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);
    expect(finalized.handle).toMatchObject({
      v: 1,
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'holiday photo.png',
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    expect(JSON.stringify(finalized.handle)).not.toContain(sourcePath);

    const restartedStore = createComposerMediaStageStore({
      rootDirectory: join(tempDirectory, 'stages'),
      executionTarget,
    });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toMatchObject({
      status: 'ready',
      mediaKind: 'image',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });

    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget: { serverId: executionTarget.serverId, machineId: 'another-machine' },
      owner,
    })).resolves.toEqual({ status: 'unavailable', reason: 'targetMismatch' });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner: { pluginId: owner.pluginId, localId: 'another-composer' },
    })).resolves.toEqual({ status: 'unavailable', reason: 'ownerMismatch' });
    const forgedOwnerHandle = {
      ...finalized.handle,
      owner: { pluginId: owner.pluginId, localId: 'another-composer' },
    };
    await expect(restartedStore.inspectForFinalization({
      handle: forgedOwnerHandle,
      executionTarget,
      owner: forgedOwnerHandle.owner,
    })).resolves.toEqual({ status: 'unavailable', reason: 'ownerMismatch' });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toEqual({ status: 'released' });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toEqual({ status: 'unavailable', reason: 'notFound' });
  });

  it('completes a stage for a valid image the dimension probe cannot decode', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-undimensioned-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'oversized-decoded-image.png');
    const bytes = createOneBitGrayscalePng(17_000, 17_000);
    await writeFile(sourcePath, bytes);

    const rootDirectory = join(tempDirectory, 'stages');
    const store = createComposerMediaStageStore({ rootDirectory, executionTarget });
    const finalized = await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'oversized-decoded-image.png',
    });

    expect(bytes.byteLength).toBe(35_201);
    expect(finalized.success).toBe(true);
    if (!finalized.success) return;
    await expect(store.inspectForFinalization({ handle: finalized.handle, executionTarget, owner })).resolves.toMatchObject({
      status: 'ready',
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });

  it('refuses image bytes whose declared MIME does not match the sniffed content', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-mismatch-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'not-really.png');
    const bytes = Buffer.from('GIF89a not a png at all', 'utf8');
    await writeFile(sourcePath, bytes);

    const rootDirectory = join(tempDirectory, 'stages');
    const store = createComposerMediaStageStore({ rootDirectory, executionTarget });
    await expect(store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'not-really.png',
    })).resolves.toMatchObject({ success: false, code: 'source_corrupt' });
    await expect(pathExists(join(rootDirectory, 'completed'))).resolves.toBe(false);
  });

  it('expires completed stages from a restarted store without retaining the stage bytes', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-expiry-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
    await writeFile(sourcePath, bytes);
    let now = 1_000;
    const rootDirectory = join(tempDirectory, 'stages');
    const store = createComposerMediaStageStore({
      rootDirectory,
      executionTarget,
      now: () => now,
      orphanTtlMs: 100,
    });
    const finalized = await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'expired.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    now += 100;
    const restartedStore = createComposerMediaStageStore({
      rootDirectory,
      executionTarget,
      now: () => now,
      orphanTtlMs: 100,
    });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
    })).resolves.toEqual({ status: 'unavailable', reason: 'notFound' });
  });

  it('sweeps expired root-owned completed and pending stages on restart without a handle', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-startup-sweep-'));
    tempDirectories.push(tempDirectory);
    const rootDirectory = join(tempDirectory, 'stages');
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);

    const now = Date.now();
    const orphanTtlMs = 100;
    const completedDirectory = join(rootDirectory, 'completed');
    const pendingDirectory = join(rootDirectory, '.pending');
    const writeCompletedStage = async (
      handle: ComposerContentHandleV1,
      createdAtMs: number,
    ): Promise<string> => {
      const directory = join(completedDirectory, handle.id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'content'), bytes);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ v: 1, createdAtMs, handle }));
      return directory;
    };
    const expiredHandle: ComposerContentHandleV1 = {
      v: 1,
      id: randomUUID(),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'expired.png',
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
    const currentHandle: ComposerContentHandleV1 = {
      ...expiredHandle,
      id: randomUUID(),
      name: 'current.png',
    };
    const expiredDirectory = await writeCompletedStage(expiredHandle, now - orphanTtlMs);
    const currentDirectory = await writeCompletedStage(currentHandle, now);

    const stalePendingDirectory = join(pendingDirectory, randomUUID());
    await mkdir(stalePendingDirectory, { recursive: true });
    await writeFile(join(stalePendingDirectory, 'content'), 'partial');
    const staleAt = new Date(now - orphanTtlMs);
    await utimes(stalePendingDirectory, staleAt, staleAt);

    const malformedDirectory = join(completedDirectory, randomUUID());
    await mkdir(malformedDirectory, { recursive: true });
    await writeFile(join(malformedDirectory, 'manifest.json'), '{"unexpected":true}');
    await utimes(malformedDirectory, staleAt, staleAt);
    const currentMalformedDirectory = join(completedDirectory, randomUUID());
    await mkdir(currentMalformedDirectory, { recursive: true });
    await writeFile(join(currentMalformedDirectory, 'manifest.json'), '{"unexpected":true}');

    const expiredForeignDirectory = await writeCompletedStage({
      ...currentHandle,
      id: randomUUID(),
      executionTarget: { serverId: 'foreign-server', machineId: 'foreign-machine' },
    }, now - orphanTtlMs);
    const currentForeignDirectory = await writeCompletedStage({
      ...currentHandle,
      id: randomUUID(),
      executionTarget: { serverId: 'foreign-server', machineId: 'foreign-machine' },
    }, now);

    const foreignPendingDirectory = join(pendingDirectory, 'foreign-entry');
    await mkdir(foreignPendingDirectory, { recursive: true });
    await writeFile(join(foreignPendingDirectory, 'keep'), 'foreign');
    await utimes(foreignPendingDirectory, staleAt, staleAt);

    const outsideDirectory = join(tempDirectory, 'outside');
    const outsideMarker = join(outsideDirectory, 'keep');
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(outsideMarker, 'outside');
    const foreignLink = join(completedDirectory, randomUUID());
    await symlink(
      outsideDirectory,
      foreignLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    // Hot stores are constructed during finalization and accepted settlement. They
    // must not start namespace-wide maintenance work on ordinary message traffic.
    createComposerMediaStageStore({ rootDirectory, executionTarget, now: () => now, orphanTtlMs });
    createComposerMediaStageStore({ rootDirectory, executionTarget, now: () => now, orphanTtlMs });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await pathExists(expiredDirectory)).toBe(true);
    expect(await pathExists(stalePendingDirectory)).toBe(true);

    // The daemon-startup owner invokes maintenance once without needing an opaque claim.
    await runComposerMediaStageStartupMaintenance({
      rootDirectory,
      now: () => now,
      orphanTtlMs,
    });

    expect(await pathExists(expiredDirectory)).toBe(false);
    expect(await pathExists(stalePendingDirectory)).toBe(false);
    expect(await pathExists(malformedDirectory)).toBe(false);
    expect(await pathExists(expiredForeignDirectory)).toBe(false);
    expect(await pathExists(currentDirectory)).toBe(true);
    expect(await pathExists(currentMalformedDirectory)).toBe(true);
    expect(await pathExists(currentForeignDirectory)).toBe(true);
    expect(await pathExists(foreignPendingDirectory)).toBe(true);
    expect(await pathExists(foreignLink)).toBe(true);
    expect(await pathExists(outsideMarker)).toBe(true);
  });
});
