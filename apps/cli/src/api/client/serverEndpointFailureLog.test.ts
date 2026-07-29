import { describe, expect, it, vi } from 'vitest';

import {
  logServerEndpointFailure,
  resetServerEndpointFailureLogSamplingForTests,
} from './serverEndpointFailureLog';

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('logServerEndpointFailure', () => {
  it('samples retryable server endpoint failures without labeling them as errors', () => {
    resetServerEndpointFailureLogSamplingForTests();
    const logger = { debug: vi.fn() };
    const error = createAxiosResponseError({
      status: 503,
      headers: { 'retry-after': '2' },
    });

    const first = logServerEndpointFailure({
      logger,
      operation: 'Failed to get account encryption mode',
      error,
      nowMs: 1_000,
    });
    const second = logServerEndpointFailure({
      logger,
      operation: 'Failed to get account encryption mode',
      error,
      nowMs: 1_500,
    });

    expect(first.logged).toBe(true);
    expect(second.logged).toBe(false);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0]?.[0]).toBe(
      '[API] Failed to get account encryption mode temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(logger.debug.mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(logger.debug.mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'server_error',
        retryable: true,
        statusCode: 503,
        retryAfterMs: 2_000,
      },
    });
  });

  it('preserves retry-after-ms while sampling retryable endpoint failures', () => {
    resetServerEndpointFailureLogSamplingForTests();
    const logger = { debug: vi.fn() };
    const error = createAxiosResponseError({
      status: 429,
      headers: { 'retry-after-ms': '1500' },
    });

    const result = logServerEndpointFailure({
      logger,
      operation: 'Failed to get provider account usage snapshot',
      error,
      nowMs: 1_000,
    });

    expect(result.classification).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      statusCode: 429,
      retryAfterMs: 1_500,
    });
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0]?.[0]).not.toContain('[ERROR]');
  });

  it('keeps non-retryable failures visible as errors', () => {
    resetServerEndpointFailureLogSamplingForTests();
    const logger = { debug: vi.fn() };

    const result = logServerEndpointFailure({
      logger,
      operation: 'Failed to parse provider account usage snapshot',
      error: new Error('Invalid provider account usage snapshot response'),
      nowMs: 1_000,
    });

    expect(result.logged).toBe(true);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0]?.[0]).toBe('[API] [ERROR] Failed to parse provider account usage snapshot:');
    expect(logger.debug.mock.calls[0]?.[1]).toMatchObject({
      classification: { kind: 'protocol_error', retryable: false },
    });
  });
});
