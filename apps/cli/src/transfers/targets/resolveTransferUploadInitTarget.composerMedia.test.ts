import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveTransferUploadInitTarget,
  type TransferUploadInitRequest,
} from './resolveTransferUploadInitTarget';
import { createComposerMediaStageStore } from '../staging/composerMediaStageStore';

describe('resolveTransferUploadInitTarget composer media staging', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('rejects a composer media stage addressed to a different target daemon', async () => {
    const result = await resolveTransferUploadInitTarget({
      workingDirectory: '/workspace',
      tempUploadRoot: '/tmp/happier/uploads',
      request: {
        t: 'composer_media_stage_upload_v1',
        executionTarget: { serverId: 'server-other', machineId: 'machine-other' },
        owner: { pluginId: 'com.example.media', localId: 'composer' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'photo.png',
        sizeBytes: 3,
        sha256: 'a'.repeat(64),
      } as unknown as TransferUploadInitRequest,
      composerMediaStage: {
        executionTarget: { serverId: 'server-current', machineId: 'machine-current' },
      },
    } as unknown as Parameters<typeof resolveTransferUploadInitTarget>[0]);

    expect(result).toEqual({
      success: false,
      error: 'Composer media stage target does not match target daemon',
    });
  });

  it('resolves an exact target-bound Composer media upload through the stage store', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'happier-composer-media-target-'));
    tempDirectories.push(tempDirectory);
    const executionTarget = { serverId: 'server-current', machineId: 'machine-current' } as const;
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    const sourcePath = join(tempDirectory, 'incoming.png');
    await writeFile(sourcePath, bytes);
    const stageStore = createComposerMediaStageStore({
      rootDirectory: join(tempDirectory, 'stages'),
      executionTarget,
    });

    const result = await resolveTransferUploadInitTarget({
      workingDirectory: '/workspace',
      tempUploadRoot: join(tempDirectory, 'uploads'),
      request: {
        t: 'composer_media_stage_upload_v1',
        executionTarget,
        owner: { pluginId: 'com.example.media', localId: 'composer' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'photo.png',
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } as unknown as TransferUploadInitRequest,
      composerMediaStage: {
        executionTarget,
        store: stageStore,
      },
    } as unknown as Parameters<typeof resolveTransferUploadInitTarget>[0]);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const finalized = await result.target.finalizeUpload({
      uploadId: 'upload-stage',
      tempPath: sourcePath,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(finalized).toMatchObject({
      success: true,
      path: 'Composer media stage',
      result: {
        v: 1,
        executionTarget,
        name: 'photo.png',
      },
    });
  });
});
