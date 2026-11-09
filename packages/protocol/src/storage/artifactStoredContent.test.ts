import { describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent,
  isPlainArtifactDataKeyMarker,
  isPlainArtifactStoredContent,
} from './artifactStoredContent.js';

describe('artifactStoredContent', () => {
  it('recognizes the canonical immutable key marker without decoding it again', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let index = 0; index < 100; index += 1) {
        expect(isPlainArtifactDataKeyMarker(ARTIFACT_PLAIN_DATA_KEY_MARKER)).toBe(true);
      }
      expect(parse).not.toHaveBeenCalled();
      expect(isPlainArtifactDataKeyMarker(encodePlainArtifactStoredContent({ value: null }))).toBe(false);
      expect(isPlainArtifactDataKeyMarker('malformed')).toBe(false);
      expect(parse).toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('rejects an encrypted data-key envelope as plain without decoding or parsing it', () => {
    // A sealed data key is binary; only bytes that can begin a JSON object may reach the JSON reader.
    const sealedKey = Buffer.from(Uint8Array.from({ length: 73 }, (_, index) => (index * 37 + 1) % 256)).toString('base64');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let index = 0; index < 100; index += 1) {
        expect(isPlainArtifactDataKeyMarker(sealedKey)).toBe(false);
        expect(isPlainArtifactStoredContent(sealedKey)).toBe(false);
      }
      expect(parse).not.toHaveBeenCalled();
      // Leading JSON whitespace and a UTF-8 byte-order mark still reach the tolerant reader.
      const spaced = Buffer.from(` \n{"t":"plain","v":null}`, 'utf8').toString('base64');
      const marked = Buffer.from(`\uFEFF{"t":"plain","v":null}`, 'utf8').toString('base64');
      expect(isPlainArtifactDataKeyMarker(spaced)).toBe(true);
      expect(isPlainArtifactDataKeyMarker(marked)).toBe(true);
      expect(isPlainArtifactDataKeyMarker(` ${ARTIFACT_PLAIN_DATA_KEY_MARKER}`)).toBe(true);
    } finally { parse.mockRestore(); }
  });
  it('opens unknown stored envelope fields without altering opaque JSON content', () => {
    const value = { custom: { extra: true } };
    const encoded = Buffer.from(JSON.stringify({ t: 'plain', v: value, extra: true }), 'utf8').toString('base64');
    expect(decodePlainArtifactStoredContent(encoded)).toEqual(value);
    expect(isPlainArtifactStoredContent(encoded)).toBe(true);
    expect(isPlainArtifactDataKeyMarker(Buffer.from(JSON.stringify({ t: 'plain', v: null, extra: true }), 'utf8').toString('base64'))).toBe(true);
  });
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
