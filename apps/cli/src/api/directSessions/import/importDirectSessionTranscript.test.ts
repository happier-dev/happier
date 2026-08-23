import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { adoptDirectSessionMediaForImport } from './adoptDirectSessionMediaForImport';

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

describe('importDirectSessionTranscript', () => {
  it('adopts provider-owned direct transcript media into managed session storage', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-workspace-'));
    const providerDirectory = await mkdtemp(join(tmpdir(), 'happier-direct-import-provider-'));

    try {
      await mkdir(join(workingDirectory, '.git', 'info'), { recursive: true });
      const providerImagePath = join(providerDirectory, 'provider-owned.png');
      await writeFile(providerImagePath, pngBytes);

      const raw = {
        role: 'agent',
        content: { type: 'output', data: { type: 'message', message: 'generated image' } },
        meta: {
          happier: {
            kind: 'session_media.v1',
            payload: { media: [directMediaItem(providerImagePath)] },
          },
        },
      };

      const adoptedRaw = await adoptDirectSessionMediaForImport({
        raw,
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
});
