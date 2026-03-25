import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PermissionMode } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const ENV_KEYS = [
  'CODEX_HOME',
  'HAPPIER_CODEX_ACP_BIN',
  'HAPPIER_CODEX_ACP_CONFIG_OVERRIDES',
  'HAPPIER_HOME_DIR',
  'HAPPIER_CODEX_ACP_NPX_MODE',
  'HAPPIER_JS_RUNTIME_PATH',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_NODE_PATH',
  'PATH',
] as const;

const tempDirs = new Set<string>();
let envScope = createEnvKeyScope(ENV_KEYS);

async function createFakeCodexAcpBinary(): Promise<{ dir: string; bin: string }> {
  const bin = await createExecutableShim({
    dirPrefix: 'happier-codex-acp-',
    fileName: process.platform === 'win32' ? 'codex-acp.cmd' : 'codex-acp',
    contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
  });
  const dir = dirname(bin);
  tempDirs.add(dir);
  return { dir, bin };
}

async function createFakeManagedJavaScriptRuntime(homeDir: string): Promise<void> {
  const runtimeInstallDir = join(homeDir, 'tools', 'js-runtime', 'current');
  const wrapperPath = join(runtimeInstallDir, 'bin', process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime');
  const nodePath = process.platform === 'win32'
    ? join(runtimeInstallDir, 'runtime', 'node.exe')
    : join(runtimeInstallDir, 'runtime', 'bin', 'node');

  await mkdir(dirname(wrapperPath), { recursive: true });
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(wrapperPath, process.platform === 'win32' ? '@echo off\r\necho runtime\r\n' : '#!/bin/sh\necho runtime\n', 'utf8');
  await writeFile(nodePath, process.platform === 'win32' ? '@echo off\r\necho node\r\n' : '#!/bin/sh\necho node\n', 'utf8');
  if (process.platform !== 'win32') {
    await chmod(wrapperPath, 0o755);
    await chmod(nodePath, 0o755);
  }
}

async function createNonExecutableCodexAcpBinary(): Promise<{ dir: string; bin: string }> {
  const { dir, bin } = await createFakeCodexAcpBinary();
  if (process.platform !== 'win32') {
    await chmod(bin, 0o644);
  }
  return { dir, bin };
}

async function createFakeCodexHome(mcpServers: string[]): Promise<{ dir: string }> {
  const dir = await createTempDir('happier-codex-home-');
  tempDirs.add(dir);
  const configPath = join(dir, 'config.toml');
  const configBody = mcpServers.map((name) => `[mcp_servers.${name}]\ncommand = \"echo\"\nargs = []\n`).join('\n');
  await writeFile(configPath, configBody, 'utf8');
  return { dir };
}

afterEach(async () => {
  envScope.restore();
  envScope = createEnvKeyScope(ENV_KEYS);
  vi.resetModules();
  for (const dir of tempDirs) {
    await removeTempDir(dir);
  }
  tempDirs.clear();
});

describe.sequential('resolveCodexAcpSpawn', () => {
  it('preserves Codex MCP servers by default for codex-acp spawns', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;
    delete process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe(bin);
    expect(spawn.args).toEqual([]);
  }, 15_000);

  it('can disable Codex MCP servers explicitly for probe-style spawns', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;
    delete process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn({ disableUserMcpServers: true });
    expect(spawn.command).toBe(bin);
    expect(spawn.args).toEqual([
      '-c',
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.playwright.enabled=false',
      '-c',
      'mcp_servers.sequential-thinking.enabled=false',
    ]);
  }, 15_000);

  it('appends codex-acp config overrides as -c args', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;
    process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES = 'approval_policy="on-request"';

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe(bin);
    expect(spawn.args).toEqual(['-c', 'approval_policy="on-request"']);
  }, 15_000);

  it('resolves relative HAPPIER_CODEX_ACP_BIN to an absolute path', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    const savedCwd = process.cwd();
    try {
      process.chdir(dir);
      process.env.HAPPIER_CODEX_ACP_BIN = './codex-acp';

      const { resolveCodexAcpSpawn } = await import('./resolveCommand');
      const spawn = resolveCodexAcpSpawn();
      // macOS temp dirs can appear as /var/... or /private/var/... depending on resolution.
      expect(spawn.command.startsWith('/')).toBe(true);
      expect(spawn.command).toMatch(/codex-acp$/);
    } finally {
      process.chdir(savedCwd);
    }
  }, 15_000);

  it('rejects a non-executable HAPPIER_CODEX_ACP_BIN on Unix', async () => {
    if (process.platform === 'win32') return;

    const { dir: codexHome } = await createFakeCodexHome(['context7']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createNonExecutableCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    expect(() => resolveCodexAcpSpawn()).toThrow(/not executable/i);
  }, 15_000);

  it('ignores non-executable PATH codex-acp candidates on Unix', async () => {
    if (process.platform === 'win32') return;

    const { dir: codexHome } = await createFakeCodexHome(['context7']);
    process.env.CODEX_HOME = codexHome;
    const { dir, bin } = await createNonExecutableCodexAcpBinary();
    const emptyHappyHomeDir = await createTempDir('happier-codex-acp-empty-home-');
    tempDirs.add(emptyHappyHomeDir);
    process.env.PATH = dir;
    process.env.HAPPIER_HOME_DIR = emptyHappyHomeDir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(bin.endsWith('codex-acp')).toBe(true);
  }, 15_000);

  const permissionModeCases: Array<{ permissionMode: PermissionMode; expectedArgs: string[] }> = [
    {
      permissionMode: 'safe-yolo',
      expectedArgs: [
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="workspace-write"',
      ],
    },
    {
      permissionMode: 'read-only',
      expectedArgs: [
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="read-only"',
      ],
    },
    {
      permissionMode: 'default',
      expectedArgs: [
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="read-only"',
      ],
    },
    {
      permissionMode: 'plan',
      expectedArgs: [
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="read-only"',
      ],
    },
  ];

  it('appends permission-mode-derived overrides after env overrides', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;
    process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES = 'approval_policy="on-request"';

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn({ permissionMode: 'yolo' });
    expect(spawn.command).toBe(bin);
    expect(spawn.args).toEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="danger-full-access"',
    ]);
  }, 15_000);

  it.each(permissionModeCases)(
    'appends permission-mode-derived overrides for $permissionMode',
    async ({ permissionMode, expectedArgs }) => {
      const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
      process.env.CODEX_HOME = codexHome;
      const { bin } = await createFakeCodexAcpBinary();
      process.env.HAPPIER_CODEX_ACP_BIN = bin;

      const { resolveCodexAcpSpawn } = await import('./resolveCommand');
      const spawn = resolveCodexAcpSpawn({ permissionMode });
      expect(spawn.command).toBe(bin);
      expect(spawn.args).toEqual(expectedArgs);
    },
  );

  it('prefers the managed codex-acp install when present', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const managedBin = join(dir, 'tools', 'codex-acp', 'current', 'bin', 'codex-acp');
    await mkdir(join(dir, 'tools', 'codex-acp', 'current', 'bin'), { recursive: true });
    await writeFile(managedBin, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(managedBin, 0o755);

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe(managedBin);
    expect(spawn.args).toEqual([]);
  });

  it('ignores a non-executable managed codex-acp binary on Unix', async () => {
    if (process.platform === 'win32') return;

    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    process.env.PATH = '';
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const managedBin = join(dir, 'tools', 'codex-acp', 'current', 'bin', 'codex-acp');
    await mkdir(join(dir, 'tools', 'codex-acp', 'current', 'bin'), { recursive: true });
    await writeFile(managedBin, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(managedBin, 0o644);

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
  });

  it('falls back to the legacy npm-style managed codex-acp install path', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const legacyBin = join(dir, 'tools', 'codex-acp', 'node_modules', '.bin', 'codex-acp');
    await mkdir(join(dir, 'tools', 'codex-acp', 'node_modules', '.bin'), { recursive: true });
    await writeFile(legacyBin, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(legacyBin, 0o755);
    await createFakeManagedJavaScriptRuntime(dir);

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe(legacyBin);
    expect(spawn.args).toEqual([]);
  });

  it('ignores the legacy npm-style managed codex-acp shim when no system node runtime is available', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    process.env.PATH = '';
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const legacyBin = join(dir, 'tools', 'codex-acp', 'node_modules', '.bin', 'codex-acp');
    await mkdir(join(dir, 'tools', 'codex-acp', 'node_modules', '.bin'), { recursive: true });
    await writeFile(legacyBin, '#!/bin/sh\necho ok\n', 'utf8');
    await chmod(legacyBin, 0o755);

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(spawn.args).toEqual([]);
  });

  it('prefers codex-acp on PATH when available', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;

    const { dir: pathDir, bin } = await createFakeCodexAcpBinary();
    // Rename fake to match PATH lookup expectation.
    // (createFakeCodexAcpBinary already creates "codex-acp" in the directory.)
    process.env.PATH = pathDir;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(spawn.args).toEqual([]);
    expect(bin).toContain('codex-acp');
  });

  it('ignores legacy npx mode overrides and keeps resolving codex-acp directly', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    process.env.HAPPIER_CODEX_ACP_NPX_MODE = 'never';

    const pathDir = await createTempDir('happier-codex-acp-path-');
    tempDirs.add(pathDir);
    process.env.PATH = pathDir;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(spawn.args).toEqual([]);
  });
});
