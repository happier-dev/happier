import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { resolveProviderCliManagedCommandPath } from '@/runtime/managedTools/providerCliResolution';

const ORIGINAL_ENV = {
  HAPPIER_CODEX_PATH: process.env.HAPPIER_CODEX_PATH,
  HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
  PATH: process.env.PATH,
};

const TEMP_DIRS = new Set<string>();

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
  TEMP_DIRS.clear();
});

describe('resolveCodexMcpServerSpawn', () => {
  it('fails closed when no Codex CLI source is available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-default-'));
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).rejects.toThrow(/system install/i);
  });

  it('respects HAPPIER_CODEX_PATH override', async () => {
    const prev = process.env.HAPPIER_CODEX_PATH;
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-override-'));
    TEMP_DIRS.add(root);
    const overridePath = join(root, process.platform === 'win32' ? 'custom-codex.cmd' : 'custom-codex');
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);
    process.env.HAPPIER_CODEX_PATH = overridePath;
    try {
      vi.resetModules();
      const mod = await import('./resolveCodexMcpServerSpawn');
      await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: overridePath });
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_CODEX_PATH;
      else process.env.HAPPIER_CODEX_PATH = prev;
    }
  });

  it('falls back to the managed Codex CLI when PATH is missing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-managed-'));
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(join(managedPath, '..'), { recursive: true });
    writeFileSync(managedPath, process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(managedPath, 0o755);

    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: managedPath });
  });
});
