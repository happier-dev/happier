import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';
import { addServerProfile } from '@/server/serverProfiles';
import { handleServerCommand } from './server';

describe('happier server --json', () => {
  it('prints a server_list JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-list-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });
      await addServerProfile({ name: 'B', serverUrl: 'https://b.example.test', webappUrl: 'https://b.example.test', use: false });

      await handleServerCommand(['list', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_list');
      expect(typeof parsed.data?.activeServerId).toBe('string');
      expect(Array.isArray(parsed.data?.profiles)).toBe(true);
      expect(parsed.data.profiles.length).toBeGreaterThanOrEqual(2);
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints a server_current JSON envelope', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-json-current-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await addServerProfile({ name: 'A', serverUrl: 'https://a.example.test', webappUrl: 'https://a.example.test', use: true });

      await handleServerCommand(['current', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('server_current');
      expect(parsed.data?.active?.serverUrl).toBe('https://a.example.test');
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });
});

