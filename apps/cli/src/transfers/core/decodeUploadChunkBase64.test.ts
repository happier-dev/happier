import { describe, expect, it } from 'vitest';

import { decodeUploadChunkBase64 } from './decodeUploadChunkBase64';

describe('decodeUploadChunkBase64', () => {
  it('returns null for invalid base64 input', () => {
    expect(decodeUploadChunkBase64('not base64!!!')).toBeNull();
  });

  it('decodes valid base64 input', () => {
    const encoded = Buffer.from('hello', 'utf8').toString('base64');
    expect(decodeUploadChunkBase64(encoded)?.toString('utf8')).toBe('hello');
  });

  it('fails closed when the base64 payload would decode to more than the allowed max', () => {
    // 16 base64 chars -> 12 decoded bytes (no padding)
    const oversized = 'A'.repeat(16);

    const decoded = decodeUploadChunkBase64(oversized, { maxDecodedBytes: 10 });
    expect(decoded).toBeNull();
  });
});
