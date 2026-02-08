import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { readSettings } from '@/persistence';

let promptAnswers: string[] = [];

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb(promptAnswers.shift() ?? ''),
    close: () => {},
  }),
}));

const spawnHappyCLIMock = vi.fn();
vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: (...args: unknown[]) => spawnHappyCLIMock(...args),
}));

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

describe('happier server add guided flow', () => {
  it('guides for missing required values in interactive mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-guided-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setTtyMode(true, true);
    promptAnswers = [
      'https://company.example.test', // server URL
      '', // web app URL (use default)
      'Company', // profile name
      'y', // use as active
      'n', // start daemon now
    ];

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand(['add']);

      const settings = await readSettings();
      expect(settings.activeServerId).toBe('Company');
      expect(settings.servers?.Company?.serverUrl).toBe('https://company.example.test');
      expect(settings.servers?.Company?.webappUrl).toBe('https://company.example.test');
      expect(spawnHappyCLIMock).not.toHaveBeenCalled();
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      promptAnswers = [];
      spawnHappyCLIMock.mockReset();
    }
  });

  it('fails fast with instructions in non-interactive mode when required args are missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-noninteractive-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await expect(handleServerCommand(['add'])).rejects.toThrow('Non-interactive mode');
      expect(spawnHappyCLIMock).not.toHaveBeenCalled();
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('defaults webapp URL from --server-url in non-interactive mode when --webapp-url is omitted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-default-webapp-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_SERVER_URL = 'https://active-server.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://active-webapp.example.test';
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
      ]);

      const settings = await readSettings();
      expect(settings.servers?.Company?.serverUrl).toBe('https://company.example.test');
      expect(settings.servers?.Company?.webappUrl).toBe('https://company.example.test');
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });

  it('runs daemon action commands when explicit flags are passed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-actions-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const restoreTty = setTtyMode(false, false);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      spawnHappyCLIMock.mockImplementation((argv: string[]) => {
        return {
          on: (event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'close') handler(0);
            return undefined;
          },
        };
      });

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
        '--install-service',
      ]);

      expect(spawnHappyCLIMock).toHaveBeenCalledTimes(1);
      expect(spawnHappyCLIMock).toHaveBeenCalledWith(
        ['--server', 'Company', 'daemon', 'service', 'install'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      restoreTty();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
      spawnHappyCLIMock.mockReset();
    }
  });
});
