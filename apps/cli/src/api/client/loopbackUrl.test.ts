import { describe, expect, it } from 'vitest';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

describe('resolveLoopbackHttpUrl', () => {
  it('rewrites http://localhost to http://127.0.0.1', () => {
    expect(resolveLoopbackHttpUrl('http://localhost:3005')).toBe('http://127.0.0.1:3005/');
  });

  it('preserves path/query/hash when rewriting', () => {
    expect(resolveLoopbackHttpUrl('http://localhost:3005/v1/sessions?x=1#frag')).toBe(
      'http://127.0.0.1:3005/v1/sessions?x=1#frag',
    );
  });

  it('does not rewrite https localhost (TLS certs may be bound to hostname)', () => {
    expect(resolveLoopbackHttpUrl('https://localhost:3005')).toBe('https://localhost:3005');
  });

  it('does not rewrite non-localhost urls', () => {
    expect(resolveLoopbackHttpUrl('http://127.0.0.1:3005')).toBe('http://127.0.0.1:3005');
    expect(resolveLoopbackHttpUrl('https://api.happier.dev')).toBe('https://api.happier.dev');
  });

  it('returns the original string for invalid URLs', () => {
    expect(resolveLoopbackHttpUrl('not a url')).toBe('not a url');
  });
});
