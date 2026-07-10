import { describe, expect, it } from 'vitest';

import {
  assertProviderDecodedBodyWithinLimit,
  validateProviderProbeResponseMetadata,
} from './index.js';

describe('provider probe response safety', () => {
  it.each([
    ['application/json', false],
    ['application/problem+json; charset=utf-8', false],
    ['text/plain; charset=utf-8', true],
    [undefined, true],
  ] as const)('accepts bounded JSON-compatible content type %s', (contentType, compatibilityDiagnostic) => {
    expect(validateProviderProbeResponseMetadata({ contentType, contentEncoding: undefined })).toEqual({
      compatibilityDiagnostic,
      contentKind: compatibilityDiagnostic ? 'strict-json-compat' : 'json',
      encoding: 'identity',
    });
  });

  it.each([
    'text/html',
    'application/octet-stream',
    'image/png',
    'application/xml',
  ])('rejects HTML/binary/non-JSON response type %s', (contentType) => {
    expect(() => validateProviderProbeResponseMetadata({ contentType, contentEncoding: undefined })).toThrow();
  });

  it.each(['identity', 'gzip', 'deflate', 'br'])('accepts supported content encoding %s', (contentEncoding) => {
    expect(validateProviderProbeResponseMetadata({
      contentType: 'application/json',
      contentEncoding,
    }).encoding).toBe(contentEncoding);
  });

  it.each(['compress', 'zstd', 'gzip, br'])('rejects unsupported or stacked content encoding %s', (contentEncoding) => {
    expect(() => validateProviderProbeResponseMetadata({
      contentType: 'application/json',
      contentEncoding,
    })).toThrow();
  });

  it('enforces the decoded body cap after decompression', () => {
    expect(() => assertProviderDecodedBodyWithinLimit(5 * 1024 * 1024)).not.toThrow();
    expect(() => assertProviderDecodedBodyWithinLimit(5 * 1024 * 1024 + 1)).toThrow();
    expect(() => assertProviderDecodedBodyWithinLimit(-1)).toThrow();
  });
});
