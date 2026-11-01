import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { computeCanonicalDomainSeparatedHexDigest } from './canonicalDigest.js';
import * as canonicalDigest from './canonicalDigest.js';

describe('raw portable SHA-256', () => {
  it('preserves the known SHA-256 vector and existing UTF-8/binary bytes without domain framing', () => {
    expect(canonicalDigest.computeSha256HexDigest?.('abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const input of ['', '☃\u0000𐐷', Uint8Array.from([0, 255, 1, 128])]) {
      expect(canonicalDigest.computeSha256HexDigest(input)).toBe(createHash('sha256').update(input).digest('hex'));
    }
  });
});

describe('computeCanonicalDomainSeparatedHexDigest', () => {
  it('preserves a domain-separated lowercase SHA-256 vector across string and byte parts', () => {
    expect(computeCanonicalDomainSeparatedHexDigest(
      'happier.plugin-action.intent.v1',
      ['action:acme/reindex', Uint8Array.from([0, 1, 255])],
    )).toBe('57a1dc62b49702c89599e8e18a3433c7309d14e5c1115a0c4334cc243c6330a2');
  });
});
