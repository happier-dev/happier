import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveAccountSettingsHttpBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the canonical endpoint selected by loaded configuration', async () => {
    vi.stubEnv('HAPPIER_LOCAL_SERVER_URL', '');
    vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', '');
    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:41001');

    await import('@/configuration');

    vi.stubEnv('HAPPIER_SERVER_URL', 'http://127.0.0.1:52002');

    const { resolveAccountSettingsHttpBaseUrl } = await import('./resolveAccountSettingsHttpBaseUrl');

    expect(resolveAccountSettingsHttpBaseUrl()).toBe('http://127.0.0.1:41001');
  });
});
