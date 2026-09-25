import { FeaturesResponseSchema } from '@happier-dev/protocol';
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
