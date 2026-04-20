import { describe, expect, it } from 'vitest';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  HttpStatusError,
  isAuthenticationError,
  isAuthenticationStatus,
  readAuthenticationStatus,
  readHttpStatus,
} from './httpStatusError';

describe('httpStatusError', () => {
  it('reads authentication statuses from minimal response-shaped errors', () => {
    expect(isAuthenticationStatus(401)).toBe(true);
    expect(isAuthenticationStatus(403)).toBe(true);
    expect(isAuthenticationStatus(500)).toBe(false);
    expect(isAuthenticationStatus(null)).toBe(false);

    expect(readHttpStatus(new HttpStatusError(401, 'expired token'))).toBe(401);
    expect(readAuthenticationStatus(new HttpStatusError(401, 'expired token'))).toBe(401);
    expect(readAuthenticationStatus(new HttpStatusError(500, 'busy'))).toBeNull();
    expect(isAuthenticationError(new HttpStatusError(403, 'forbidden'))).toBe(true);
    expect(isAuthenticationError(new HttpStatusError(500, 'busy'))).toBe(false);
  });

  it('returns null for errors without a finite response status', () => {
    expect(readHttpStatus(null)).toBeNull();
    expect(readHttpStatus(new Error('boom'))).toBeNull();
    expect(readHttpStatus({ response: { status: '401' } })).toBeNull();
    expect(isAuthenticationError({ response: { status: Number.NaN } })).toBe(false);
  });

  it('reads authentication statuses from socket connect error data', () => {
    const statusCodeAuthError = Object.assign(new Error('invalid token'), {
      data: {
        statusCode: 401,
        error: 'invalid-token',
      },
    });
    const statusAuthError = Object.assign(new Error('forbidden'), {
      data: {
        status: 403,
        error: 'forbidden',
      },
    });

    expect(readHttpStatus(statusCodeAuthError)).toBe(401);
    expect(readAuthenticationStatus(statusCodeAuthError)).toBe(401);
    expect(isAuthenticationError(statusCodeAuthError)).toBe(true);
    expect(readHttpStatus(statusAuthError)).toBe(403);
    expect(readAuthenticationStatus(statusAuthError)).toBe(403);
    expect(isAuthenticationError(statusAuthError)).toBe(true);
  });

  it('can attach a stable code to the minimal auth carrier without losing status access', () => {
    const error = createHttpStatusError(401, 'expired token', 'not_authenticated');

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({
      response: { status: 401 },
      code: 'not_authenticated',
    });
  });

  it('creates a canonical authentication error shape for terminal auth failures', () => {
    const error = createAuthenticationHttpStatusError(403, 'forbidden');

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({
      response: { status: 403 },
      code: 'not_authenticated',
    });
  });
});
