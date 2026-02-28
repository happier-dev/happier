import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { handleServerCommand } from './server';

function setTtyMode(stdinIsTTY: boolean, stdoutIsTTY: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinIsTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutIsTTY });

  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete (process.stdin as any).isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete (process.stdout as any).isTTY;
  };
}

describe('happier server add (self-heal from /v1/features capabilities)', () => {
  const previousEnv = {
    homeDir: process.env.HAPPIER_HOME_DIR,
    serverUrl: process.env.HAPPIER_SERVER_URL,
    webappUrl: process.env.HAPPIER_WEBAPP_URL,
    publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
    localServerUrl: process.env.HAPPIER_LOCAL_SERVER_URL,
    tailscaleAuto: process.env.HAPPIER_TAILSCALE_AUTO_PUBLIC_URL,
  };

  afterEach(() => {
    if (previousEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousEnv.homeDir;
    if (previousEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousEnv.serverUrl;
    if (previousEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousEnv.webappUrl;
    if (previousEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = previousEnv.publicServerUrl;
    if (previousEnv.localServerUrl === undefined) delete process.env.HAPPIER_LOCAL_SERVER_URL;
    else process.env.HAPPIER_LOCAL_SERVER_URL = previousEnv.localServerUrl;
    if (previousEnv.tailscaleAuto === undefined) delete process.env.HAPPIER_TAILSCALE_AUTO_PUBLIC_URL;
    else process.env.HAPPIER_TAILSCALE_AUTO_PUBLIC_URL = previousEnv.tailscaleAuto;
  });

  it('adopts canonicalServerUrl/webappUrl from the server when the provided server-url is local-only', async () => {
    const app = fastify({ logger: false });
    const restoreTty = setTtyMode(false, false);
    const home = await mkdtemp(join(tmpdir(), 'happier-server-selfheal-'));

    app.get('/v1/features', async () => {
      return {
        features: {},
        capabilities: {
          server: {
            canonicalServerUrl: 'https://company.example.test',
            webappUrl: 'https://app.company.example',
          },
        },
      };
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    if (!port) throw new Error('Failed to get fastify port');

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_TAILSCALE_AUTO_PUBLIC_URL = '0';
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Local',
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--use',
      ]);

      const raw = JSON.parse(await readFile(join(home, 'settings.json'), 'utf-8'));
      expect(raw?.servers?.Local?.serverUrl).toBe('https://company.example.test');
      expect(raw?.servers?.Local?.localServerUrl).toBe(`http://127.0.0.1:${port}`);
      expect(raw?.servers?.Local?.webappUrl).toBe('https://app.company.example');
    } finally {
      restoreTty();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});

