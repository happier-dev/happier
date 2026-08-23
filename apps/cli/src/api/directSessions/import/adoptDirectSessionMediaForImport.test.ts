import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { adoptDirectSessionMediaForImport } from './adoptDirectSessionMediaForImport';

const filesystemBoundary = vi.hoisted(() => ({ failedManagedCopiesRemaining: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(async (
      source: Parameters<typeof actual.copyFile>[0],
      destination: Parameters<typeof actual.copyFile>[1],
      mode?: Parameters<typeof actual.copyFile>[2],
    ) => {
      if (
        filesystemBoundary.failedManagedCopiesRemaining > 0
        && String(destination).replaceAll('\\', '/').includes('/.happier/uploads/')
      ) {
        filesystemBoundary.failedManagedCopiesRemaining -= 1;
        throw new Error('simulated managed-media copy failure');
      }
      return await actual.copyFile(source, destination, mode);
    }),
  };
});

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

function directMediaItem(path: string) {
  return {
    id: 'provider-media-1',
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'provider-image.png',
    path,
    sizeBytes: pngBytes.byteLength,
    origin: { source: 'provider-generated', agentId: 'codex', generationId: 'img_1' },
  };
}

function directMediaRaw(paths: string[]) {
  return {
    role: 'agent',
    content: { type: 'output', data: { type: 'message', message: 'generated image' } },
    meta: {
      happier: {
        kind: 'session_media.v1',
        payload: { media: paths.map(directMediaItem) },
      },
    },
  };
}

describe('adoptDirectSessionMediaForImport', () => {
  it('adopts provider-owned direct transcript media into managed session storage', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerDirectory, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);

      const adoptedRaw = await adoptDirectSessionMediaForImport({
        raw: directMediaRaw([providerImagePath]),
        sessionId: 'sess_direct_import',
        messageLocalId: 'direct-item-1',
        workingDirectory,
      });
      const adoptedMeta = adoptedRaw.meta as Record<string, unknown>;
      const adoptedEnvelope = adoptedMeta.happier as Record<string, unknown>;
      const adoptedPayload = adoptedEnvelope.payload as Record<string, unknown>;
      const adoptedMedia = adoptedPayload.media as Array<Record<string, unknown>>;
      const adoptedPath = String(adoptedMedia[0]?.path ?? '');

      expect(adoptedPath).toMatch(/^\.happier\/uploads\/generated\/direct-item-1\//);
      expect(isAbsolute(adoptedPath)).toBe(false);
      expect(adoptedPath).not.toContain(providerDirectory);
      expect(JSON.stringify(adoptedRaw)).not.toContain(providerImagePath);
      expect(JSON.stringify(adoptedRaw)).not.toContain('file://');
      await expect(readFile(resolve(workingDirectory, adoptedPath))).resolves.toEqual(pngBytes);
      await expect(readFile(providerImagePath)).resolves.toEqual(pngBytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });

  it('continues adopting later media when one provider source cannot be persisted', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-'));

    try {
      const failedImagePath = join(providerDirectory, 'failed.png');
      const validImagePath = join(providerDirectory, 'valid.png');
      await writeFile(failedImagePath, pngBytes);
      await writeFile(validImagePath, pngBytes);
      filesystemBoundary.failedManagedCopiesRemaining = 2;

      const adoptedRaw = await adoptDirectSessionMediaForImport({
        raw: directMediaRaw([failedImagePath, validImagePath]),
        sessionId: 'sess_direct_import',
        messageLocalId: 'direct-item-1',
        workingDirectory,
      });
      const adoptedMeta = adoptedRaw.meta as Record<string, unknown>;
      const adoptedEnvelope = adoptedMeta.happier as Record<string, unknown>;
      const adoptedPayload = adoptedEnvelope.payload as Record<string, unknown>;
      const adoptedMedia = adoptedPayload.media as Array<Record<string, unknown>>;

      expect(adoptedMedia).toHaveLength(1);
      await expect(readFile(resolve(workingDirectory, String(adoptedMedia[0]?.path)))).resolves.toEqual(pngBytes);
    } finally {
      filesystemBoundary.failedManagedCopiesRemaining = 0;
      await rm(workingDirectory, { recursive: true, force: true });
      await rm(providerDirectory, { recursive: true, force: true });
    }
  });
});
