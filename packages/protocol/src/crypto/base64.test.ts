import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from './base64.js';

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

  it('decodes large canonical padded base64 with a bounded iterative scan', () => {
    const bytes = createDeterministicBytes(4096);
    const encoded = encodeBase64(bytes, 'base64');
    const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt');

    try {
      const decoded = decodeBase64(encoded, 'base64');

      expect(Array.from(decoded)).toEqual(Array.from(bytes));
      expect(charCodeAtSpy.mock.calls.length).toBeLessThan(encoded.length * 3);
    } finally {
      charCodeAtSpy.mockRestore();
    }
  });

  it('reads strict canonical padded base64 decoded lengths without decoding', () => {
    expect(readCanonicalPaddedBase64DecodedLength('')).toBe(0);
    expect(readCanonicalPaddedBase64DecodedLength('AQID')).toBe(3);
    expect(readCanonicalPaddedBase64DecodedLength('AA==')).toBe(1);
    expect(readCanonicalPaddedBase64DecodedLength('AAA=')).toBe(2);
    expect(readCanonicalPaddedBase64DecodedLength('AQI')).toBeNull();
    expect(readCanonicalPaddedBase64DecodedLength('AA=A')).toBeNull();
    expect(readCanonicalPaddedBase64DecodedLength(' AA==')).toBeNull();
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

  it('round-trips multi-megabyte canonical padded base64 payloads', () => {
    const bytes = createDeterministicBytes(3_500_000);
    const encoded = encodeBase64(bytes, 'base64');
    const decoded = decodeBase64(encoded, 'base64');

    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[1_500_000]).toBe(bytes[1_500_000]);
    expect(decoded[2_750_000]).toBe(bytes[2_750_000]);
    expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
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
