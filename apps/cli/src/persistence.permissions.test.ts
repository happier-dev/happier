import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyEnvValues, restoreEnvValues, snapshotEnvValues } from '@/testHelpers/env.testHelper';

describe('persistence file permissions (posix)', () => {
  const envBackup = snapshotEnvValues(['HAPPIER_HOME_DIR']);
  let homeDir: string | undefined;

  beforeEach(async () => {
    if (process.platform === 'win32') return;
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-perms-'));
    applyEnvValues({ HAPPIER_HOME_DIR: homeDir });
    vi.resetModules();
  });

  afterEach(async () => {
    restoreEnvValues(envBackup);
    vi.resetModules();
    vi.unstubAllGlobals();
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('creates home dir with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { readSettings, writeSettings } = await import('@/persistence');
    await writeSettings(await readSettings());
    const s = await stat(configuration.happyHomeDir);
    expect(s.isDirectory()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });

  it('writes credentials with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { writeCredentialsLegacy } = await import('@/persistence');

    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(1), token: 't' });

    const s = await stat(configuration.privateKeyFile);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });

  it('writes daemon state with no group/other permissions', async () => {
    if (process.platform === 'win32') return;
    const { configuration } = await import('@/configuration');
    const { writeDaemonState } = await import('@/persistence');

    writeDaemonState({
      pid: 1,
      httpPort: 2,
      startedAt: 3,
      startedWithCliVersion: '0.0.0',
      controlToken: 'secret',
    });

    const s = await stat(configuration.daemonStateFile);
    expect(s.isFile()).toBe(true);
    expect(s.mode & 0o077).toBe(0);
  });
});
