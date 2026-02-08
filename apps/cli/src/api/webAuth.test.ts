import { afterEach, describe, expect, it, vi } from 'vitest';

describe('generateWebAuthUrl', () => {
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const prevPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
  const prevHomeDir = process.env.HAPPIER_HOME_DIR;

  afterEach(() => {
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;

    if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;

    if (prevPublicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = prevPublicServerUrl;

    if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHomeDir;

    vi.resetModules();
  });

  it('includes the server URL in the web terminal connect link', async () => {
    process.env.HAPPIER_SERVER_URL = 'https://stack.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

    vi.resetModules();
    const { generateWebAuthUrl } = await import('./webAuth');
    const { encodeBase64 } = await import('./encryption');

    const publicKey = new Uint8Array(32).fill(7);
    const key = encodeBase64(publicKey, 'base64url');
    const url = generateWebAuthUrl(publicKey);
    expect(url).toBe(
      `https://app.example.test/terminal/connect#key=${key}&server=${encodeURIComponent('https://stack.example.test')}`,
    );
  });

  it('embeds HAPPIER_PUBLIC_SERVER_URL when set (even if the API server URL is different)', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://my-stack.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://app.happier.dev';

    vi.resetModules();
    const { generateWebAuthUrl } = await import('./webAuth');
    const { encodeBase64 } = await import('./encryption');

    const publicKey = new Uint8Array(32).fill(9);
    const key = encodeBase64(publicKey, 'base64url');
    const url = generateWebAuthUrl(publicKey);
    expect(url).toBe(
      `https://app.happier.dev/terminal/connect#key=${key}&server=${encodeURIComponent('https://my-stack.example.test')}`,
    );
  });
});
