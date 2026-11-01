import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { codexDaemonSpawnHooks } from './spawnHooks';

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
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe('codexDaemonSpawnHooks.validateSpawn', () => {
  it('uses the admitted backend mode after ACP preflight falls back to MCP', async () => {
    expect(codexDaemonSpawnHooks.resolveTerminalPresentation?.({
      host: 'tmux',
      accountSettings: null,
      runtimeSelection: { codexBackendMode: 'acp' },
      processEnv: { HAPPIER_CODEX_BACKEND_MODE: 'mcp' },
    })).toEqual({ kind: 'runner', startingMode: 'remote' });
  });
  it('validates ACP spawn when codexBackendMode=acp is set without the legacy flag', async () => {
    const cwd = await createTempDir('happier-codex-spawnhooks-cwd-');
    tempDirs.add(cwd);
    process.chdir(cwd);
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: './missing-codex-acp' });

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

    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp is not installed anywhere', async () => {
    const pathDir = await createTempDir('happier-codex-spawnhooks-empty-');
    tempDirs.add(pathDir);
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: undefined, PATH: pathDir });

    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp on PATH is not executable on Unix', async () => {
    if (process.platform === 'win32') return;

    const pathDir = await createNonExecutableBin('codex-acp');
    envScope.patch({ HAPPIER_CODEX_ACP_BIN: undefined, PATH: pathDir });

    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });
});

describe('codexDaemonSpawnHooks.validateSpawn (Codex CLI launch requirement)', () => {
  async function createIsolatedSpawnEnv(): Promise<NodeJS.ProcessEnv> {
    const home = await createTempDir('happier-codex-spawnhooks-home-');
    tempDirs.add(home);
    return { PATH: home, HOME: home, USERPROFILE: home, HAPPIER_HOME_DIR: home };
  }

  it('rejects a default App Server spawn when no Codex CLI is resolvable', async () => {
    const environmentVariables = await createIsolatedSpawnEnv();

    const res = await codexDaemonSpawnHooks.validateSpawn!({ environmentVariables });

    expect(res.ok).toBe(false);
  });

  it('admits an App Server spawn when the Codex CLI is resolvable from the spawn environment', async () => {
    const environmentVariables = { ...await createIsolatedSpawnEnv(), PATH: await createFakeBin('codex') };

    const res = await codexDaemonSpawnHooks.validateSpawn!({ codexBackendMode: 'appServer', environmentVariables });

    expect(res).toEqual({ ok: true });
  });

  it('admits an App Server spawn launched through its explicit binary override without a Codex CLI', async () => {
    const overrideDir = await createFakeBin('custom-codex');
    const environmentVariables = {
      ...await createIsolatedSpawnEnv(),
      HAPPIER_CODEX_APP_SERVER_BIN: join(overrideDir, process.platform === 'win32' ? 'custom-codex.cmd' : 'custom-codex'),
    };

    const res = await codexDaemonSpawnHooks.validateSpawn!({ codexBackendMode: 'appServer', environmentVariables });

    expect(res).toEqual({ ok: true });
  });

  it('rejects an MCP spawn without a Codex CLI even when an App Server override exists', async () => {
    const overrideDir = await createFakeBin('custom-codex');
    const environmentVariables = {
      ...await createIsolatedSpawnEnv(),
      HAPPIER_CODEX_APP_SERVER_BIN: join(overrideDir, process.platform === 'win32' ? 'custom-codex.cmd' : 'custom-codex'),
    };

    const res = await codexDaemonSpawnHooks.validateSpawn!({ codexBackendMode: 'mcp', environmentVariables });

    expect(res.ok).toBe(false);
  });
});

describe('codexDaemonSpawnHooks', () => {
  it('presents only the shared native client while retaining headless App Server controller custody', async () => {
    for (const host of ['tmux', 'zellij', 'herdr'] as const) {
      const selection = { host, accountSettings: null, processEnv: {} };
      expect(codexDaemonSpawnHooks.resolveTerminalPresentation?.({
        ...selection, runtimeSelection: { codexBackendMode: 'appServer' },
      })).toEqual({ kind: 'provider_attach', startingMode: 'local' });
      expect(codexDaemonSpawnHooks.resolveTerminalPresentation?.({
        ...selection, runtimeSelection: { codexBackendMode: 'acp' },
      })).toEqual({ kind: 'none' });
    }
  });

  it('does not expose legacy generic token auth plumbing', async () => {
    expect('buildAuthEnv' in codexDaemonSpawnHooks).toBe(false);
  });
});

describe('codexDaemonSpawnHooks.buildExtraEnvForChild', () => {
  it('publishes the ACP env marker when codexBackendMode=acp is set', async () => {
    expect(
      codexDaemonSpawnHooks.buildExtraEnvForChild?.({
        codexBackendMode: 'acp',
      } as any),
    ).toEqual({ HAPPIER_EXPERIMENTAL_CODEX_ACP: '1' });
  });

  it('does not publish the ACP env marker when codexBackendMode=appServer overrides the legacy flag', async () => {
    expect(
      codexDaemonSpawnHooks.buildExtraEnvForChild?.({
        codexBackendMode: 'appServer',
        experimentalCodexAcp: true,
      } as any),
    ).toEqual({});
  });
});
