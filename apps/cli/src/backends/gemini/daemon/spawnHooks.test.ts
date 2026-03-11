import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_GEMINI_PATH: process.env.HAPPIER_GEMINI_PATH,
};

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-gemini-spawnhooks-'));
  tempDirs.add(dir);
  const binPath = join(dir, name);
  await writeFile(binPath, '#!/bin/sh\necho ok\n', 'utf8');
  await chmod(binPath, 0o755);
  return { dir, binPath };
}

afterEach(async () => {
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_ENV.HAPPIER_HOME_DIR;
  if (ORIGINAL_ENV.HAPPIER_GEMINI_PATH === undefined) delete process.env.HAPPIER_GEMINI_PATH;
  else process.env.HAPPIER_GEMINI_PATH = ORIGINAL_ENV.HAPPIER_GEMINI_PATH;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('geminiDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when gemini is not resolvable', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await geminiDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('gemini');
    expect(res.errorMessage.toLowerCase()).toContain('system install');
    expect(res.errorMessage.toLowerCase()).toContain('managed install');
  });

  it('allows spawn when gemini is on PATH', async () => {
    delete process.env.HAPPIER_GEMINI_PATH;
    const { dir } = await createFakeBin('gemini');
    process.env.PATH = dir;

    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await geminiDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_GEMINI_PATH points to an executable', async () => {
    process.env.PATH = '';
    const { binPath } = await createFakeBin('gemini-custom');
    process.env.HAPPIER_GEMINI_PATH = binPath;

    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await geminiDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when a managed gemini install exists', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_GEMINI_PATH;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-gemini-managed-home-'));
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

    const { resolveProviderCliManagedCommandPath } = await import('@/runtime/managedTools/providerCliResolution');
    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(join(binPath, '..'), { recursive: true });
    await writeFile(binPath, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(binPath, 0o755);

    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await geminiDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});
