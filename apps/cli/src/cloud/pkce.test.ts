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

  it.each([
    { bytes: 32, expectedLength: 43 },
    { bytes: 96, expectedLength: 128 },
  ])('respects canonical verifier length boundary for bytes=$bytes', ({ bytes, expectedLength }) => {
    const { verifier } = generatePkceCodes(bytes);
    expect(verifier.length).toBe(expectedLength);
  });

  it('treats non-finite byte input as default length', () => {
    const { verifier } = generatePkceCodes(Number.NaN);
    expect(verifier.length).toBe(43);
  });

  it('returns challenge using base64url-safe characters', () => {
    const { challenge } = generatePkceCodes();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
