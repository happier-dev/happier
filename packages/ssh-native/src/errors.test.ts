import { describe, expect, it } from 'vitest';

import { NativeSshError, normalizeNativeSshError } from './errors';

describe('native SSH errors', () => {
  it('preserves structured native SSH error codes', () => {
    const error = new NativeSshError({
      code: 'host-key-mismatch',
      message: 'Host key changed',
      detail: 'SHA256:abc',
    });

    expect(normalizeNativeSshError(error)).toBe(error);
    expect(error.code).toBe('host-key-mismatch');
    expect(error.detail).toBe('SHA256:abc');
  });

  it('normalizes unknown errors without leaking credential-shaped properties', () => {
    const error = normalizeNativeSshError({
      message: 'password hunter2 privateKeyPem -----BEGIN PRIVATE KEY-----',
      password: 'hunter2',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----',
    });

    expect(error).toBeInstanceOf(NativeSshError);
    expect(error.code).toBe('engine-internal');
    expect(error.message).toBe('Native SSH engine failed.');
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('PRIVATE KEY');
  });
});
