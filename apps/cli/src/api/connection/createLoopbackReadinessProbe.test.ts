import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol';

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: { get: axiosGet },
}));

import { createLoopbackReadinessProbe } from './createLoopbackReadinessProbe';

describe('createLoopbackReadinessProbe', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    vi.unstubAllGlobals();
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
