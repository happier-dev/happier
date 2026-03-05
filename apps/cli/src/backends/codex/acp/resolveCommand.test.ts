import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@/api/types';

const ENV_KEYS = [
  'CODEX_HOME',
  'HAPPIER_CODEX_ACP_BIN',
  'HAPPIER_CODEX_ACP_CONFIG_OVERRIDES',
  'HAPPIER_HOME_DIR',
  'HAPPIER_CODEX_ACP_NPX_MODE',
  'PATH',
] as const;

const ORIGINAL_ENV: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  CODEX_HOME: process.env.CODEX_HOME,
  HAPPIER_CODEX_ACP_BIN: process.env.HAPPIER_CODEX_ACP_BIN,
  HAPPIER_CODEX_ACP_CONFIG_OVERRIDES: process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  HAPPIER_CODEX_ACP_NPX_MODE: process.env.HAPPIER_CODEX_ACP_NPX_MODE,
  PATH: process.env.PATH,
};

const tempDirs = new Set<string>();

async function createFakeCodexAcpBinary(): Promise<{ dir: string; bin: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-'));
  tempDirs.add(dir);
  const bin = join(dir, 'codex-acp');
  await writeFile(bin, '#!/bin/sh\necho ok\n', 'utf8');
  await chmod(bin, 0o755);
  return { dir, bin };
}

async function createFakeCodexHome(mcpServers: string[]): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-codex-home-'));
  tempDirs.add(dir);
  const configPath = join(dir, 'config.toml');
  const configBody = mcpServers.map((name) => `[mcp_servers.${name}]\ncommand = \"echo\"\nargs = []\n`).join('\n');
  await writeFile(configPath, configBody, 'utf8');
  return { dir };
}

function restoreTrackedEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(async () => {
  restoreTrackedEnv();
  vi.resetModules();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe.sequential('resolveCodexAcpSpawn', () => {
  it('disables Codex MCP servers by default for codex-acp spawns (Happier-managed)', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { bin } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_CODEX_ACP_BIN = bin;
    delete process.env.HAPPIER_CODEX_ACP_CONFIG_OVERRIDES;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
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
    expect(spawn.args).toEqual([
      '-c',
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.playwright.enabled=false',
      '-c',
      'mcp_servers.sequential-thinking.enabled=false',
      '-c',
      'approval_policy="on-request"',
    ]);
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

  const permissionModeCases: Array<{ permissionMode: PermissionMode; expectedArgs: string[] }> = [
    {
      permissionMode: 'safe-yolo',
      expectedArgs: [
        '-c',
        'mcp_servers.context7.enabled=false',
        '-c',
        'mcp_servers.playwright.enabled=false',
        '-c',
        'mcp_servers.sequential-thinking.enabled=false',
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
        'mcp_servers.context7.enabled=false',
        '-c',
        'mcp_servers.playwright.enabled=false',
        '-c',
        'mcp_servers.sequential-thinking.enabled=false',
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
        'mcp_servers.context7.enabled=false',
        '-c',
        'mcp_servers.playwright.enabled=false',
        '-c',
        'mcp_servers.sequential-thinking.enabled=false',
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
        'mcp_servers.context7.enabled=false',
        '-c',
        'mcp_servers.playwright.enabled=false',
        '-c',
        'mcp_servers.sequential-thinking.enabled=false',
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
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.playwright.enabled=false',
      '-c',
      'mcp_servers.sequential-thinking.enabled=false',
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

  it('uses npx fallback by default when codex-acp is not installed', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;

    const pathDir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-path-'));
    tempDirs.add(pathDir);
    process.env.PATH = pathDir;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('npx');
    expect(spawn.args.slice(0, 3)).toEqual(['--prefer-offline', '-y', '@zed-industries/codex-acp']);
  });

  it('prefers codex-acp on PATH when available (npx mode auto)', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    process.env.HAPPIER_CODEX_ACP_NPX_MODE = 'auto';

    const { dir: pathDir, bin } = await createFakeCodexAcpBinary();
    // Rename fake to match PATH lookup expectation.
    // (createFakeCodexAcpBinary already creates "codex-acp" in the directory.)
    process.env.PATH = pathDir;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(spawn.args).toEqual([
      '-c',
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.playwright.enabled=false',
      '-c',
      'mcp_servers.sequential-thinking.enabled=false',
    ]);
    expect(bin).toContain('codex-acp');
  });

  it('disables npx fallback when npx mode is never', async () => {
    const { dir: codexHome } = await createFakeCodexHome(['context7', 'sequential-thinking', 'playwright']);
    process.env.CODEX_HOME = codexHome;
    const { dir } = await createFakeCodexAcpBinary();
    process.env.HAPPIER_HOME_DIR = dir;
    delete process.env.HAPPIER_CODEX_ACP_BIN;
    process.env.HAPPIER_CODEX_ACP_NPX_MODE = 'never';

    const pathDir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-path-'));
    tempDirs.add(pathDir);
    process.env.PATH = pathDir;

    const { resolveCodexAcpSpawn } = await import('./resolveCommand');
    const spawn = resolveCodexAcpSpawn();
    expect(spawn.command).toBe('codex-acp');
    expect(spawn.args).toEqual([
      '-c',
      'mcp_servers.context7.enabled=false',
      '-c',
      'mcp_servers.playwright.enabled=false',
      '-c',
      'mcp_servers.sequential-thinking.enabled=false',
    ]);
  });
});
