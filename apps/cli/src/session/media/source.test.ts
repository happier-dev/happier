import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareSource } from './source';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==',
  'base64',
);

describe('prepareSource', () => {
  it('binds authorized local media to one byte snapshot before the source path can be replaced', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-session-media-source-'));
    const sourcePath = join(workingDirectory, 'provider-image.png');

    try {
      await writeFile(sourcePath, pngBytes);

      const prepared = await prepareSource({
        source: { kind: 'local-file', path: sourcePath, mimeType: 'image/png' },
        workingDirectory,
        maxBytes: pngBytes.byteLength,
      });

      expect(prepared).toMatchObject({
        kind: 'buffer',
        mimeType: 'image/png',
      });
      if ('success' in prepared || prepared.kind !== 'buffer') {
        throw new Error('expected an authorized byte snapshot');
      }

      await writeFile(sourcePath, Buffer.alloc(pngBytes.byteLength, 0x41));

      expect(prepared.bytes).toEqual(pngBytes);
      await expect(readFile(sourcePath)).resolves.not.toEqual(prepared.bytes);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
