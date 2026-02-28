import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
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
    expect(res.errorMessage.toLowerCase()).toContain('path');
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
});

