import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGINAL_ENV = {
  HAPPIER_CODEX_ACP_BIN: process.env.HAPPIER_CODEX_ACP_BIN,
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
};
const ORIGINAL_CWD = process.cwd();

const tempDirs = new Set<string>();

async function createFakeBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-'));
  tempDirs.add(dir);
  const isWindows = process.platform === 'win32';
  const bin = join(dir, isWindows ? `${name}.cmd` : name);
  await writeFile(bin, isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) await chmod(bin, 0o755);
  return dir;
}

async function createNonExecutableBin(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-nonexec-'));
  tempDirs.add(dir);
  const isWindows = process.platform === 'win32';
  const bin = join(dir, isWindows ? `${name}.cmd` : name);
  await writeFile(bin, isWindows ? ['@echo off', 'echo ok', ''].join('\r\n') : '#!/bin/sh\necho ok\n', 'utf8');
  if (!isWindows) await chmod(bin, 0o644);
  return dir;
}

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_ENV.HAPPIER_CODEX_ACP_BIN === undefined) delete process.env.HAPPIER_CODEX_ACP_BIN;
  else process.env.HAPPIER_CODEX_ACP_BIN = ORIGINAL_ENV.HAPPIER_CODEX_ACP_BIN;
  if (ORIGINAL_ENV.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_ENV.PATH;
  if (ORIGINAL_ENV.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_ENV.CODEX_HOME;
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('codexDaemonSpawnHooks.validateSpawn', () => {
  it('validates ACP spawn when codexBackendMode=acp is set without the legacy flag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-cwd-'));
    tempDirs.add(cwd);
    process.chdir(cwd);
    process.env.HAPPIER_CODEX_ACP_BIN = './missing-codex-acp';

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      codexBackendMode: 'acp',
    } as any);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected ACP spawn validation to fail');
    expect(res.errorMessage).toContain(join(cwd, 'missing-codex-acp'));
  });

  it('reports an absolute missing path for relative HAPPIER_CODEX_ACP_BIN', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-cwd-'));
    tempDirs.add(cwd);
    process.chdir(cwd);
    process.env.HAPPIER_CODEX_ACP_BIN = './missing-codex-acp';

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected ACP spawn validation to fail');
    expect(res.errorMessage).toContain(join(cwd, 'missing-codex-acp'));
  });

  it('rejects ACP spawn when codex-acp is not installed on PATH', async () => {
    delete process.env.HAPPIER_CODEX_ACP_BIN;

    const pathDir = await createFakeBin('other-cli');
    process.env.PATH = pathDir;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp is not installed anywhere', async () => {
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    const pathDir = await mkdtemp(join(tmpdir(), 'happier-codex-spawnhooks-empty-'));
    tempDirs.add(pathDir);
    process.env.PATH = pathDir;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });

  it('rejects ACP spawn when codex-acp on PATH is not executable on Unix', async () => {
    if (process.platform === 'win32') return;

    delete process.env.HAPPIER_CODEX_ACP_BIN;
    const pathDir = await createNonExecutableBin('codex-acp');
    process.env.PATH = pathDir;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.validateSpawn!({
      experimentalCodexAcp: true,
    } as any);
    expect(res.ok).toBe(false);
  });
});

describe('codexDaemonSpawnHooks.buildAuthEnv', () => {
  it('seeds temp CODEX_HOME from the current CODEX_HOME config.toml (then writes auth.json)', async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), 'happier-codex-source-home-'));
    tempDirs.add(sourceHome);
    await writeFile(join(sourceHome, 'config.toml'), '[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\",\"@context7/mcp\"]\n', 'utf8');
    process.env.CODEX_HOME = sourceHome;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const token = '{"accessToken":"token"}';
    const res = await codexDaemonSpawnHooks.buildAuthEnv!({ token } as any);
    expect(typeof res.env.CODEX_HOME).toBe('string');
    const tempHome = res.env.CODEX_HOME!;

    const seededConfig = await readFile(join(tempHome, 'config.toml'), 'utf8');
    expect(seededConfig).toContain('[mcp_servers.context7]');

    const authJson = await readFile(join(tempHome, 'auth.json'), 'utf8');
    expect(authJson).toBe(token);

    res.cleanupOnExit?.();
  });

  it('chmods sensitive files on posix when seeding config.toml', async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), 'happier-codex-source-home-log-'));
    tempDirs.add(sourceHome);
    const marker = `SEED_MARKER_${Date.now()}`;
    await writeFile(join(sourceHome, 'config.toml'), `# ${marker}\n[mcp_servers.context7]\ncommand = \"npx\"\n`, 'utf8');
    process.env.CODEX_HOME = sourceHome;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const token = '{"accessToken":"token"}';
    const res = await codexDaemonSpawnHooks.buildAuthEnv!({ token } as any);
    const tempHome = res.env.CODEX_HOME!;

    // Assert config actually seeded, but is not echoed to the seam log.
    const seededConfig = await readFile(join(tempHome, 'config.toml'), 'utf8');
    expect(seededConfig).toContain(marker);

    if (process.platform !== 'win32') {
      const authMode = (await stat(join(tempHome, 'auth.json'))).mode & 0o777;
      expect(authMode).toBe(0o600);
      const configMode = (await stat(join(tempHome, 'config.toml'))).mode & 0o777;
      expect(configMode).toBe(0o600);
    }

    res.cleanupOnExit?.();
  });

  it('does not fail when there is no config.toml to seed', async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), 'happier-codex-source-home-empty-'));
    tempDirs.add(sourceHome);
    process.env.CODEX_HOME = sourceHome;

    const { codexDaemonSpawnHooks } = await import('./spawnHooks');
    const res = await codexDaemonSpawnHooks.buildAuthEnv!({ token: '{"accessToken":"token"}' } as any);
    const tempHome = res.env.CODEX_HOME!;

    const authJson = await readFile(join(tempHome, 'auth.json'), 'utf8');
    expect(authJson).toBe('{"accessToken":"token"}');

    res.cleanupOnExit?.();
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
