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

  it('sanitizes structured native SSH error details before surfacing diagnostics', () => {
    const error = normalizeNativeSshError({
      code: 'authentication-failed',
      message: 'Authentication failed',
      detail: 'password hunter2 private key -----BEGIN PRIVATE KEY-----',
    });

    expect(error.code).toBe('authentication-failed');
    expect(error.message).toBe('Authentication failed');
    expect(error.detail).toBe('Native SSH engine failed.');
    expect(error.detail).not.toContain('hunter2');
    expect(error.detail).not.toContain('PRIVATE KEY');
  });

  it('preserves typed Expo native error codes from nested platform payloads', () => {
    const error = normalizeNativeSshError({
      message: 'Cancelled',
      userInfo: {
        code: 'cancellation',
        message: 'Native SSH request was cancelled.',
      },
    });

    expect(error.code).toBe('cancellation');
    expect(error.message).toBe('Native SSH request was cancelled.');
  });

  it('preserves host-key-untrusted as a host-key trust failure code', () => {
    const error = normalizeNativeSshError({
      code: 'host-key-untrusted',
      message: 'SSH host key requires user trust.',
    });

    expect(error.code).toBe('host-key-untrusted');
    expect(error.message).toBe('SSH host key requires user trust.');
  });

  it('preserves host-key-rejected as a host-key trust failure code', () => {
    const error = normalizeNativeSshError({
      code: 'host-key-rejected',
      message: 'SSH host key trust was declined.',
    });

    expect(error.code).toBe('host-key-rejected');
    expect(error.message).toBe('SSH host key trust was declined.');
  });

  it('preserves native tunnel diagnostic error codes', () => {
    expect(normalizeNativeSshError({
      code: 'loopback-bind-failed',
      message: 'Native SSH loopback bind failed.',
    }).code).toBe('loopback-bind-failed');
    expect(normalizeNativeSshError({
      code: 'network-captive-portal',
      message: 'SSH transport was intercepted before the SSH banner.',
    }).code).toBe('network-captive-portal');
  });
});
