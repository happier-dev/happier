import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('elevenLabsFetchJson', () => {
  const originalFetch = globalThis.fetch;
  const originalBase = process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL;
  const originalTimeout = process.env.PUBLIC_EXPO_ELEVENLABS_API_TIMEOUT_MS;

  beforeEach(() => {
    vi.resetModules();
    globalThis.fetch = vi.fn() as any;
    process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL = 'https://api.elevenlabs.io/v1';
    process.env.PUBLIC_EXPO_ELEVENLABS_API_TIMEOUT_MS = '10000';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBase === undefined) delete process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL;
    else process.env.PUBLIC_EXPO_ELEVENLABS_API_BASE_URL = originalBase;
    if (originalTimeout === undefined) delete process.env.PUBLIC_EXPO_ELEVENLABS_API_TIMEOUT_MS;
    else process.env.PUBLIC_EXPO_ELEVENLABS_API_TIMEOUT_MS = originalTimeout;
  });

  it('aborts when caller signal is already aborted', async () => {
    (globalThis.fetch as any).mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const error = new Error('aborted');
        (error as any).name = 'AbortError';
        throw error;
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const { elevenLabsFetchJson } = await import('./elevenLabsApi');
    const callerController = new AbortController();
    callerController.abort();

    await expect(
      elevenLabsFetchJson({
        apiKey: 'xi_test',
        path: '/convai/tools',
        init: { signal: callerController.signal },
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
