import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerContentHandleV1, ComposerRefV1 } from '@happier-dev/protocol';

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

  it('gives one Composer attachment linear custody across restarted stores', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-custody-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
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
      name: 'claimed.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const composer: ComposerRefV1 = { kind: 'session', sessionId: 'session-a' };
    const claimant = { composer, attachmentInstanceId: 'attachment-a' } as const;
    const otherClaimant = {
      composer: { kind: 'session', sessionId: 'session-b' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-b',
    } as const;
    const restartedStore = createComposerMediaStageStore({ rootDirectory, executionTarget });

    const concurrentClaims = await Promise.all([
      store.claim({ handle: finalized.handle, executionTarget, owner, claimant }),
      restartedStore.claim({ handle: finalized.handle, executionTarget, owner, claimant }),
    ]);
    expect(concurrentClaims).toEqual(expect.arrayContaining([
      { status: 'claimed', newlyAcquired: true },
      { status: 'claimed', newlyAcquired: false },
    ]));
    await expect(restartedStore.claim({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: otherClaimant,
    })).resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
    await expect(restartedStore.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: otherClaimant,
    })).resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: otherClaimant,
    })).resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toEqual({ status: 'released' });
  });

  it('refuses the same attachment identity when the exact Composer ref differs', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-transition-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
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
      name: 'transition.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const draftClaimant = {
      composer: { kind: 'newSession', instanceId: 'composer-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    const sessionClaimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    const foreignIdentityClaimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-b',
    } as const;

    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant: draftClaimant }))
      .resolves.toEqual({ status: 'claimed', newlyAcquired: true });
    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant: sessionClaimant }))
      .resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
    await expect(store.claim({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: foreignIdentityClaimant,
    })).resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });

    const restartedStore = createComposerMediaStageStore({ rootDirectory, executionTarget });
    await expect(restartedStore.claim({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: draftClaimant,
    })).resolves.toEqual({ status: 'claimed', newlyAcquired: false });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: draftClaimant,
    })).resolves.toEqual({ status: 'released' });
  });

  it('forks an exact source claim into a deterministic Session submission claim', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-pending-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
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
      name: 'pending.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const sourceClaimant = {
      composer: { kind: 'pendingMessage', sessionId: 'session-a', localId: 'pending-1' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    const destinationClaimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;

    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant: sourceClaimant }))
      .resolves.toEqual({ status: 'claimed', newlyAcquired: true });
    const forked = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant,
      destinationClaimant,
      messageLocalId: 'message-1',
    });
    expect(forked).toMatchObject({ status: 'claimed', newlyAcquired: true });
    expect(forked.handle?.id).not.toBe(finalized.handle.id);
    const retry = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant,
      destinationClaimant,
      messageLocalId: 'message-1',
    });
    expect(retry).toMatchObject({ status: 'claimed', newlyAcquired: false, handle: forked.handle });
    await expect(store.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant: sourceClaimant,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(store.inspectForFinalization({
      handle: forked.handle!,
      executionTarget,
      owner,
      claimant: destinationClaimant,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant: { ...sourceClaimant, attachmentInstanceId: 'attachment-b' },
      destinationClaimant,
      messageLocalId: 'message-1',
    })).resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
  });

  it('forks a same-document submission capture into its own deterministic stage without consuming the draft original', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-same-ref-fork-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
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
      name: 'same-ref.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const claimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant }))
      .resolves.toEqual({ status: 'claimed', newlyAcquired: true });

    const forked = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant: claimant,
      destinationClaimant: claimant,
      messageLocalId: 'message-1',
    });
    expect(forked).toMatchObject({ status: 'claimed', newlyAcquired: true });
    expect(forked.handle?.id).not.toBe(finalized.handle.id);

    const retry = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant: claimant,
      destinationClaimant: claimant,
      messageLocalId: 'message-1',
    });
    expect(retry).toMatchObject({ status: 'claimed', newlyAcquired: false, handle: forked.handle });

    await expect(store.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(store.inspectForFinalization({
      handle: forked.handle!,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });

    // A concurrent draft removal releases only the draft original; the captured
    // submission fork keeps its own claim and stays persistable.
    await expect(store.release({ handle: finalized.handle, executionTarget, owner, claimant }))
      .resolves.toEqual({ status: 'released' });
    await expect(store.inspectForFinalization({
      handle: forked.handle!,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('forks an unclaimed stage for a same-document submission capture and leaves it claimed for its owner', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-same-ref-unclaimed-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
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
      name: 'same-ref-unclaimed.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const claimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    const forked = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant: claimant,
      destinationClaimant: claimant,
      messageLocalId: 'message-1',
    });
    expect(forked).toMatchObject({ status: 'claimed', newlyAcquired: true });
    expect(forked.handle?.id).not.toBe(finalized.handle.id);
    await expect(store.inspectForFinalization({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(store.inspectForFinalization({
      handle: forked.handle!,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('forks a source claim after its TTL and rejoins the fork after its TTL', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-ttl-fork-'));
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
      name: 'ttl-fork.png',
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error(finalized.error);

    const sourceClaimant = {
      composer: { kind: 'pendingMessage', sessionId: 'session-a', localId: 'pending-1' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    const destinationClaimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant: sourceClaimant }))
      .resolves.toMatchObject({ status: 'claimed' });

    now += 100;
    const forked = await store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant,
      destinationClaimant,
      messageLocalId: 'message-1',
    });
    expect(forked).toMatchObject({ status: 'claimed', newlyAcquired: true });
    expect(forked.handle?.id).not.toBe(finalized.handle.id);

    now += 100;
    await expect(store.forkClaimForSubmission({
      handle: finalized.handle,
      executionTarget,
      owner,
      sourceClaimant,
      destinationClaimant,
      messageLocalId: 'message-1',
    })).resolves.toMatchObject({ status: 'claimed', newlyAcquired: false, handle: forked.handle });
  });

  it('allows an unattached stage to be explicitly released but refuses an anonymous release after claim', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-stage-unattached-'));
    tempDirectories.push(tempDirectory);
    const sourcePath = join(tempDirectory, 'incoming.png');
    const bytes = createOneBitGrayscalePng(1, 1);
    await writeFile(sourcePath, bytes);
    const rootDirectory = join(tempDirectory, 'stages');
    const store = createComposerMediaStageStore({ rootDirectory, executionTarget });
    const createStage = async () => await store.finalizeUpload({
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      executionTarget,
      owner,
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'unattached.png',
    });
    const unattached = await createStage();
    expect(unattached.success).toBe(true);
    if (!unattached.success) throw new Error(unattached.error);
    await expect(store.release({ handle: unattached.handle, executionTarget, owner }))
      .resolves.toEqual({ status: 'released' });

    const attached = await createStage();
    expect(attached.success).toBe(true);
    if (!attached.success) throw new Error(attached.error);
    const claimant = {
      composer: { kind: 'newSession', instanceId: 'composer-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    await expect(store.claim({ handle: attached.handle, executionTarget, owner, claimant }))
      .resolves.toEqual({ status: 'claimed', newlyAcquired: true });
    await expect(store.release({ handle: attached.handle, executionTarget, owner }))
      .resolves.toEqual({ status: 'unavailable', reason: 'claimedElsewhere' });
    await expect(store.inspectForFinalization({
      handle: attached.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
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

  it('retains expired claimed stages for exact release while expiring unattached stages', async () => {
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

    const claimant = {
      composer: { kind: 'session', sessionId: 'session-a' } as ComposerRefV1,
      attachmentInstanceId: 'attachment-a',
    } as const;
    await expect(store.claim({ handle: finalized.handle, executionTarget, owner, claimant }))
      .resolves.toMatchObject({ status: 'claimed' });

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
      claimant,
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(restartedStore.release({
      handle: finalized.handle,
      executionTarget,
      owner,
      claimant,
    })).resolves.toEqual({ status: 'released' });
    expect(await pathExists(join(rootDirectory, 'completed', finalized.handle.id))).toBe(false);
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
    const abandonedForkPendingDirectory = join(pendingDirectory, randomUUID());
    await mkdir(abandonedForkPendingDirectory, { recursive: true });
    await writeFile(join(abandonedForkPendingDirectory, 'manifest.json'), '{"fork":"abandoned-before-rename"}');
    const staleAt = new Date(now - orphanTtlMs);
    await utimes(stalePendingDirectory, staleAt, staleAt);
    await utimes(abandonedForkPendingDirectory, staleAt, staleAt);

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
    expect(await pathExists(abandonedForkPendingDirectory)).toBe(true);

    // The daemon-startup owner invokes maintenance once without needing an opaque claim.
    await runComposerMediaStageStartupMaintenance({
      rootDirectory,
      now: () => now,
      orphanTtlMs,
    });

    expect(await pathExists(expiredDirectory)).toBe(false);
    expect(await pathExists(stalePendingDirectory)).toBe(false);
    expect(await pathExists(abandonedForkPendingDirectory)).toBe(false);
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
