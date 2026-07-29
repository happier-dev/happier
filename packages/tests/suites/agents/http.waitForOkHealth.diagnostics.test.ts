import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForOkHealth } from '../../src/testkit/http';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitForOkHealth diagnostics', () => {
  it('includes last fetch error context on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(waitForOkHealth('http://127.0.0.1:65530', { timeoutMs: 60, intervalMs: 10 })).rejects.toThrow(
      /lastError=.*network down/i,
    );
  });

  it('includes last health response status on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'degraded' }), { status: 503 })),
    );

    await expect(waitForOkHealth('http://127.0.0.1:65531', { timeoutMs: 60, intervalMs: 10 })).rejects.toThrow(
      /lastStatus=503/i,
    );
  });
});
