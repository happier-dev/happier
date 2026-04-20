import { describe, expect, it } from 'vitest';

import { HttpStatusError, isAuthenticationError, isAuthenticationStatus } from '@/api/client/httpStatusError';

import {
  readNormalizedErrorCode,
} from './serverConnectionErrors';

describe('serverConnectionErrors classification helpers', () => {
  it('treats 401 and 403 as terminal authentication statuses', () => {
    expect(isAuthenticationStatus(401)).toBe(true);
    expect(isAuthenticationStatus(403)).toBe(true);
    expect(isAuthenticationStatus(404)).toBe(false);
    expect(isAuthenticationStatus(null)).toBe(false);
  });

  it('treats HttpStatusError and axios-like errors consistently', () => {
    expect(isAuthenticationError(new HttpStatusError(401, 'expired token'))).toBe(true);
    expect(isAuthenticationError({ response: { status: 403 } })).toBe(true);
    expect(isAuthenticationError({ response: { status: 500 } })).toBe(false);
  });

  it('trims and uppercases transport error codes', () => {
    expect(readNormalizedErrorCode({ code: ' etimedout ' })).toBe('ETIMEDOUT');
    expect(readNormalizedErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(readNormalizedErrorCode(new Error('missing code'))).toBe(null);
  });
});
