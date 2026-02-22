import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_CLAUDE_PATH: process.env.HAPPIER_CLAUDE_PATH,
};

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-claude-spawnhooks-'));
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
  if (ORIGINAL_ENV.HAPPIER_CLAUDE_PATH === undefined) delete process.env.HAPPIER_CLAUDE_PATH;
  else process.env.HAPPIER_CLAUDE_PATH = ORIGINAL_ENV.HAPPIER_CLAUDE_PATH;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('claudeDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when claude is not resolvable', async () => {
    process.env.PATH = '';
    delete process.env.HAPPIER_CLAUDE_PATH;

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('claude');
    expect(res.errorMessage.toLowerCase()).toContain('path');
  });

  it('allows spawn when claude is on PATH', async () => {
    delete process.env.HAPPIER_CLAUDE_PATH;
    const { dir } = await createFakeBin('claude');
    process.env.PATH = dir;

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_CLAUDE_PATH points to an executable', async () => {
    process.env.PATH = '';
    const { binPath } = await createFakeBin('claude-custom');
    process.env.HAPPIER_CLAUDE_PATH = binPath;

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});
