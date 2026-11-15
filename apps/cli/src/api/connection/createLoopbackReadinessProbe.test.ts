import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosHeaders } from 'axios';
import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol';

const axiosGet = vi.hoisted(() => vi.fn());

// Keep the real AxiosHeaders alongside the plain record accepted by Axios response types.
vi.mock('axios', async (importOriginal) => {
  const original = await importOriginal<typeof import('axios')>();
  return { ...original, default: { ...original.default, get: axiosGet } };
});

import { createLoopbackReadinessProbe } from './createLoopbackReadinessProbe';

describe('createLoopbackReadinessProbe', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    vi.unstubAllGlobals();
  });

  it('keeps an authentication infrastructure failure retryable and accepts the same token after recovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_expected' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    axiosGet.mockResolvedValueOnce({ status: 500, headers: new AxiosHeaders(), data: { error: 'Internal Server Error' } });
    axiosGet.mockResolvedValueOnce({ status: 200, headers: new AxiosHeaders() });
    const probe = createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
      expectedServerIdentityId: 'srv_expected',
    });

    await expect(probe()).resolves.toMatchObject({ status: 'retry_later' });
    await expect(probe()).resolves.toEqual({ status: 'ready' });
  });

  it('carries the server-announced maintenance window from the Home identity read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Server reload in progress', {
      status: 503,
      headers: { 'retry-after': '2', 'x-happier-retry-reason': 'server_restarting' },
    })));

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
    })()).resolves.toMatchObject({ status: 'retry_later', retryAfterMs: 2_000, reason: 'server_restarting' });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it.each([
    new AxiosHeaders({ 'Retry-After': '3', 'X-Happier-Retry-Reason': 'server_restarting' }),
    { 'retry-after': '3', 'x-happier-retry-reason': 'server_restarting' },
  ])('carries the server-announced maintenance window from authenticated response headers %#', async (headers) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_expected' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    axiosGet.mockResolvedValueOnce({
      status: 503,
      headers,
    });

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
    })()).resolves.toMatchObject({ status: 'retry_later', retryAfterMs: 3_000, reason: 'server_restarting' });
  });

  it('requires both the expected Home identity and authenticated account access', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_expected' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    axiosGet.mockResolvedValueOnce({ status: 401, data: { error: 'unauthorized' } });

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
      expectedServerIdentityId: 'srv_expected',
    })()).resolves.toMatchObject({ status: 'auth_failed', statusCode: 401 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:48123/v1/features',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(axiosGet).toHaveBeenCalledWith(
      'http://127.0.0.1:48123/v1/auth/ping',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer account-token' }),
        validateStatus: expect.any(Function),
      }),
    );
  });

  it('fails closed when the public Home identity does not match', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_other' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
      expectedServerIdentityId: 'srv_expected',
    })()).resolves.toMatchObject({ status: 'auth_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it.each([[200, 'HOME_FEATURES_UNREADABLE'], [404, 'HOME_FEATURES_ENDPOINT_MISSING']] as const)('retains HTTP %s unsupported Home features as a non-retryable refusal before authentication', async (status, code) => {
    const privateResponseBody = 'private-response-content';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(privateResponseBody, { status })));
    const result = await createLoopbackReadinessProbe({
      serverUrl: 'https://home.example.test', token: 'account-token', expectedServerIdentityId: 'srv_expected',
    })();

    expect(result).toMatchObject({ status: 'server_unreachable', failure: { code, retryable: false } });
    expect(JSON.stringify(result)).not.toContain(privateResponseBody);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('accepts identity readiness beyond the old five-second phase cutoff', async () => {
    vi.useFakeTimers();
    try {
      let respond: (response: Response) => void = () => undefined;
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((resolve, reject) => {
        respond = resolve;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
      })));
      axiosGet.mockResolvedValue({ status: 200 });
      const readiness = createLoopbackReadinessProbe({
        serverUrl: 'https://home.example.test', token: 'account-token', expectedServerIdentityId: 'srv_expected',
      })();
      await vi.advanceTimersByTimeAsync(5_001);
      respond(new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_expected' } } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      await expect(readiness).resolves.toEqual({ status: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts authenticated readiness beyond the old five-second phase cutoff', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_expected' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })));
      axiosGet.mockImplementation(async (_url: string, options: { timeout?: number }) => await new Promise((resolve, reject) => {
        // Axios applies no deadline when timeout is omitted or zero.
        const timeout = options.timeout && options.timeout > 0
          ? setTimeout(() => reject(new Error('authentication probe timed out')), options.timeout)
          : undefined;
        setTimeout(() => {
          if (timeout !== undefined) clearTimeout(timeout);
          resolve({ status: 200 });
        }, 6_000);
      }));
      const readiness = createLoopbackReadinessProbe({
        serverUrl: 'http://127.0.0.1:48123', token: 'account-token', expectedServerIdentityId: 'srv_expected',
      })();
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(readiness).resolves.toEqual({ status: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumes only the bounded feature stream before rejecting an oversized Home identity payload', async () => {
    let chunksRead = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        if (chunksRead === 1) {
          controller.enqueue(Buffer.alloc(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1));
          return;
        }
        if (chunksRead === 2) {
          controller.enqueue(Buffer.from('x'));
          return;
        }
        controller.enqueue(Buffer.from('{"mustNotBeRead":true}'));
      },
      cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
      expectedServerIdentityId: 'srv_expected',
    })()).resolves.toMatchObject({ status: 'server_unreachable' });

    expect(chunksRead).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(axiosGet).not.toHaveBeenCalled();
  });
});
