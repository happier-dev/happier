import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerFetchConnectivityTimeoutError, ServerFetchWriteTimeoutError } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff, SupersededOperationError } from '@/utils/timing/time';

import {
  classifyConnectedServiceTransportFailure,
  ConnectedServiceNetworkError,
  connectedServiceFetch,
  isConnectedServicePreDispatchFailure,
} from './connectedServiceNetworkError';

describe('classifyConnectedServiceTransportFailure', () => {
  it.each([
    ['browser fetch rejection', new TypeError('Failed to fetch')],
    ['react native rejection', new TypeError('Network request failed')],
    ['safari rejection', new TypeError('Load failed')],
  ])('classifies a %s as unreachable', (_name, error) => {
    expect(classifyConnectedServiceTransportFailure(error)).toBe('unreachable');
  });

  it.each([
    ['write timeout', new ServerFetchWriteTimeoutError()],
    ['reachability wait timeout', new ServerFetchConnectivityTimeoutError()],
  ])('classifies a %s as a timeout', (_name, error) => {
    expect(classifyConnectedServiceTransportFailure(error)).toBe('timeout');
  });

  it('does not classify caller cancellation, superseded attempts or application errors', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyConnectedServiceTransportFailure(abort)).toBeNull();
    expect(classifyConnectedServiceTransportFailure(new SupersededOperationError('superseded'))).toBeNull();
    expect(classifyConnectedServiceTransportFailure(new Error('connect_oauth_invalid_grant'))).toBeNull();
    expect(classifyConnectedServiceTransportFailure(new TypeError('Cannot read properties of undefined'))).toBeNull();
  });
});

describe('connectedServiceFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('distinguishes an offline refusal from a lost response', () => {
    const offline = new HappyError('offline', false, { kind: 'network', code: 'endpoint_offline' });
    const wrap = (cause: unknown) => new ConnectedServiceNetworkError({
      operation: 'oauth-exchange', endpoint: '/oauth/exchange', category: 'unreachable', cause,
    });
    expect(isConnectedServicePreDispatchFailure(wrap(offline))).toBe(true);
    expect(isConnectedServicePreDispatchFailure(new ServerFetchConnectivityTimeoutError())).toBe(true);
    expect(isConnectedServicePreDispatchFailure(new ServerFetchWriteTimeoutError())).toBe(false);
    expect(isConnectedServicePreDispatchFailure(wrap(new TypeError('Failed to fetch')))).toBe(false);
  });

  it('returns a rejected response without inspecting its body', async () => {
    const rejected = new Response(new ReadableStream({ start: () => {} }), { status: 404 });
    const clone = vi.spyOn(rejected, 'clone');
    vi.stubGlobal('fetch', vi.fn(async () => rejected));

    const response = await connectedServiceFetch('quota-refresh', '/v2/connect/gemini/quotas/refresh',
      { method: 'POST' }, { includeAuth: false, retry: 'none' });

    expect(response).toBe(rejected);
    expect(clone).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it('keeps the shared backoff from retrying a connectivity gate that already reported the endpoint offline', async () => {
    let attempts = 0;
    const offline = new HappyError('Server is currently unreachable', true, { kind: 'network', code: 'endpoint_offline' });

    await expect(backoff(async () => {
      attempts += 1;
      throw new ConnectedServiceNetworkError({ operation: 'listGroups', endpoint: '/v3/connect/gemini/groups', category: 'unreachable', cause: offline });
    })).rejects.toBeInstanceOf(ConnectedServiceNetworkError);
    expect(attempts).toBe(1);
  });
});
