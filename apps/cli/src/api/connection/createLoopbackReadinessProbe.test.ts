import { describe, expect, it, vi } from 'vitest';

const getSpy = vi.fn();

vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => getSpy(...args) },
}));

import { createLoopbackReadinessProbe } from './createLoopbackReadinessProbe';

describe('createLoopbackReadinessProbe', () => {
  it('returns ready after health and authenticated feature checks succeed', async () => {
    getSpy.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200 });

    const probe = createLoopbackReadinessProbe({ serverUrl: 'http://localhost:4096/', token: 'token-1' });
    await expect(probe()).resolves.toEqual({ status: 'ready' });
    expect(getSpy).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4096/health', expect.objectContaining({ timeout: 5000 }));
    expect(getSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4096/v1/features', expect.objectContaining({
      timeout: 5000,
      headers: { Authorization: 'Bearer token-1' },
    }));
  });

  it('reports auth failure when the authenticated probe rejects access', async () => {
    getSpy.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 401 });

    const probe = createLoopbackReadinessProbe({ serverUrl: 'http://localhost:4096/', token: 'token-1' });
    await expect(probe()).resolves.toEqual({
      status: 'auth_failed',
      statusCode: 401,
      errorMessage: 'Authenticated probe returned 401',
    });
  });
});
