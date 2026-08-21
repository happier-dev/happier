import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

vi.mock('axios');

describe('fetchAccountProfile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses the canonical endpoint selected by loaded configuration', async () => {
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', '');
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:41001');

    await import('@/configuration');

    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:52002');
    (axios.get as any).mockResolvedValue({
      status: 200,
      data: { id: 'acct_1' },
    });

    const { fetchAccountProfile } = await import('./accountProfile');
    const controller = new AbortController();

    await fetchAccountProfile({ token: 't', signal: controller.signal });

    expect((axios.get as any).mock.calls[0]?.[0]).toBe('http://127.0.0.1:41001/v1/account/profile');
    expect((axios.get as any).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
