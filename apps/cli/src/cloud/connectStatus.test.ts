import { describe, expect, it } from 'vitest';

import { deriveVendorConnectStatus, deriveVendorConnectStatusForStatusCheck } from '@/cloud/connectStatus';

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

describe('deriveVendorConnectStatus', () => {
  it('returns not_connected when token is nullish', () => {
    expect(deriveVendorConnectStatus(null)).toEqual({ kind: 'not_connected' });
    expect(deriveVendorConnectStatus(undefined)).toEqual({ kind: 'not_connected' });
  });

  it('returns not_connected when oauth is missing', () => {
    expect(deriveVendorConnectStatus({})).toEqual({ kind: 'not_connected' });
    expect(deriveVendorConnectStatus({ oauth: null })).toEqual({ kind: 'not_connected' });
  });

  it('returns connected when oauth exists but has no expiry fields', () => {
    expect(deriveVendorConnectStatus({ oauth: {} })).toEqual({ kind: 'connected', email: null });
  });

  it('handles malformed oauth payload shapes without throwing', () => {
    expect(deriveVendorConnectStatus({ oauth: 'not-an-object' })).toEqual({ kind: 'connected', email: null });
    expect(deriveVendorConnectStatus({ oauth: [] })).toEqual({ kind: 'connected', email: null });
  });

  it('extracts email from id_token when present', () => {
    const idToken = makeUnsignedJwt({ email: 'user@example.com' });
    expect(deriveVendorConnectStatus({ oauth: { id_token: idToken } })).toEqual({ kind: 'connected', email: 'user@example.com' });
  });

  it('treats blank email from id_token as null', () => {
    const idToken = makeUnsignedJwt({ email: '   ' });
    expect(deriveVendorConnectStatus({ oauth: { id_token: idToken } })).toEqual({ kind: 'connected', email: null });
  });

  it('returns expired when expires_at is in the past', () => {
    const now = 1_000_000;
    expect(deriveVendorConnectStatus({ oauth: { expires_at: now - 1 } }, now)).toEqual({ kind: 'expired', email: null });
  });

  it('prefers expires_at over expires_in when both are present', () => {
    const now = 1_000_000;
    expect(
      deriveVendorConnectStatus({ oauth: { expires_at: now - 1, expires_in: 9_999 } }, now),
    ).toEqual({ kind: 'expired', email: null });
  });

  it('falls back to expires_in when expires_at is invalid', () => {
    const now = 1_000_000;
    expect(
      deriveVendorConnectStatus({ oauth: { expires_at: 'bad-value', expires_in: 120 } }, now),
    ).toEqual({ kind: 'connected', email: null });
  });

  it('treats negative expires_in as expired', () => {
    const now = 1_000_000;
    expect(deriveVendorConnectStatus({ oauth: { expires_in: -1 } }, now)).toEqual({ kind: 'expired', email: null });
  });

  it('ignores invalid expires_in numeric values', () => {
    const now = 1_000_000;
    expect(deriveVendorConnectStatus({ oauth: { expires_in: Number.NaN } }, now)).toEqual({ kind: 'connected', email: null });
    expect(deriveVendorConnectStatus({ oauth: { expires_in: Number.POSITIVE_INFINITY } }, now)).toEqual({ kind: 'connected', email: null });
  });

  it('does not throw on invalid id_token', () => {
    expect(deriveVendorConnectStatus({ oauth: { id_token: 'not-a-jwt' } })).toEqual({ kind: 'connected', email: null });
  });
});

describe('deriveVendorConnectStatusForStatusCheck', () => {
  it('returns unknown when the token check fails', () => {
    expect(deriveVendorConnectStatusForStatusCheck({ error: new Error('boom'), token: null })).toEqual({
      kind: 'unknown',
      email: null,
    });
  });
});
