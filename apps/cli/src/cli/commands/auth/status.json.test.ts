import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsDataKey } from '@/persistence';

import { handleAuthCommand } from '../auth';

describe('happier auth status --json', () => {
  it('prints a not_authenticated JSON envelope when no credentials exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-auth-status-json-missing-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      await handleAuthCommand(['status', '--json']);

      const parsed = JSON.parse(logs.join('\n').trim());
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('auth_status');
      expect(parsed.error?.code).toBe('not_authenticated');
      expect(process.exitCode).toBe(1);
      expect(errors.length).toBe(0);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints an auth_status JSON envelope without including the bearer token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-auth-status-json-ok-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      await updateSettings((settings) => ({
        ...settings,
        machineIdByServerId: { ...(settings.machineIdByServerId ?? {}), [configuration.activeServerId ?? 'cloud']: 'mid_123' },
      }));

      await handleAuthCommand(['status', '--json']);

      const raw = logs.join('\n').trim();
      const parsed = JSON.parse(raw);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('auth_status');
      expect(parsed.data?.authenticated).toBe(true);
      expect(parsed.data?.machineId).toBe('mid_123');
      expect(parsed.data?.token).toBeUndefined();
      expect(raw).not.toContain('token_super_secret');
      expect(process.exitCode).toBe(0);
      expect(errors.length).toBe(0);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      process.exitCode = prevExitCode;
      await rm(home, { recursive: true, force: true });
    }
  });
});
