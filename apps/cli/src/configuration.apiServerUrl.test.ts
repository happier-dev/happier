import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_HOME_DIR',
]);

describe('configuration apiServerUrl', () => {
  afterEach(() => {
    envScope.restore();
    vi.resetModules();
  });

  it('treats HAPPIER_PUBLIC_SERVER_URL as canonical serverUrl and uses HAPPIER_SERVER_URL for apiServerUrl when they differ', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://my-stack.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.dev';

    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.serverUrl).toBe('https://my-stack.example.test');
    expect((configuration as any).apiServerUrl).toBe('http://127.0.0.1:3005');
    expect(configuration.webappUrl).toBe('https://app.happier.dev');
  });

  it('ignores a stale HAPPIER_LOCAL_SERVER_URL when HAPPIER_SERVER_URL already points at a local stack', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:41845';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:49597';
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:41845';

    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.serverUrl).toBe('http://127.0.0.1:41845');
    expect(configuration.apiServerUrl).toBe('http://127.0.0.1:41845');
    expect(configuration.webappUrl).toBe('http://127.0.0.1:41845');
  });
});
