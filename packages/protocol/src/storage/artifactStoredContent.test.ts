import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent,
  isPlainArtifactDataKeyMarker,
  isPlainArtifactStoredContent,
} from './artifactStoredContent.js';

describe('artifactStoredContent', () => {
  it('round-trips plain Artifact content through the canonical stored-content envelope', () => {
    const value = { v: 1, kind: 'approval_request.v1', title: 'Approve' };
    const encoded = encodePlainArtifactStoredContent(value);

    expect(decodePlainArtifactStoredContent(encoded)).toEqual(value);
    expect(encoded).not.toContain('Approve');
  });

  it('uses one explicit plain marker and rejects malformed or encrypted content as plain', () => {
    expect(isPlainArtifactDataKeyMarker(ARTIFACT_PLAIN_DATA_KEY_MARKER)).toBe(true);
    expect(isPlainArtifactDataKeyMarker('not-a-marker')).toBe(false);
    expect(decodePlainArtifactStoredContent('not-base64')).toBeNull();
    expect(decodePlainArtifactStoredContent(
      Buffer.from(JSON.stringify({ t: 'encrypted', c: 'ciphertext' }), 'utf8').toString('base64'),
    )).toBeNull();
  });

  it.each([
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('artifact')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['BigInt', 1n],
  ])('rejects a top-level non-JSON %s value before encoding', (_label, value) => {
    expect(() => encodePlainArtifactStoredContent(value)).toThrow();
  });

  it('rejects cyclic values before encoding', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => encodePlainArtifactStoredContent(value)).toThrow();
  });

  it('rejects a plain wire envelope whose value was omitted', () => {
    const encoded = Buffer.from(JSON.stringify({ t: 'plain' }), 'utf8').toString('base64');

    expect(decodePlainArtifactStoredContent(encoded)).toBeNull();
    expect(isPlainArtifactStoredContent(encoded)).toBe(false);
  });

  it.each([
    null,
    true,
    0,
    'artifact',
    [null, false, 1, 'nested'],
    { nested: { items: [1, 2, 3] } },
  ])('retains valid JSON value %#', (value) => {
    const encoded = encodePlainArtifactStoredContent(value);
    expect(decodePlainArtifactStoredContent(encoded)).toEqual(value);
    expect(isPlainArtifactStoredContent(encoded)).toBe(true);
  });
});
