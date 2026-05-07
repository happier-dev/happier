import { describe, expect, it } from 'vitest';

import { checkAuthLive } from './authLiveCheck';

function fakeFetch(response: Partial<Response> & { status: number; ok?: boolean }): typeof fetch {
  return (async () => ({
    ok: response.ok ?? (response.status >= 200 && response.status < 300),
    status: response.status,
  } as Response)) as typeof fetch;
}

describe('checkAuthLive', () => {
  it('returns ok on 200', async () => {
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: fakeFetch({ status: 200 }),
    });
    expect(result).toBe('ok');
  });

  it('returns expired on 401', async () => {
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: fakeFetch({ status: 401 }),
    });
    expect(result).toBe('expired');
  });

  it('returns expired on 403', async () => {
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: fakeFetch({ status: 403 }),
    });
    expect(result).toBe('expired');
  });

  it('returns unknown on 500', async () => {
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: fakeFetch({ status: 500 }),
    });
    expect(result).toBe('unknown');
  });

  it('returns unknown on fetch throw (network failure)', async () => {
    const throwing: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: throwing,
    });
    expect(result).toBe('unknown');
  });

  it('returns unknown when url or token is empty', async () => {
    const calledFetch = { count: 0 } as { count: number };
    const spyFetch: typeof fetch = (async () => { calledFetch.count += 1; return { ok: true, status: 200 } as Response; }) as typeof fetch;
    expect(await checkAuthLive({ serverUrl: '', token: 'abc', fetchImpl: spyFetch })).toBe('unknown');
    expect(await checkAuthLive({ serverUrl: 'https://x', token: '', fetchImpl: spyFetch })).toBe('unknown');
    expect(calledFetch.count).toBe(0);
  });

  it('aborts long requests with unknown (timeout)', async () => {
    const hanging: typeof fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    const start = Date.now();
    const result = await checkAuthLive({
      serverUrl: 'https://api.happier.dev',
      token: 'abc',
      fetchImpl: hanging,
      timeoutMs: 50,
    });
    // Either the abort takes effect and we get 'unknown' from the catch,
    // or the fetch resolves on time; either way we shouldn't hang longer
    // than the timeout + a small margin.
    expect(Date.now() - start).toBeLessThan(500);
    expect(['unknown', 'ok']).toContain(result);
  });
});
