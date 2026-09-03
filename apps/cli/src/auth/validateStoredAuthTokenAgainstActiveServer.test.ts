import { describe, expect, it, vi } from 'vitest';

import { validateStoredAuthTokenAgainstServer } from './validateStoredAuthTokenAgainstActiveServer';

describe('validateStoredAuthTokenAgainstServer', () => {
  it('returns invalid for 403 profile responses', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ code: 'forbidden' }),
    } as Response)) as typeof fetch;

    await expect(validateStoredAuthTokenAgainstServer({
      token: 'token-123',
      serverUrl: 'https://active.example.test',
      fetchImpl,
    })).resolves.toEqual({
      state: 'invalid',
      httpStatus: 403,
      reasonCode: 'forbidden',
    });
  });

  it('returns unknown for transport failures instead of forcing invalid auth', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await expect(validateStoredAuthTokenAgainstServer({
      token: 'token-123',
      serverUrl: 'https://active.example.test',
      fetchImpl,
    })).resolves.toEqual({
      state: 'unknown',
      httpStatus: null,
      reasonCode: 'TypeError',
    });
  });

  it('fails fast for missing tokens without calling fetch', async () => {
    const fetchMock = vi.fn();

    await expect(validateStoredAuthTokenAgainstServer({
      token: '   ',
      serverUrl: 'https://active.example.test',
      fetchImpl: fetchMock as typeof fetch,
    })).resolves.toEqual({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'missing-token',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
