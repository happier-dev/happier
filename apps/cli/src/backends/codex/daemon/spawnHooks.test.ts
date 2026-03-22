import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const envKeys = ['HAPPIER_CODEX_ACP_BIN', 'PATH', 'CODEX_HOME'] as const;
const ORIGINAL_CWD = process.cwd();
const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

async function createFakeBin(name: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-codex-spawnhooks-',
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n',
  });
  const dir = dirname(binPath);
  tempDirs.add(dir);
  return dir;
}

async function createNonExecutableBin(name: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const binPath = await createExecutableShim({
    dirPrefix: 'happier-codex-spawnhooks-nonexec-',
    fileName: isWindows ? `${name}.cmd` : name,
    contents: isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n',
    mode: isWindows ? undefined : 0o644,
  });
  const dir = dirname(binPath);
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  vi.resetModules();
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('codexDaemonSpawnHooks.validateSpawn', () => {
  it('validates ACP spawn when codexBackendMode=acp is set without the legacy flag', async () => {
    const cwd = await createTempDir('happier-codex-spawnhooks-cwd-');
    tempDirs.add(cwd);
    process.chdir(cwd);
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: './missing-codex-acp' });

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      codexBackendMode: 'acp',
    } as any);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected ACP spawn validation to fail');
    expect(res.errorMessage).toContain(join(cwd, 'missing-codex-acp'));
  });

  it('reports an absolute missing path for relative HAPPIER_CODEX_ACP_BIN', async () => {
    const cwd = await createTempDir('happier-codex-spawnhooks-cwd-');
    tempDirs.add(cwd);
    process.chdir(cwd);
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: './missing-codex-acp' });

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected ACP spawn validation to fail');
    expect(res.errorMessage).toContain(join(cwd, 'missing-codex-acp'));
  });

  it('rejects ACP spawn when codex-acp is not installed on PATH', async () => {
    const pathDir = await createFakeBin('other-cli');
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: undefined, PATH: pathDir });

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp is not installed anywhere', async () => {
    const pathDir = await createTempDir('happier-codex-spawnhooks-empty-');
    tempDirs.add(pathDir);
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: undefined, PATH: pathDir });

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp on PATH is not executable on Unix', async () => {
    if (process.platform === 'win32') return;

    const pathDir = await createNonExecutableBin('codex-acp');
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: undefined, PATH: pathDir });

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });
});

describe('codexDaemonSpawnHooks', () => {
  it('does not expose legacy generic token auth plumbing', async () => {
    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    expect('buildAuthEnv' in codexDaemonSpawnHooks).toBe(false);
  });
});

describe('codexDaemonSpawnHooks.buildExtraEnvForChild', () => {
  it('publishes the ACP env marker when codexBackendMode=acp is set', async () => {
    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    expect(
      codexDaemonSpawnHooks.buildExtraEnvForChild?.({
        codexBackendMode: 'acp',
      } as any),
    ).toEqual({ HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' });
  });

  it('does not publish the ACP env marker when codexBackendMode=appServer overrides the legacy flag', async () => {
    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    expect(
      codexDaemonSpawnHooks.buildExtraEnvForChild?.({
        codexBackendMode: 'appServer',
        experimentalCodexAcp: true,
      } as any),
    ).toEqual({});
  });
});
