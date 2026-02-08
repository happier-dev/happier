import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('server selection flags', () => {
  const prevHomeDir = process.env.HAPPIER_HOME_DIR;
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;

  afterEach(() => {
    if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHomeDir;
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;
    if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
    vi.resetModules();
  });

  it('persists a new server profile when --server-url is used (default)', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-select-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    try {
      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const { getActiveServerProfile } = await import('./serverProfiles');
      const config = await import('@/configuration');

      const remaining = await applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test']);
      expect(remaining).toEqual([]);
      expect(config.configuration.serverUrl).toBe('https://stack.example.test');
      const active = await getActiveServerProfile();
      expect(active.serverUrl).toBe('https://stack.example.test');
      expect(active.webappUrl).toBe('https://stack.example.test');
      expect(config.configuration.webappUrl).toBe('https://stack.example.test');

      const settingsRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
      expect(settingsRaw.schemaVersion).toBe(5);
      expect(settingsRaw.activeServerId).not.toBe('official');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
    }
  });

  it('does not persist when --no-persist is provided', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-select-np-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    try {
      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const { getActiveServerProfile } = await import('./serverProfiles');
      const config = await import('@/configuration');

      await applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test', '--no-persist']);
      expect(config.configuration.serverUrl).toBe('https://stack.example.test');
      expect(config.configuration.webappUrl).toBe('https://stack.example.test');
      expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://stack.example.test');
      expect((await getActiveServerProfile()).id).toBe('official');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
    }
  });

  it('rejects --persist and --no-persist together', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-select-both-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    try {
      vi.resetModules();
      const { applyServerSelectionFromArgs } = await import('./serverSelection');

      await expect(
        applyServerSelectionFromArgs(['--server-url', 'https://stack.example.test', '--persist', '--no-persist']),
      ).rejects.toThrow('Cannot use --persist and --no-persist together');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
    }
  });

  it('supports ephemeral prefix server selection without persisting settings', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-prefix-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    try {
      vi.resetModules();

      const { addServerProfile } = await import('./serverProfiles');
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const selectionMod: any = await import('./serverSelection');
      expect(typeof selectionMod.applyEphemeralServerSelectionFromPrefixArgs).toBe('function');

      const remaining = await selectionMod.applyEphemeralServerSelectionFromPrefixArgs(['--server', 'company', 'doctor']);
      expect(remaining).toEqual(['doctor']);

      const config = await import('@/configuration');
      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');

      const settingsRaw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
      expect(settingsRaw.activeServerId).toBe('official');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
    }
  });

  it('does not persist selected profile when --server is combined with --no-persist', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-select-profile-np-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

    try {
      vi.resetModules();
      const { addServerProfile, getActiveServerProfile } = await import('./serverProfiles');
      await addServerProfile({
        name: 'company',
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://app.company.example.test',
        use: false,
      });

      const { applyServerSelectionFromArgs } = await import('./serverSelection');
      const config = await import('@/configuration');

      await applyServerSelectionFromArgs(['--server', 'company', '--no-persist']);

      expect(config.configuration.serverUrl).toBe('https://company.example.test');
      expect(config.configuration.webappUrl).toBe('https://app.company.example.test');
      expect(process.env.HAPPIER_SERVER_URL).toBe('https://company.example.test');
      expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://app.company.example.test');
      expect((await getActiveServerProfile()).id).toBe('official');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
    }
  });
});
