import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = ['PATH', 'HAPPIER_OPENCODE_PATH', 'HAPPIER_HOME_DIR'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const isWindows = process.platform === 'win32';
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-opencode-spawnhooks-',
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

beforeEach(() => {
  vi.resetModules();
});

describe('opencodeDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when HAPPIER_OPENCODE_PATH points to an invalid executable', async () => {
    const homeDir = await createTempDir('happier-opencode-spawnhooks-home-');
    tempDirs.add(homeDir);
    envScope.patch({
      PATH: '',
      HAPPIER_OPENCODE_PATH: join(homeDir, 'missing-opencode'),
      HAPPIER_HOME_DIR: homeDir,
    });

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('opencode');
    expect(res.errorMessage).toContain('HAPPIER_OPENCODE_PATH');
  });

  it('allows spawn when opencode is on PATH', async () => {
    const { dir } = await createFakeBin('opencode');
    envScope.patch({
      HAPPIER_OPENCODE_PATH: undefined,
      PATH: dir,
    });

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });

  it('allows spawn when HAPPIER_OPENCODE_PATH points to an executable', async () => {
    const { binPath } = await createFakeBin('opencode-custom');
    envScope.patch({
      PATH: '',
      HAPPIER_OPENCODE_PATH: binPath,
    });

    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await opencodeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});

describe('opencodeDaemonSpawnHooks', () => {
  it('does not expose legacy generic token auth plumbing', async () => {
    const { opencodeDaemonSpawnHooks } = await import('./spawnHooks');
    expect('buildAuthEnv' in opencodeDaemonSpawnHooks).toBe(false);
  });
});
