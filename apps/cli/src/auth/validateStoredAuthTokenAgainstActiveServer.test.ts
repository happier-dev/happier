import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveLoopbackHttpUrlMock = vi.hoisted(() => vi.fn((url: string) => url));

vi.mock('@/api/client/loopbackUrl', () => ({
  resolveLoopbackHttpUrl: resolveLoopbackHttpUrlMock,
}));

describe('validateStoredAuthTokenAgainstActiveServer', () => {
  const originalFetch = global.fetch;
  const originalAbortSignalTimeout = AbortSignal.timeout;
  const timeoutMock = vi.fn(() => new AbortController().signal);

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('HAPPIER_SERVER_URL', 'https://active.example.test');
    resolveLoopbackHttpUrlMock.mockClear();
    resolveLoopbackHttpUrlMock.mockImplementation((url: string) => url);
    AbortSignal.timeout = timeoutMock;
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      Reflect.deleteProperty(globalThis, 'fetch');
    } else {
      global.fetch = originalFetch;
    }
    AbortSignal.timeout = originalAbortSignalTimeout;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns invalid for 403 profile responses', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('token-123')).resolves.toEqual({
      state: 'invalid',
      httpStatus: 403,
      reasonCode: 'forbidden',
    });
  });

  it('returns unknown for transport failures instead of forcing invalid auth', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('token-123')).resolves.toEqual({
      state: 'unknown',
      httpStatus: null,
      reasonCode: 'TypeError',
    });
  });

  it('fails fast for missing tokens without calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const { validateStoredAuthTokenAgainstActiveServer } = await import('./validateStoredAuthTokenAgainstActiveServer');
    await expect(validateStoredAuthTokenAgainstActiveServer('   ')).resolves.toEqual({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'missing-token',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
