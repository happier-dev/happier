import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64 } from './base64.js';

function createDeterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = i % 251;
  }
  return out;
}

describe('protocol base64 helpers', () => {
  it('round-trips base64', () => {
    const bytes = createDeterministicBytes(1024);
    const encoded = encodeBase64(bytes, 'base64');
    const decoded = decodeBase64(encoded, 'base64');
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('decodes base64 leniently (whitespace, invalid chars, missing padding)', () => {
    expect(() => decodeBase64('Zm9v\n', 'base64')).not.toThrow();
    expect(new TextDecoder().decode(decodeBase64('Zm9v\n', 'base64'))).toBe('foo');

    expect(() => decodeBase64('A', 'base64')).not.toThrow();
    expect(decodeBase64('A', 'base64')).toEqual(new Uint8Array());

    expect(() => decodeBase64('@@@', 'base64')).not.toThrow();
    expect(decodeBase64('@@@', 'base64')).toEqual(new Uint8Array());

    expect(() => decodeBase64('Zm9v', 'base64')).not.toThrow();
    expect(new TextDecoder().decode(decodeBase64('Zm9v', 'base64'))).toBe('foo');
  });

  it('round-trips base64url without padding', () => {
    const bytes = createDeterministicBytes(2049);
    const encoded = encodeBase64(bytes, 'base64url');
    expect(encoded.includes('=')).toBe(false);
    const decoded = decodeBase64(encoded, 'base64url');
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('can decode base64url with missing padding', () => {
    const bytes = createDeterministicBytes(31);
    const encoded = encodeBase64(bytes, 'base64url');
    const withoutPadding = encoded.replace(/=+$/g, '');
    const decoded = decodeBase64(withoutPadding, 'base64url');
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});
