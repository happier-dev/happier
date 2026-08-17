import { describe, expect, it } from 'vitest';

import {
  encodeUnpaddedBase64Url,
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';

const ZERO_KEY = new Uint8Array(32);

async function derive(parts: readonly string[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Web Crypto is required by this test environment.');
  const key = await importHmacSha256Key(subtle, ZERO_KEY);
  return await signLengthPrefixedUtf8HmacSha256Base64Url({ subtle, key, parts });
}

describe('private Channel row identities', () => {
  it('signs the canonical UTF-8 length-prefixed non-ASCII vector without truncation', async () => {
    await expect(derive([
      'channels:private-row-identity:test',
      'café',
      '🍣',
    ])).resolves.toBe('Y0eqxIbb0NB1cCCVH_l21adeknsRr8LsRiXu7OScUTo');
  });

  it('separates part boundaries rather than concatenating logical identities', async () => {
    await expect(derive(['ab', 'c'])).resolves.toBe('U73vJlee1UnVtJDGe0ENMp3ZzkU9hU1GlZV_RJwfeOY');
    await expect(derive(['a', 'bc'])).resolves.toBe('gwvgB0joZ3NI4c8sJ4Xm83gZ6CCXOUffzDkOaNTktHk');
  });

  it('encodes unpadded base64url and treats malformed input as absent', () => {
    const bytes = new Uint8Array([0, 255, 254]);

    expect(encodeUnpaddedBase64Url(bytes)).toBe('AP_-');
    expect(tryDecodeBase64Url('AP_-')).toEqual(bytes);
    expect(tryDecodeBase64Url('not base64url%')).toBeNull();
  });
});
