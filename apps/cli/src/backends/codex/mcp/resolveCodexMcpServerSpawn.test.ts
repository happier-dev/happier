import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { resolveProviderCliManagedCommandPath } from '@/runtime/managedTools/providerCliResolution';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const envKeys = ['HAPPIER_CODEX_PATH', 'HAPPIER_HOME_DIR', 'PATH'] as const;
const TEMP_DIRS = new Set<string>();
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const dir of TEMP_DIRS) {
    removeTempDirSync(dir);
  }
  TEMP_DIRS.clear();
});

describe('resolveCodexMcpServerSpawn', () => {
  it('fails closed when no Codex CLI source is available', async () => {
    const root = createTempDirSync('happier-codex-mcp-default-');
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).rejects.toThrow(/system install/i);
  });

  it('respects HAPPIER_CODEX_PATH override', async () => {
    const root = createTempDirSync('happier-codex-mcp-override-');
    TEMP_DIRS.add(root);
    const overridePath = join(root, process.platform === 'win32' ? 'custom-codex.cmd' : 'custom-codex');
    writeExecutableShimSync({
      dir: root,
      fileName: basename(overridePath),
      contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
    });
    process.env.HAPPIER_CODEX_PATH = overridePath;
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: overridePath });
  });

  it('falls back to the managed Codex CLI when PATH is missing it', async () => {
    const root = createTempDirSync('happier-codex-mcp-managed-');
    TEMP_DIRS.add(root);
    process.env.HAPPIER_HOME_DIR = join(root, 'home');
    process.env.PATH = join(root, 'empty-path');
    mkdirSync(process.env.PATH, { recursive: true });
    mkdirSync(process.env.HAPPIER_HOME_DIR, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: process.env.HAPPIER_HOME_DIR });
    mkdirSync(dirname(managedPath), { recursive: true });
    writeExecutableShimSync({
      dir: dirname(managedPath),
      fileName: basename(managedPath),
      contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
    });

    vi.resetModules();
    const mod = await import('./resolveCodexMcpServerSpawn');
    await expect(mod.resolveCodexMcpServerSpawn()).resolves.toEqual({ mode: 'codex-cli', command: managedPath });
  });
});
