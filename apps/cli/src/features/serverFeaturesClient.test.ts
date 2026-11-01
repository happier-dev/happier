import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
} from './serverFeaturesClient';

const payload = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetServerFeaturesClientForTests();
});

describe('fetchServerFeaturesSnapshot', () => {
  it('times out a stalled response body and permits a subsequent healthy observation', async () => {
    let shouldStall = true;
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (shouldStall) {
        response.write('{"features":');
      } else {
        response.end(JSON.stringify(payload));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const serverUrl = `http://127.0.0.1:${address.port}`;
      const observation = observeServerFeaturesSnapshot({ serverUrl, timeoutMs: 1_000 });
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          observation,
          new Promise<'still_waiting'>((resolve) => {
            guard = setTimeout(() => resolve('still_waiting'), 2_000);
          }),
        ]);
        expect(result).toEqual({ status: 'error', reason: 'timeout' });
      } finally {
        clearTimeout(guard);
      }
      shouldStall = false;
      await expect(observeServerFeaturesSnapshot({ serverUrl })).resolves.toMatchObject({ status: 'ready' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('supports a fresh bearer-authenticated public observation through an injected fetch boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(observeServerFeaturesSnapshot({
      serverUrl: 'https://example.test',
      token: 'home-token',
      fetchImpl,
    })).resolves.toMatchObject({ status: 'ready' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/features',
      expect.objectContaining({
        headers: { Authorization: 'Bearer home-token' },
        redirect: 'manual',
      }),
    );
  });

  it('aborts a fresh observation when the caller cancels before the attempt timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));

    const pending = observeServerFeaturesSnapshot({
      serverUrl: 'https://example.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();

    const result = await Promise.race([
      pending,
      new Promise<'still_waiting'>((resolve) => setTimeout(() => resolve('still_waiting'), 1_000)),
    ]);
    expect(result).toMatchObject({ status: 'error' });
  });

  it('does not let one caller wait budget cancel the shared request', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const impatient = fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test', timeoutMs: 10 });
    const patient = fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(impatient).resolves.toEqual({ status: 'error', reason: 'timeout' });

    resolveFetch(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(patient).resolves.toMatchObject({ status: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the last ready snapshot across a transient refresh failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toMatchObject({ status: 'ready' });
    // Advance beyond the ready TTL to force a refresh without exposing a stale
    // negative decision when that refresh encounters a transient failure.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toMatchObject({ status: 'ready' });
  });

  it('preserves the last ready snapshot across a transient response status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toMatchObject({ status: 'ready' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toMatchObject({ status: 'ready' });
  });

  it('does not preserve a ready snapshot across a non-retryable response status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toMatchObject({ status: 'ready' });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await expect(fetchServerFeaturesSnapshot({ serverUrl: 'https://example.test' })).resolves.toEqual({
      status: 'error',
      reason: 'response_status',
      httpStatus: 403,
    });
  });
});
