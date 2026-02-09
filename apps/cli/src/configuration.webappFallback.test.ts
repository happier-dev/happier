import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreProcessEnv, snapshotProcessEnv } from '@/testkit/env.testkit';

describe('configuration env url fallback', () => {
  const envBackup = snapshotProcessEnv();
  const tempDirs: string[] = [];

  afterEach(() => {
    restoreProcessEnv(envBackup);
    vi.resetModules();
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('defaults webappUrl to server origin when HAPPIER_SERVER_URL is custom and webapp is unset', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://selfhost.example.test/api';
    delete process.env.HAPPIER_WEBAPP_URL;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('https://selfhost.example.test/api');
      expect(configMod.configuration.webappUrl).toBe('https://selfhost.example.test');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the official default webappUrl when HAPPIER_SERVER_URL matches the official default and webapp is unset', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://api.happier.dev';
    delete process.env.HAPPIER_WEBAPP_URL;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.serverUrl).toBe('https://api.happier.dev');
      expect(configMod.configuration.webappUrl).toBe('https://app.happier.dev');
    } finally {
      warn.mockRestore();
    }
  });

  it('normalizes trailing slashes so env HAPPIER_SERVER_URL matches persisted server profiles', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://selfhost.example.test/api',
              webappUrl: 'https://selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://selfhost.example.test/api/';
    delete process.env.HAPPIER_WEBAPP_URL;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.activeServerId).toBe('custom');
      expect(configMod.configuration.serverUrl).toBe('https://selfhost.example.test/api');
    } finally {
      warn.mockRestore();
    }
  });

  it('reuses persisted webappUrl when env server override matches a saved profile', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-'));
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://api.selfhost.example.test/v1',
              webappUrl: 'https://app.selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'https://api.selfhost.example.test/v1/';
    delete process.env.HAPPIER_WEBAPP_URL;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const configMod = await import('./configuration');
      configMod.reloadConfiguration();
      expect(configMod.configuration.activeServerId).toBe('custom');
      expect(configMod.configuration.serverUrl).toBe('https://api.selfhost.example.test/v1');
      expect(configMod.configuration.webappUrl).toBe('https://app.selfhost.example.test');
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to official when persisted activeServerId is path-unsafe', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-unsafe-id-'));
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: '../escape',
          servers: {
            '../escape': {
              id: '../escape',
              serverUrl: 'https://selfhost.example.test/api',
              webappUrl: 'https://selfhost.example.test',
            },
            official: {
              id: 'official',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.activeServerId).toBe('official');
    expect(configMod.configuration.activeServerDir).toBe(join(homeDir, 'servers', 'official'));
  });

  it('uses HAPPIER_ACTIVE_SERVER_ID override for active server scope without changing URL selection', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-active-scope-'));
    tempDirs.push(homeDir);
    const settingsFile = join(homeDir, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          schemaVersion: 5,
          activeServerId: 'custom',
          servers: {
            custom: {
              id: 'custom',
              serverUrl: 'https://api.selfhost.example.test/v1',
              webappUrl: 'https://app.selfhost.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack_main__id_default';
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    const configMod = await import('./configuration');
    configMod.reloadConfiguration();
    expect(configMod.configuration.activeServerId).toBe('stack_main__id_default');
    expect(configMod.configuration.serverUrl).toBe('https://api.selfhost.example.test/v1');
    expect(configMod.configuration.webappUrl).toBe('https://app.selfhost.example.test');
  });
});
