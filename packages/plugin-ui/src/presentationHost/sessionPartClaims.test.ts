import { describe, expect, it } from 'vitest';

import { createSessionPartClaims } from '../advanced/index.js';

describe('shared Session part claims', () => {
  it('keeps the live part with its first owner until it is released, then admits its replacement', () => {
    const claims = createSessionPartClaims();
    claims.claim(['transcript'], 'first');
    claims.claim(['transcript'], 'duplicate');
    expect(claims.owner('transcript')).toBe('first');
    claims.release(['transcript'], 'duplicate');
    expect(claims.owner('transcript')).toBe('first');
    claims.release(['transcript'], 'first');
    claims.claim(['transcript'], 'replacement');
    expect(claims.owner('transcript')).toBe('replacement');
  });

  it('never takes half a standard arrangement when another slot already owns its transcript', () => {
    const claims = createSessionPartClaims();
    claims.claim(['transcript'], 'custom-transcript');
    claims.claim(['transcript', 'composer'], 'standard-layout');
    expect(claims.owner('transcript')).toBe('custom-transcript');
    expect(claims.owner('composer')).toBeNull();
    claims.claim(['composer'], 'custom-composer');
    expect(claims.owner('composer')).toBe('custom-composer');
  });
});
