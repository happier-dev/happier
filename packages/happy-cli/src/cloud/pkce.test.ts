import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generatePkceCodes } from './pkce';

describe('generatePkceCodes', () => {
  it('keeps verifier length within RFC 7636 bounds (43..128) even when bytes is too small', () => {
    const { verifier } = generatePkceCodes(1);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('keeps verifier length within RFC 7636 bounds (43..128) even when bytes is too large', () => {
    const { verifier } = generatePkceCodes(10_000);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('returns a base64url SHA-256 challenge derived from the verifier', () => {
    const { verifier, challenge } = generatePkceCodes();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('returns verifier using only unreserved characters', () => {
    const { verifier } = generatePkceCodes();
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/);
  });
});

