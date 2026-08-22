import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchServerFeaturesSnapshot } from './serverFeaturesClient';

describe('fetchServerFeaturesSnapshot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('propagates caller cancellation into the feature request', async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let observeAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => {
          observeAbort();
          reject(new DOMException('Feature request aborted', 'AbortError'));
        }, { once: true });
      });
    }));

    const pending = fetchServerFeaturesSnapshot({
      serverUrl: 'https://server.example.test',
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    caller.abort();

    await expect(aborted).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: 'error', reason: 'timeout' });
  });
});
