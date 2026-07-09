import { afterEach, describe, expect, it, vi } from 'vitest';

type RuntimeFetchInit = RequestInit & { signal: AbortSignal };

const runtimeFetch = vi.fn<(input: RequestInfo | URL, init: RuntimeFetchInit) => Promise<Response>>();

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init: RuntimeFetchInit) => runtimeFetch(input, init),
}));

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

describe('fetchWithTimeout', () => {
  afterEach(() => {
    runtimeFetch.mockReset();
    vi.useRealTimers();
  });

  it('forwards an external abort to the in-flight request and surfaces a typed abort', async () => {
    runtimeFetch.mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError('request aborted')));
      }),
    );

    const { fetchWithTimeout } = await import('./fetchWithTimeout');
    const external = new AbortController();
    const promise = fetchWithTimeout('https://example.com', undefined, 10_000, 'stt_timeout', external.signal);

    external.abort();

    await expect(promise).rejects.toThrow('aborted');
  });

  it('aborts immediately when the external signal is already aborted', async () => {
    runtimeFetch.mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(abortError('already aborted'));
          return;
        }
        init.signal.addEventListener('abort', () => reject(abortError('already aborted')));
      }),
    );

    const { fetchWithTimeout } = await import('./fetchWithTimeout');
    const external = new AbortController();
    external.abort();

    await expect(
      fetchWithTimeout('https://example.com', undefined, 10_000, 'stt_timeout', external.signal),
    ).rejects.toThrow('aborted');
  });

  it('removes the external abort listener after the request settles (no leak)', async () => {
    runtimeFetch.mockResolvedValue({ ok: true } as Response);

    const { fetchWithTimeout } = await import('./fetchWithTimeout');
    const external = new AbortController();
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');

    await fetchWithTimeout('https://example.com', undefined, 10_000, 'stt_timeout', external.signal);

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // A late abort after completion must not reach the request's controller.
    expect(() => external.abort()).not.toThrow();
  });

  it('still maps a timeout abort to the timeout error code when no external signal is provided', async () => {
    vi.useFakeTimers();
    runtimeFetch.mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError('timed out')));
      }),
    );

    const { fetchWithTimeout } = await import('./fetchWithTimeout');
    const promise = fetchWithTimeout('https://example.com', undefined, 5_000, 'stt_timeout');
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).rejects.toThrow('stt_timeout');
  });
});
