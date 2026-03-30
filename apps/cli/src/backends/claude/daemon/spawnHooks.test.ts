import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = ['PATH', 'HAPPIER_CLAUDE_PATH', 'HOME', 'HAPPIER_HOME_DIR', 'CLAUDE_CONFIG_DIR', 'HAPPIER_CLAUDE_CONFIG_DIR'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const isWindows = process.platform === 'win32';
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-claude-spawnhooks-',
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n',
  });
  const dir = dirname(binPath);
  tempDirs.add(dir);
  return { dir, binPath };
}

afterEach(async () => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  vi.resetModules();
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('claudeDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when claude is not resolvable', async () => {
    const homeDir = await createTempDir('happier-claude-spawnhooks-no-cli-home-');
    tempDirs.add(homeDir);
    envScope.patch({
      PATH: '',
      HOME: homeDir,
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_CLAUDE_PATH: undefined,
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('claude');
    expect(res.errorMessage.toLowerCase()).toContain('system install');
    expect(res.errorMessage).toContain('HAPPIER_CLAUDE_PATH');
  });

  it('allows spawn when claude is on PATH', async () => {
    const { dir } = await createFakeBin('claude');
    envScope.patch({ HAPPIER_CLAUDE_PATH: undefined, PATH: dir });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_CLAUDE_PATH points to an executable', async () => {
    const { binPath } = await createFakeBin('claude-custom');
    envScope.patch({ PATH: '', HAPPIER_CLAUDE_PATH: binPath });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_CLAUDE_PATH points to a JavaScript entrypoint file', async () => {
    envScope.patch({ PATH: '' });
    const dir = await createTempDir('happier-claude-spawnhooks-js-');
    tempDirs.add(dir);
    const entryPath = join(dir, 'claude.js');
    await writeFile(entryPath, 'import "./entry.cjs";\n', 'utf8');
    if (process.platform !== 'win32') await chmod(entryPath, 0o644);
    envScope.patch({ HAPPIER_CLAUDE_PATH: entryPath });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});

describe('claudeDaemonSpawnHooks', () => {
  it('does not expose legacy generic token auth plumbing', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect('buildAuthEnv' in claudeDaemonSpawnHooks).toBe(false);
  });
});

describe('claudeDaemonSpawnHooks.buildExtraEnvForChild', () => {
  it('does not force CLAUDE_CONFIG_DIR when no override is set', async () => {
    const homeDir = await createTempDir('happier-claude-spawnhooks-home-');
    tempDirs.add(homeDir);
    envScope.patch({
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: undefined,
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({});
  });

  it('publishes an explicit CLAUDE_CONFIG_DIR override when set', async () => {
    envScope.patch({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      HAPPIER_CLAUDE_CONFIG_DIR: undefined,
    });

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
    });
  });
});
