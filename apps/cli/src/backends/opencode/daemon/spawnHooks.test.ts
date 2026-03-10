import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_OPENCODE_PATH: process.env.HAPPIER_OPENCODE_PATH,
};

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-opencode-spawnhooks-'));
  tempDirs.add(dir);
  const isWindows = process.platform === 'win32';
  const binPath = join(dir, isWindows ? `${name}.cmd` : name);
  await writeFile(binPath, isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(async () => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_OPENCODE_PATH === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
  else process.env.HAPPIER_OPENCODE_PATH = ORIGINAL_ENV.HAPPIER_OPENCODE_PATH;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('opencodeDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when opencode is not resolvable', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_OPENCODE_PATH;

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('opencode');
    expect(res.errorMessage.toLowerCase()).toContain('system install');
    expect(res.errorMessage).toContain('HAPPIER_OPENCODE_PATH');
  });

  it('allows spawn when opencode is on PATH', async () => {
    delete process.env.HAPPIER_OPENCODE_PATH;
    const { dir } = await createFakeBin('opencode');
    process.env.PATH = dir;

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_OPENCODE_PATH points to an executable', async () => {
    process.env.PATH = '';
    const { binPath } = await createFakeBin('opencode-custom');
    process.env.HAPPIER_OPENCODE_PATH = binPath;

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});
