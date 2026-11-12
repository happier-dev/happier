import { describe, expect, it } from 'vitest';

import { decodeUploadChunkBase64 } from './decodeUploadChunkBase64';

describe('upload chunk base64 grammar', () => {
  it.each([4, 16])('decodes an admitted %i MiB chunk', mib => {
    const bytes = Buffer.alloc(mib * 1024 * 1024, 97);
    const decoded = decodeUploadChunkBase64(bytes.toString('base64'), { maxDecodedBytes: bytes.length });
    expect(decoded?.equals(bytes)).toBe(true);
  });

  it('preserves structural padding policy and enforces the caller byte budget', () => {
    expect(decodeUploadChunkBase64('AB==')?.equals(Buffer.from([0]))).toBe(true);
    expect(decodeUploadChunkBase64('')?.length).toBe(0);
    expect(decodeUploadChunkBase64('AAAA', { maxDecodedBytes: 2 })).toBeNull();
    expect(decodeUploadChunkBase64('AAA=', { maxDecodedBytes: 2 })?.length).toBe(2);
    for (const input of ['A', 'A===', 'AA-_', 'AAAA\n']) {
      expect(decodeUploadChunkBase64(input)).toBeNull();
    }
  });
});
