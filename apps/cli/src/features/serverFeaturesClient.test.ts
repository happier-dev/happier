import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';

import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol';

import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
  refreshServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
} from './serverFeaturesClient';

describe('fetchServerFeaturesSnapshot', () => {
  afterEach(() => {
    resetServerFeaturesClientForTests();
    vi.unstubAllGlobals();
  });

  it.each(['cancellation', 'wait budget'] as const)('retries a sole public observation abandoned by %s with a new HTTP request', async (release) => {
    const responses: ServerResponse[] = [];
    let firstArrived!: () => void;
    const firstArrival = new Promise<void>((resolve) => { firstArrived = resolve; });
    const server = createServer((_request, response) => {
      responses.push(response);
      if (responses.length === 1) firstArrived();
      else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ features: {}, capabilities: {} }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    try {
      const caller = new AbortController();
      const pending = fetchServerFeaturesSnapshot({
        serverUrl,
        ...(release === 'cancellation' ? { signal: caller.signal } : { timeoutMs: 100 }),
      });
      const released = release === 'cancellation'
        ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        : expect(pending).resolves.toEqual({ status: 'error', reason: 'timeout' });
      await firstArrival;
      if (release === 'cancellation') caller.abort();
      await released;

      const retried = await refreshServerFeaturesSnapshot({ serverUrl, timeoutMs: 200 });

      expect(responses).toHaveLength(2);
      expect(retried).toMatchObject({ status: 'ready' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });

  it('lets one of two live callers cancel without cancelling their shared HTTP request', async () => {
    const responses: ServerResponse[] = [];
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const server = createServer((_request, response) => { responses.push(response); arrived(); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    try {
      const caller = new AbortController();
      const first = fetchServerFeaturesSnapshot({ serverUrl, signal: caller.signal });
      const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      const second = fetchServerFeaturesSnapshot({ serverUrl });
      await arrival;
      caller.abort();
      await cancelled;
      responses[0].setHeader('content-type', 'application/json');
      responses[0].end(JSON.stringify({ features: {}, capabilities: {} }));

      await expect(second).resolves.toMatchObject({ status: 'ready' });
      expect(responses).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });

  it('does not let a retired request that ignores transport abort overwrite its replacement', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      if (fetchMock.mock.calls.length > 1) return Response.json({
        features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_replacement' } },
      });
      return await new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    const cancellation = new DOMException('Caller cancelled feature discovery', 'AbortError');
    const cancelled = expect(pending).rejects.toBe(cancellation);
    caller.abort(cancellation);

    await cancelled;
    expect(observedSignal?.aborted).toBe(true);
    await expect(refreshServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test', timeoutMs: 200,
    })).resolves.toMatchObject({
      status: 'ready', features: { capabilities: { serverIdentity: { serverIdentityId: 'srv_replacement' } } },
    });
    resolveRequest(Response.json({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_retired' } },
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
    })).resolves.toMatchObject({
      status: 'ready', features: { capabilities: { serverIdentity: { serverIdentityId: 'srv_replacement' } } },
    });
  });

  it('coalesces concurrent public reads and caches the ready snapshot', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn(async () => await new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' });
    const second = fetchServerFeaturesSnapshot({ serverUrl: 'https://server.example.test/' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveRequest(new Response(JSON.stringify({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ready' }),
      expect.objectContaining({ status: 'ready' }),
    ]);
    await expect(fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
    })).resolves.toMatchObject({ status: 'ready' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refreshes the shared public snapshot instead of returning its cached value', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: `srv_${fetchMock.mock.calls.length}` } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' });
    await refreshServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains the last ready public snapshot through a retryable refresh failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const ready = await fetchServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' });
    const afterFailure = await refreshServerFeaturesSnapshot({ serverUrl: 'https://server.example.test' });

    expect(ready).toMatchObject({ status: 'ready' });
    expect(afterFailure).toBe(ready);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the request-owned deadline classified as a timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Feature request timed out', 'AbortError'));
          }, { once: true });
        });
      }));
      const pending = fetchServerFeaturesSnapshot({
        serverUrl: 'https://server.example.test',
        timeoutMs: 1,
      });

      await vi.advanceTimersByTimeAsync(1_001);

      await expect(pending).resolves.toEqual({ status: 'error', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['public', 'authenticated'] as const)('waits for a valid slow %s response without a feature-owned deadline', async (projection) => {
    vi.useFakeTimers();
    try {
      let resolveRequest!: (response: Response) => void;
      let requestSignal: AbortSignal | null | undefined;
      vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
          resolveRequest = resolve;
          requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }));
      let settled = false;
      const pending = fetchServerFeaturesSnapshot({
        serverUrl: 'https://server.example.test',
        ...(projection === 'authenticated' ? { token: 'home-token' } : {}),
      }).then((snapshot) => { settled = true; return snapshot; });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled).toBe(false);
      expect(requestSignal?.aborted ?? false).toBe(false);
      resolveRequest(Response.json({ features: {}, capabilities: {} }));
      await expect(pending).resolves.toMatchObject({ status: 'ready', provenance: projection });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the authenticated exact-descriptor endpoint only when a credential is supplied', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
      token: 'home-token',
    })).resolves.toMatchObject({ status: 'ready', provenance: 'authenticated' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://server.example.test/v1/features/authenticated',
      expect.objectContaining({
        headers: { Authorization: 'Bearer home-token' },
      }),
    );
  });

  it('supports a fresh bearer-authenticated observation of the public projection through an injected fetch boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(observeServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
      token: 'home-token',
      projection: 'public',
      fetchImpl,
    })).resolves.toMatchObject({ status: 'ready', provenance: 'public' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://server.example.test/v1/features',
      expect.objectContaining({
        headers: { Authorization: 'Bearer home-token' },
      }),
    );
  });

  it.each([404, 405, 501])(
    'falls back without a bearer to the public advisory projection when the authenticated route returns %s',
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          features: {},
          capabilities: { serverIdentity: { serverIdentityId: 'srv_legacy_home' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchServerFeaturesSnapshot({
        serverUrl: 'https://legacy-home.example.test',
        token: 'home-token',
      })).resolves.toMatchObject({
        status: 'ready',
        provenance: 'public',
        features: { capabilities: { serverIdentity: { serverIdentityId: 'srv_legacy_home' } } },
      });
      expect(fetchMock).toHaveBeenNthCalledWith(1,
        'https://legacy-home.example.test/v1/features/authenticated',
        expect.objectContaining({ headers: { Authorization: 'Bearer home-token' } }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(2,
        'https://legacy-home.example.test/v1/features',
        expect.not.objectContaining({ headers: expect.anything() }),
      );
    },
  );

  it.each([401, 403, 429, 500])(
    'does not fall back to public features for authenticated response status %s',
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(fetchServerFeaturesSnapshot({
        serverUrl: 'https://server.example.test',
        token: 'home-token',
      })).resolves.toMatchObject({ status: 'error', reason: 'response_status', httpStatus: status });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('does not fall back after an authenticated network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
      token: 'home-token',
    })).resolves.toEqual({ status: 'error', reason: 'network' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an over-budget feature body without calling the unbounded JSON reader', async () => {
    const response = new Response('x'.repeat(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const json = vi.spyOn(response, 'json');
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
    })).resolves.toEqual({ status: 'unsupported', reason: 'invalid_payload' });
    expect(json).not.toHaveBeenCalled();
  });
});
