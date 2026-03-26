import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFileTransferPayloadSource, resolveTransferPayloadSizeBytes } from './transferPayloadSource';

describe('transferPayloadSource', () => {
  it('falls back to stat() when sizeBytes is NaN/Infinity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-payload-source-'));
    try {
      const filePath = join(root, 'payload.bin');
      await writeFile(filePath, Buffer.from('hello', 'utf8'));

      const sourceNaN = createFileTransferPayloadSource({ filePath, sizeBytes: Number.NaN });
      await expect(resolveTransferPayloadSizeBytes(sourceNaN)).resolves.toBe(5);

      const sourceInfinity = createFileTransferPayloadSource({ filePath, sizeBytes: Number.POSITIVE_INFINITY });
      await expect(resolveTransferPayloadSizeBytes(sourceInfinity)).resolves.toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
