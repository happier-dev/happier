import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type ComparableKeyFunction = (url: string) => string;

function readComparableKeyFunction(name: string): ComparableKeyFunction {
  const candidate = (protocol as Record<string, unknown>)[name];
  expect(typeof candidate).toBe('function');
  return candidate as ComparableKeyFunction;
}

describe('server URL comparable key exports', () => {
  it('exports the identity helpers', () => {
    readComparableKeyFunction('canonicalizeServerUrlForIdentity');
    readComparableKeyFunction('createServerUrlComparableKey');
  });
});

describe('canonicalizeServerUrlForIdentity', () => {
  it('normalizes case, trims whitespace, and strips path/query/hash to origin identity', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(canonicalize('  HTTP://Example.COM:443/path/to/relay?x=1#fragment  ')).toBe('http://example.com:443');
  });

  it('removes explicit default ports for http and https', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(canonicalize('https://example.com:443/path')).toBe('https://example.com');
    expect(canonicalize('http://example.com:80/path')).toBe('http://example.com');
  });

  it('defaults to https for host input without an explicit scheme', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(canonicalize('Example.com/some/path')).toBe('https://example.com');
  });

  it('treats localhost variants as the same identity', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(canonicalize('http://127.0.0.1:3012/path')).toBe('http://localhost:3012');
    expect(canonicalize('http://localhost:3012')).toBe('http://localhost:3012');
    expect(canonicalize('http://[::1]:3012/path')).toBe('http://localhost:3012');
    expect(canonicalize('http://qa-stack.localhost.:3012/path')).toBe('http://localhost:3012');
  });

  it('preserves bracketed IPv6 literal formatting for origin-level identity', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(canonicalize('http://[2001:db8::1]:3012/path')).toBe('http://[2001:db8::1]:3012');
  });

  it('throws a stable typed error for invalid input', () => {
    const canonicalize = readComparableKeyFunction('canonicalizeServerUrlForIdentity');

    expect(() => canonicalize('   ')).toThrow(expect.objectContaining({
      code: 'invalid_server_url',
    }));
    expect(() => canonicalize('ftp://example.com')).toThrow(expect.objectContaining({
      code: 'invalid_server_url',
    }));
  });
});

describe('createServerUrlComparableKey', () => {
  it('returns the canonical origin-level identity key', () => {
    const createComparableKey = readComparableKeyFunction('createServerUrlComparableKey');

    expect(createComparableKey('https://example.com/path')).toBe('https://example.com');
    expect(createComparableKey('https://example.com:443/another-path?x=1')).toBe('https://example.com');
  });
});
