import { afterEach, describe, expect, it, vi } from 'vitest';

describe('configuration apiServerUrl', () => {
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;
  const prevPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const prevHomeDir = process.env.HAPPIER_HOME_DIR;

  afterEach(() => {
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;

    if (prevLocalServerUrl === undefined) delete process.env.HAPPIER_LOCAL_SERVER_URL;
    else process.env.HAPPIER_LOCAL_SERVER_URL = prevLocalServerUrl;

    if (prevPublicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = prevPublicServerUrl;

    if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;

    if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHomeDir;

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
});

