import { describe, expect, it } from 'vitest';

import { resolveApiListenHost } from './api';

describe('resolveApiListenHost', () => {
  it('defaults to 0.0.0.0', () => {
    expect(resolveApiListenHost({})).toBe('0.0.0.0');
  });

  it('prefers HAPPIER_SERVER_HOST', () => {
    expect(resolveApiListenHost({ HAPPIER_SERVER_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('falls back to HAPPY_SERVER_HOST', () => {
    expect(resolveApiListenHost({ HAPPY_SERVER_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

