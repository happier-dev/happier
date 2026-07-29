import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adoptSessionMediaMetadataForManagedSession,
  stageSessionMediaMetadataForHistoricalImport,
} from './adoption';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const durableVideoItem = {
  id: 'recording-1',
  role: 'output',
  category: 'tool-artifact',
  mediaKind: 'video',
  mimeType: 'video/webm',
  name: 'recording.webm',
  path: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
  sizeBytes: 2048,
  sha256: 'c'.repeat(64),
  origin: {
    source: 'tool-output',
    toolCallId: 'recording-call-1',
  },
} as const;

describe('adoptSessionMediaMetadataForManagedSession', () => {
  it('preserves existing durable video session media references without coercing them to images', async () => {
    const raw = {
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: {
            media: [durableVideoItem],
          },
        },
      },
    };

    const adopted = await adoptSessionMediaMetadataForManagedSession({
      raw,
      sessionId: 'session-1',
      messageLocalId: 'message-1',
      workingDirectory: '/workspace',
    });

    expect(adopted).toEqual(raw);
  });

  it('captures historical-import media inside the private payload before publishing workspace media', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-media-historical-stage-'));
    roots.push(workingDirectory);
    const sourcePath = join(workingDirectory, 'source.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(sourcePath, png);
    const raw = {
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: {
            media: [{
              role: 'output',
              category: 'generated',
              path: sourcePath,
              mimeType: 'image/png',
              name: 'source.png',
              origin: { source: 'provider-generated' },
            }],
          },
        },
      },
    };

    const staged = await stageSessionMediaMetadataForHistoricalImport({
      raw,
      workingDirectory,
      sourceReadRoots: [],
    });

    expect(JSON.stringify(staged)).not.toContain(sourcePath);
    expect(JSON.stringify(staged)).toContain(png.toString('base64'));
    await expect(stat(join(workingDirectory, '.happier', 'uploads')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(sourcePath, Buffer.from('source changed after private capture'));
    const onCreatedWorkspacePath = vi.fn();
    const adopted = await adoptSessionMediaMetadataForManagedSession({
      raw: staged,
      sessionId: 'session-1',
      messageLocalId: 'message-1',
      workingDirectory,
      onCreatedWorkspacePath,
    });
    const adoptedPath = (
      adopted.meta as {
        happier: { payload: { media: Array<{ path: string }> } };
      }
    ).happier.payload.media[0]!.path;
    expect(await readFile(join(workingDirectory, adoptedPath))).toEqual(png);

    const resumed = await adoptSessionMediaMetadataForManagedSession({
      raw: staged,
      sessionId: 'session-1',
      messageLocalId: 'message-1',
      workingDirectory,
      onCreatedWorkspacePath,
    });
    expect(resumed).toEqual(adopted);
    expect(onCreatedWorkspacePath).toHaveBeenCalledOnce();
  });

  it('fails closed when media requires immutable staging but the workspace is unavailable', async () => {
    const raw = {
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: {
            media: [{
              role: 'output',
              category: 'generated',
              path: '/tmp/mutable-source.png',
              mimeType: 'image/png',
            }],
          },
        },
      },
    };

    await expect(stageSessionMediaMetadataForHistoricalImport({
      raw,
      workingDirectory: null,
      sourceReadRoots: [],
    })).rejects.toThrow('historical_import_media_working_directory_unavailable');
  });
});
