import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim, writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = ['PATH', 'HAPPIER_HOME_DIR', 'HAPPIER_GEMINI_PATH'] as const;
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeBin(name: string): Promise<{ dir: string; binPath: string }> {
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-gemini-spawnhooks-',
    fileName: process.platform === 'win32' ? `${name}.cmd` : name,
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
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

    const homeDir = await createTempDir('happier-gemini-managed-home-');
    tempDirs.add(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

    const { resolveProviderCliManagedCommandPath } = await import('@/runtime/managedTools/providerCliResolution');
    const binPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(join(binPath, '..'), { recursive: true });
    await writeExecutableShim({
      dir: dirname(binPath),
      fileName: basename(binPath),
      contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
    });

    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await geminiDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});

describe('geminiDaemonSpawnHooks', () => {
  it('does not expose legacy generic token auth plumbing', async () => {
    const { geminiDaemonSpawnHooks } = await import('./spawnHooks');
    expect('buildAuthEnv' in geminiDaemonSpawnHooks).toBe(false);
  });
});
