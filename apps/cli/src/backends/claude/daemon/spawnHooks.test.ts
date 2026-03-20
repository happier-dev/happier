import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  HAPPIER_CLAUDE_PATH: process.env.HAPPIER_CLAUDE_PATH,
  HOME: process.env.HOME,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
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
  if (ORIGINAL_ENV.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_ENV.HOME;
  if (ORIGINAL_ENV.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = ORIGINAL_ENV.HAPPIER_HOME_DIR;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('claudeDaemonSpawnHooks.validateSpawn', () => {
  it('rejects spawn when claude is not resolvable', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-spawnhooks-no-cli-home-'));
    tempDirs.add(homeDir);
    process.env.PATH = '';
    process.env.HOME = homeDir;
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_CLAUDE_PATH;

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected validation to fail');
    expect(res.errorMessage.toLowerCase()).toContain('claude');
    expect(res.errorMessage.toLowerCase()).toContain('system install');
    expect(res.errorMessage).toContain('HAPPIER_CLAUDE_PATH');
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

  it('allows spawn when HAPPIER_CLAUDE_PATH points to a JavaScript entrypoint file', async () => {
    process.env.PATH = '';
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-spawnhooks-js-'));
    tempDirs.add(dir);
    const entryPath = join(dir, 'claude.js');
    await writeFile(entryPath, 'import "./entry.cjs";\n', 'utf8');
    if (process.platform !== 'win32') await chmod(entryPath, 0o644);
    process.env.HAPPIER_CLAUDE_PATH = entryPath;

    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.validateSpawn!({});
    expect(res.ok).toBe(true);
  });
});

describe('claudeDaemonSpawnHooks.buildAuthEnv', () => {
  it('maps setup-token strings to CLAUDE_CODE_SETUP_TOKEN', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.buildAuthEnv!({ token: 'sk-ant-oat01-123' });
    expect(res.env).toMatchObject({ CLAUDE_CODE_SETUP_TOKEN: 'sk-ant-oat01-123' });
    expect(res.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('maps non-setup-token strings to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await claudeDaemonSpawnHooks.buildAuthEnv!({ token: 'oauth-access' });
    expect(res.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-access' });
    expect(res.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
  });
});

describe('claudeDaemonSpawnHooks.buildExtraEnvForChild', () => {
  it('publishes CLAUDE_CONFIG_DIR from the daemon HOME fallback when no override is set', async () => {
    const previousHome = process.env.HOME;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousHappierClaudeConfigDir = process.env.HAPPIER_CLAUDE_CONFIG_DIR;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-spawnhooks-home-'));
    tempDirs.add(homeDir);

    process.env.HOME = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HAPPIER_CLAUDE_CONFIG_DIR;

    try {
      const { claudeDaemonSpawnHooks } = await import('./spawnHooks');
      expect(claudeDaemonSpawnHooks.buildExtraEnvForChild?.({} as any)).toEqual({
        CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      if (previousHappierClaudeConfigDir === undefined) delete process.env.HAPPIER_CLAUDE_CONFIG_DIR;
      else process.env.HAPPIER_CLAUDE_CONFIG_DIR = previousHappierClaudeConfigDir;
    }
  });
});
