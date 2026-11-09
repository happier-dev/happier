import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFileTransferPayloadSource,
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from './transferPayloadSource';

describe('transferPayloadSource', () => {
  it('serves an admitted native source without reopening a daemon path and releases its byte custody', async () => {
    const payload = Buffer.from([0, 255, 1, 254, 2]);
    const reads: Array<{ offset: number; length: number }> = [];
    let closed = false;
    const source: TransferPayloadSource = {
      kind: 'native', sizeBytes: payload.byteLength,
      manifestHash: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
      readChunk: async input => { if (closed) throw new Error('closed'); reads.push(input);
        return payload.subarray(input.offset, input.offset + input.length); },
      dispose: async () => { closed = true; },
    };
    await expect(resolveTransferPayloadSizeBytes(source)).resolves.toBe(payload.length);
    await expect(resolveTransferPayloadManifestHash(source)).resolves.toBe(source.manifestHash);
    await expect(readTransferPayloadChunk({ source, offset: 1, length: 99 })).resolves.toEqual(payload.subarray(1));
    expect(reads).toEqual([{ offset: 1, length: 4 }]);
    await expect(readTransferPayloadChunk({ source, offset: 5, length: 1 })).resolves.toEqual(Buffer.alloc(0));
    expect(reads).toHaveLength(1);
    await disposeTransferPayloadSource(source);
    expect(closed).toBe(true);
    await expect(readTransferPayloadChunk({ source, offset: 0, length: 1 })).rejects.toThrow('closed');
  });
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

  it('contains a file payload to its declared byte range for size, reads, and manifest hashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-transfer-payload-source-range-'));
    try {
      const filePath = join(root, 'payload.bin');
      await writeFile(filePath, Buffer.from('private-visible-private', 'utf8'));
      const source = createFileTransferPayloadSource({
        filePath,
        sourceOffsetBytes: 8,
        sizeBytes: 7,
      });

      await expect(resolveTransferPayloadSizeBytes(source)).resolves.toBe(7);
      await expect(readTransferPayloadChunk({ source, offset: 0, length: 20 }))
        .resolves.toEqual(Buffer.from('visible', 'utf8'));
      await expect(resolveTransferPayloadManifestHash(source))
        .resolves.toBe(`sha256:${createHash('sha256').update('visible').digest('hex')}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
