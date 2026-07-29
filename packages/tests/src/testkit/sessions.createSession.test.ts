import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSession } from './sessions';

function createFakeResponse(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as any;
}

describe('createSession', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards an explicit timeout to the underlying session create request', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return createFakeResponse({ session: { id: 'session-1' } });
    });
    globalThis.fetch = fetchSpy as any;

    await expect(
      createSession('http://localhost:1234', 'token', { timeoutMs: 60_000 }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

});
