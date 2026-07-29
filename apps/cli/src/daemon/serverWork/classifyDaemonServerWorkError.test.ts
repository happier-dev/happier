import { describe, expect, it } from 'vitest';

import { createHttpStatusError } from '@/api/client/httpStatusError';
import { ConnectedServiceQuotaApiError } from '@/api/connectedServices/connectedServiceQuotaApiError';
import { classifyDaemonServerWorkError } from './classifyDaemonServerWorkError';

describe('classifyDaemonServerWorkError', () => {
  it('surfaces auth failures distinctly from transient network failures', () => {
    expect(classifyDaemonServerWorkError(createHttpStatusError(401, 'auth expired'))).toMatchObject({
      kind: 'auth_failed',
      retryable: false,
      statusCode: 401,
    });

    expect(classifyDaemonServerWorkError({ code: 'ECONNRESET' })).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('honors retry-after for rate-limited server work', () => {
    const classification = classifyDaemonServerWorkError({
      response: {
        status: 429,
        headers: { 'retry-after': '3' },
      },
    });

    expect(classification).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 3000,
    });
  });

  it('classifies connected-service quota API rate limits from preserved error fields', () => {
    const classification = classifyDaemonServerWorkError(new ConnectedServiceQuotaApiError({
      message: 'quota write failed',
      kind: 'retryable',
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
    }));

    expect(classification).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 7000,
    });
  });

  it('classifies wrapped connected-service quota transport timeouts as retryable timeouts', () => {
    const classification = classifyDaemonServerWorkError(new ConnectedServiceQuotaApiError({
      message: 'Failed to save connected-service quota snapshot',
      kind: 'retryable',
      retryable: true,
      cause: {
        code: 'ECONNABORTED',
        message: 'timeout of 10000ms exceeded',
      },
    }));

    expect(classification).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
  });

  it('classifies account-mode dependency unavailability as retryable work deferral', () => {
    expect(classifyDaemonServerWorkError({
      code: 'HAPPIER_ACCOUNT_MODE_UNKNOWN',
      retryAfterMs: 1000,
      message: 'Account encryption mode is unavailable',
    })).toMatchObject({
      kind: 'dependency_unavailable',
      retryable: true,
      retryAfterMs: 1000,
    });
  });

  it('classifies connected-service state-sharing lock contention as retryable dependency unavailability', () => {
    expect(classifyDaemonServerWorkError({
      code: 'state_sharing_lock_unavailable',
      retryAfterMs: 250,
      message: 'Connected service state-sharing lock is unavailable',
    })).toMatchObject({
      kind: 'dependency_unavailable',
      retryable: true,
      retryAfterMs: 250,
    });
  });

  it('treats wrapped timeout messages without preserved codes as retryable timeouts', () => {
    expect(classifyDaemonServerWorkError(
      new Error('Failed to get account encryption mode: timeout of 5000ms exceeded'),
    )).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });

    expect(classifyDaemonServerWorkError(
      new Error('Socket timeout (the database failed to respond to a query within the configured timeout)'),
    )).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
  });

  it('recovers a network code from a wrapped error via cause (preserved across api.ts re-throw)', () => {
    const original = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:52753'), { code: 'ECONNREFUSED' });
    const wrapped = new Error('Failed to get connected service auth group: connect ECONNREFUSED 127.0.0.1:52753', {
      cause: original,
    });
    expect(classifyDaemonServerWorkError(wrapped)).toMatchObject({ kind: 'network', retryable: true });
  });

  it('classifies a stripped network message (no code/cause) as retryable network via the message fallback', () => {
    expect(classifyDaemonServerWorkError(
      new Error('Failed to get connected service auth group: connect ECONNREFUSED 127.0.0.1:52753'),
    )).toMatchObject({ kind: 'network', retryable: true });

    expect(classifyDaemonServerWorkError(new Error('socket hang up')))
      .toMatchObject({ kind: 'network', retryable: true });
  });

  it('classifies configured 404 responses as unsupported feature absence', () => {
    expect(classifyDaemonServerWorkError(
      createHttpStatusError(404, 'not found'),
      { featureAbsentStatusCodes: [404] },
    )).toMatchObject({
      kind: 'unsupported',
      retryable: false,
      statusCode: 404,
    });

    expect(classifyDaemonServerWorkError(createHttpStatusError(404, 'not found'))).toMatchObject({
      kind: 'client_error',
      retryable: false,
      statusCode: 404,
    });
  });
});
