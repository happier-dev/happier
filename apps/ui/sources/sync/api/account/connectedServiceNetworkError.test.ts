import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '@/log';
import { ServerFetchConnectivityTimeoutError, ServerFetchWriteTimeoutError } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff, SupersededOperationError } from '@/utils/timing/time';

import {
  classifyConnectedServiceTransportFailure,
  ConnectedServiceNetworkError,
  connectedServiceFetch,
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

  it('wraps a dropped connection with operation, endpoint and category, and logs no secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const logSpy = vi.spyOn(log, 'log').mockImplementation(() => {});

    const failure = await connectedServiceFetch(
      'oauth-exchange',
      '/v2/connect/claude-subscription/oauth/exchange?code=SECRET-CODE',
      { method: 'POST', headers: { Authorization: 'Bearer SECRET-TOKEN' }, body: JSON.stringify({ code: 'SECRET-CODE' }) },
      { includeAuth: false, retry: 'none' },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectedServiceNetworkError);
    expect(failure).toMatchObject({
      operation: 'oauth-exchange',
      endpoint: '/v2/connect/claude-subscription/oauth/exchange',
      category: 'unreachable',
    });
    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('oauth-exchange');
    expect(logged).toContain('/v2/connect/claude-subscription/oauth/exchange');
    expect(logged).toContain('unreachable');
    expect(logged).not.toContain('SECRET');
  });

  it('logs the HTTP status and server error code of a rejected request and returns the response unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'connect_oauth_invalid_grant', detail: 'SECRET-DETAIL' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    const logSpy = vi.spyOn(log, 'log').mockImplementation(() => {});

    const response = await connectedServiceFetch('oauth-exchange', '/v2/connect/gemini/oauth/exchange', { method: 'POST' }, { includeAuth: false, retry: 'none' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'connect_oauth_invalid_grant' });
    // The code is read off the caller's path, so it is logged once the body has arrived.
    await vi.waitFor(() => expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('connect_oauth_invalid_grant'));
    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('400');
    expect(logged).not.toContain('SECRET');
  });

  it('returns a rejected response without waiting for its body and logs the status immediately', async () => {
    // Headers arrive but the body never completes.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start: () => {} }), { status: 404 })));
    const logSpy = vi.spyOn(log, 'log').mockImplementation(() => {});

    const response = await connectedServiceFetch('quota-refresh', '/v2/connect/gemini/quotas/refresh', { method: 'POST' }, { includeAuth: false, retry: 'none' });

    expect(response.status).toBe(404);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('404');
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
