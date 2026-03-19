import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('keeps the loopback server URL in the web auth link when the web app is served from that same local origin', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:26731';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:26731';
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;

    vi.resetModules();
    const { generateWebAuthUrl } = await import('./webAuth');
    const { encodeBase64 } = await import('./encryption');

    const publicKey = new Uint8Array(32).fill(13);
    const key = encodeBase64(publicKey, 'base64url');
    const url = generateWebAuthUrl(publicKey);
    expect(url).toBe(
      `http://127.0.0.1:26731/terminal/connect#key=${key}&server=${encodeURIComponent('http://127.0.0.1:26731')}`,
    );
  });

  it('uses persisted canonical serverUrl from the active server profile when HAPPIER_PUBLIC_SERVER_URL is unset', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-webAuth-public-profile-'));

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;

      await writeFile(
        join(home, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'local',
            servers: {
              local: {
                id: 'local',
                name: 'Local',
                serverUrl: 'https://my-stack.example.test',
                localServerUrl: 'http://127.0.0.1:53545',
                webappUrl: 'https://app.happier.dev',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
              },
            },
            machineIdByServerId: {},
            machineIdConfirmedByServerByServerId: {},
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );

      vi.resetModules();
      const { generateWebAuthUrl } = await import('./webAuth');
      const { encodeBase64 } = await import('./encryption');

      const publicKey = new Uint8Array(32).fill(11);
      const key = encodeBase64(publicKey, 'base64url');
      const url = generateWebAuthUrl(publicKey);
      expect(url).toBe(
        `https://app.happier.dev/terminal/connect#key=${key}&server=${encodeURIComponent('https://my-stack.example.test')}`,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
