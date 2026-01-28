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

  it('extracts email from id_token when present', () => {
    const idToken = makeUnsignedJwt({ email: 'user@example.com' });
    expect(deriveVendorConnectStatus({ oauth: { id_token: idToken } })).toEqual({ kind: 'connected', email: 'user@example.com' });
  });

  it('returns expired when expires_at is in the past', () => {
    const now = 1_000_000;
    expect(deriveVendorConnectStatus({ oauth: { expires_at: now - 1 } }, now)).toEqual({ kind: 'expired', email: null });
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
