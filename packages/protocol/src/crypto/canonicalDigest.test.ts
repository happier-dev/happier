import { describe, expect, it } from 'vitest';

import { computeCanonicalDomainSeparatedHexDigest } from './canonicalDigest.js';

describe('computeCanonicalDomainSeparatedHexDigest', () => {
  it('preserves a domain-separated lowercase SHA-256 vector across string and byte parts', () => {
    expect(computeCanonicalDomainSeparatedHexDigest(
      'happier.plugin-action.intent.v1',
      ['action:acme/reindex', Uint8Array.from([0, 1, 255])],
    )).toBe('57a1dc62b49702c89599e8e18a3433c7309d14e5c1115a0c4334cc243c6330a2');
  });
});
