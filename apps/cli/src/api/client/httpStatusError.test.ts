import { describe, expect, it } from 'vitest';

import { CliClientUpgradeRequiredError } from '@/api/clientCompatibility/cliClientCompatibility';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  createInvalidResponseShapeError,
  HttpStatusError,
  isAuthenticationError,
  isAuthenticationStatus,
  isPermanentRequestError,
  isPermanentRequestStatus,
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

  it('classifies a rejected request as permanent only when retrying it cannot change the answer', () => {
    // A validation rejection is the shape that matters: an older server answers 400 to a record
    // kind it does not know, every single time.
    expect(isPermanentRequestStatus(400)).toBe(true);
    expect(isPermanentRequestStatus(403)).toBe(true);
    expect(isPermanentRequestStatus(404)).toBe(true);
    // 4xx by number only - each of these asks the caller to come back.
    expect(isPermanentRequestStatus(408)).toBe(false);
    expect(isPermanentRequestStatus(425)).toBe(false);
    expect(isPermanentRequestStatus(429)).toBe(false);
    expect(isPermanentRequestStatus(500)).toBe(false);
    expect(isPermanentRequestStatus(503)).toBe(false);
    expect(isPermanentRequestStatus(200)).toBe(false);

    // An unclassifiable failure must never be treated as permanent: dropping a write because a
    // socket died would lose data that a retry would have landed.
    expect(isPermanentRequestStatus(null)).toBe(false);
    expect(isPermanentRequestStatus(Number.NaN)).toBe(false);
    expect(isPermanentRequestError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentRequestError(Object.assign(new Error('econnreset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isPermanentRequestError(createHttpStatusError(400, 'Invalid parameters'))).toBe(true);
    expect(isPermanentRequestError(new HttpStatusError(503, 'busy'))).toBe(false);
  });

  it('reads a status the transport put at the TOP level rather than under a response', () => {
    // Two real shapes, neither of which has a `response`:
    // 1. `CliClientUpgradeRequiredError` — a well-formed 426 carries its status as `statusCode`.
    //    426 is permanent by definition (this build must be upgraded), so a reader blind to it
    //    answers "unclassifiable" and every writer retries the refusal forever.
    // 2. `AxiosError.status`, which axios sets from the response and is the ONLY status that
    //    survives its `toJSON()` — i.e. any axios error that crossed a serialization boundary.
    const upgradeRequired = new CliClientUpgradeRequiredError({
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        clientKind: 'session-runner',
        minimumAppVersion: '9.0.0',
        updateUrl: null,
      },
    });
    expect(readHttpStatus(upgradeRequired)).toBe(426);
    expect(isPermanentRequestError(upgradeRequired)).toBe(true);

    expect(readHttpStatus(Object.assign(new Error('Request failed with status code 400'), { status: 400 }))).toBe(400);
    expect(isPermanentRequestError({ status: 400 })).toBe(true);
    expect(isPermanentRequestError({ statusCode: 503 })).toBe(false);

    // A bare numeric `status`/`statusCode` is ambiguous by name — a process exit code and a domain
    // state number wear it too — so only a value in the HTTP range is read as one.
    expect(readHttpStatus({ status: 1 })).toBeNull();
    expect(readHttpStatus({ statusCode: 0 })).toBeNull();
    // And still only a real number: no transport in this repository stringifies a status, so a
    // string is not coerced into one.
    expect(readHttpStatus({ status: '426' })).toBeNull();
    // A nested response still wins: it is the unambiguous carrier.
    expect(readHttpStatus({ status: 500, response: { status: 404 } })).toBe(404);
  });

  it('classifies a response this client could not parse as permanent, and a transport blip as not', () => {
    // A 200 whose body does not match this build's schema is DETERMINISTIC: the bytes arrived and
    // this client rejected them, so the next identical request is answered identically. It carries
    // no status, and "statusless is retryable" would make it an unbounded write loop.
    const malformed = createInvalidResponseShapeError('Unexpected /v2/sessions/s/system-records response shape');

    expect(readHttpStatus(malformed)).toBeNull();
    expect(isPermanentRequestError(malformed)).toBe(true);
    expect(malformed).toMatchObject({ code: 'invalid_response_shape' });

    // The safety property this must not swallow: a transport failure never carries the marker.
    expect(isPermanentRequestError(new Error('socket hang up'))).toBe(false);
    expect(isPermanentRequestError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(false);
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
