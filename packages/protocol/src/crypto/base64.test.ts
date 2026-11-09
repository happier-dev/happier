import { describe, expect, it, vi } from 'vitest';
import { fromByteArray } from 'base64-js';

import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from './base64.js';

function createDeterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = i % 251;
  }
  return out;
}

describe('protocol base64 helpers', () => {
  it('preserves RFC 4648 vectors and binary views with and without a native encoder', () => {
    // RFC 4648 section 10; the same encoding is used by the 0.2 Protocol owner.
    const vectors = [
      ['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
    ];
    const backing = createDeterministicBytes(260);
    const views = [backing.subarray(1, 257), backing.subarray(2, 258), backing.subarray(3, 259)];
    const expectedViews = views.map((bytes) => fromByteArray(bytes));
    const verify = () => {
      for (const [plain, expected] of vectors) {
        expect(encodeBase64(new TextEncoder().encode(plain))).toBe(expected);
      }
      for (const [index, bytes] of views.entries()) {
        expect(encodeBase64(bytes)).toBe(expectedViews[index]);
        expect(encodeBase64(bytes, 'base64url'))
          .toBe(expectedViews[index].replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''));
      }
    };
    verify();
    vi.stubGlobal('Buffer', undefined);
    try {
      verify();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('encodes daemon-sized replies with less CPU than the portable comparator', () => {
    const bytes = createDeterministicBytes(1_048_577).subarray(1);
    const portable = () => fromByteArray(bytes);
    const canonical = () => encodeBase64(bytes);
    expect(canonical()).toBe(portable());
    const measure = (encode: () => string) => {
      encode();
      const started = process.cpuUsage();
      let length = 0;
      for (let iteration = 0; iteration < 4; iteration += 1) length += encode().length;
      const cpu = process.cpuUsage(started);
      return { cpuUs: cpu.user + cpu.system, length };
    };
    const canonicalRuns = [];
    const portableRuns = [];
    for (let sample = 0; sample < 3; sample += 1) {
      canonicalRuns.push(measure(canonical));
      portableRuns.push(measure(portable));
    }
    const median = (runs: { cpuUs: number }[]) => runs.map((run) => run.cpuUs).sort((a, b) => a - b)[1];
    const canonicalCpuUs = median(canonicalRuns);
    const portableCpuUs = median(portableRuns);
    console.info(JSON.stringify({ canonicalCpuUs, portableCpuUs, bytes: bytes.length }));
    expect(canonicalRuns.map((run) => run.length)).toEqual(portableRuns.map((run) => run.length));
    // Relative cost on the same host/workload, not a production budget or deadline.
    expect(canonicalCpuUs).toBeLessThan(portableCpuUs / 2);
  });

  it('round-trips base64', () => {
    const bytes = createDeterministicBytes(1024);
    const encoded = encodeBase64(bytes, 'base64');
    const decoded = decodeBase64(encoded, 'base64');
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
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

  it('admits canonical payloads without per-character JavaScript work or substring copies', () => {
    // The Agents profile spent 2.9s in the old JS alphabet loop. Native scanning
    // may read every byte, but JS work must not grow with the ciphertext size.
    for (const size of [4_097, 65_537]) {
      const encoded = encodeBase64(createDeterministicBytes(size));
      const characters = vi.spyOn(String.prototype, 'charCodeAt');
      const slice = vi.spyOn(String.prototype, 'slice');
      let length: number | null;
      let characterReads: number;
      let substringCopies: number;
      try {
        length = readCanonicalPaddedBase64DecodedLength(encoded);
        characterReads = characters.mock.contexts.filter(input => input === encoded).length;
        substringCopies = slice.mock.contexts.filter(input => input === encoded).length;
      } finally {
        characters.mockRestore();
        slice.mockRestore();
      }
      expect(length).toBe(size);
      expect(characterReads).toBeLessThanOrEqual(1);
      expect(substringCopies).toBe(0);
    }
  });

  it('uses native decoding without per-byte JavaScript reads and returns owned plain bytes', () => {
    const bytes = createDeterministicBytes(65_537);
    const encoded = encodeBase64(bytes);
    const characters = vi.spyOn(String.prototype, 'charCodeAt');
    let decoded: Uint8Array;
    let characterReads: number;
    try {
      decoded = decodeBase64(encoded);
      characterReads = characters.mock.contexts.filter(input => input === encoded).length;
    } finally {
      characters.mockRestore();
    }
    expect(decoded).toEqual(bytes);
    expect(characterReads).toBeLessThanOrEqual(1);
    expect(decoded.constructor).toBe(Uint8Array);
    expect(decoded.byteOffset).toBe(0);
    expect(decoded.buffer.byteLength).toBe(bytes.length);
    const copy = decoded.slice();
    copy[0] ^= 255;
    expect(decoded[0]).toBe(bytes[0]);
  });

  it('preserves strict admission across every byte at each alphabet position', () => {
    for (let code = 0; code < 256; code += 1) {
      for (let index = 0; index < 4; index += 1) {
        const input = `${'A'.repeat(index)}${String.fromCharCode(code)}${'A'.repeat(3 - index)}`;
        const isAlphabet = /^[A-Za-z0-9+/]{4}$/.test(input);
        expect(readCanonicalPaddedBase64DecodedLength(input)).toBe(isAlphabet ? 3 : index === 3 && code === 61 ? 2 : null);
      }
    }
    for (const invalid of ['AAA\ud800', 'AAA\udfff', 'AA\u2028A', 'AA\u2029A', 'AA\ufeffA']) {
      expect(readCanonicalPaddedBase64DecodedLength(invalid)).toBeNull();
    }
  });

  it('preserves permissive normalization and plain byte ownership on every decoder platform', () => {
    const vectors: [string, 'base64' | 'base64url', number[]][] = [
      ['AA=A', 'base64', [0, 0]], ['Zg==Zm8=', 'base64', [102, 6, 102]],
      ['AA-_', 'base64', [0]], ['AA-_', 'base64url', [0, 15, 191]],
      ['AB==', 'base64', [0]], ['AAA=', 'base64', [0, 0]],
      [' Zm\n9v!\u00a0', 'base64', [102, 111, 111]], ['A', 'base64', []],
    ];
    const verify = () => {
      for (const [input, variant, expected] of vectors) {
        const decoded = decodeBase64(input, variant);
        expect(Array.from(decoded)).toEqual(expected);
        expect(decoded.constructor).toBe(Uint8Array);
        expect(decoded.byteOffset).toBe(0);
        expect(decoded.buffer.byteLength).toBe(decoded.length);
      }
    };
    verify();
    // Native codec availability is a platform boundary. Keep normalization real.
    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
    const native = vi.fn((input: string) => new Uint8Array(Buffer.from(input, 'base64')));
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: native });
    try {
      verify();
      expect(native).toHaveBeenCalledTimes(vectors.length);
      expect(native.mock.calls[1][0]).toBe('ZgZm');
    } finally {
      if (descriptor) Object.defineProperty(Uint8Array, 'fromBase64', descriptor);
      else Reflect.deleteProperty(Uint8Array, 'fromBase64');
    }
    Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: undefined });
    vi.stubGlobal('Buffer', undefined);
    try {
      verify();
    } finally {
      vi.unstubAllGlobals();
      if (descriptor) Object.defineProperty(Uint8Array, 'fromBase64', descriptor);
      else Reflect.deleteProperty(Uint8Array, 'fromBase64');
    }
  });

  it('rejects invalid alphabet and padding while checking every unused padding-bit value', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (const [value, character] of [...alphabet].entries()) {
      expect(readCanonicalPaddedBase64DecodedLength(`A${character}==`))
        .toBe(value % 16 === 0 ? 1 : null);
      expect(readCanonicalPaddedBase64DecodedLength(`AA${character}=`))
        .toBe(value % 4 === 0 ? 2 : null);
    }
    for (const malformed of ['====', 'A===', '=AAA', 'AA=A', 'AAA\n', 'AA-_', 'AA\u0000A', 'AAéA', 'AA😀']) {
      expect(readCanonicalPaddedBase64DecodedLength(malformed)).toBeNull();
    }
    // Prefix-only admission must not miss malformed data at the far end.
    const largePrefix = 'A'.repeat(65_536);
    expect(readCanonicalPaddedBase64DecodedLength(`${largePrefix}!AAA`)).toBeNull();
    expect(readCanonicalPaddedBase64DecodedLength(`${largePrefix}AB==`)).toBeNull();
    expect(readCanonicalPaddedBase64DecodedLength(`${largePrefix}AAAA`)).toBe(49_155);
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
