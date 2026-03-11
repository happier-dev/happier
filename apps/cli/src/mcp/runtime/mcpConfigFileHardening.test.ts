import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

import { writeSecureMcpRuntimeConfigFile } from './writeSecureMcpRuntimeConfigFile';

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function resolveRemoteBridgeInvocation(): { command: string; args: string[]; env?: Record<string, string> } {
  const distEntrypoint = join(projectPath(), 'dist', 'mcp', 'bridges', 'remoteMcpStdioBridge.mjs');
  if (existsSync(distEntrypoint)) {
    return {
      command: process.execPath,
      args: [distEntrypoint],
    };
  }

  const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'bridges', 'remoteMcpStdioBridge.ts');
  const tsxHook = resolveTsxImportHookPath();
  if (!tsxHook) {
    throw new Error('Expected tsx import hook to be resolvable when the built remote bridge entrypoint is unavailable');
  }

  return {
    command: process.execPath,
    args: ['--no-warnings', '--no-deprecation', '--import', tsxHook, sourceEntrypoint],
    env: {
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    },
  };
}

describe('MCP runtime config hardening', () => {
  it('writes config files with a UUID name under a 0700 tmp directory', async () => {
    const prefix = `happier-mcp-runtime-config-writer-test-${Date.now()}`;

    const configPath = await writeSecureMcpRuntimeConfigFile({
      prefix,
      tmpDir: null,
      payload: { hello: 'world' },
    });

    const dir = join(tmpdir(), prefix);
    try {
      expect(join(dir, basename(configPath))).toBe(configPath);

      const name = basename(configPath);
      expect(name).toMatch(new RegExp(`^${prefix}\\.[0-9a-fA-F-]{36}\\.json$`));

      const fileMode = (await stat(configPath)).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const dirMode = (await stat(dir)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('unlinks remote bridge config files only when they are tmp + prefixed', async () => {
    const bridgeInvocation = resolveRemoteBridgeInvocation();

    const safeTmp = await mkdtemp(join(tmpdir(), 'happier-mcp-remote-bridge-test-'));
    const safeConfigPath = join(safeTmp, 'happier-mcp-remote-bridge.safe.json');
    await writeFile(safeConfigPath, '{"headers":{"Authorization":"SECRET"}', { mode: 0o600 });

    const safeChild = spawn(bridgeInvocation.command, bridgeInvocation.args, {
      env: {
        ...resolveEnvRecord(),
        ...(bridgeInvocation.env ?? {}),
        HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: safeConfigPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const safeExitCode = await new Promise<number>((resolve, reject) => {
      safeChild.once('error', reject);
      safeChild.once('exit', (code) => resolve(code ?? -1));
    });

    expect(safeExitCode).not.toBe(0);
    expect(existsSync(safeConfigPath)).toBe(false);
    await rm(safeTmp, { recursive: true, force: true });

    const outsideRoot = join(projectPath(), '.project', 'tmp', 'mcp-remote-bridge-tests');
    await mkdir(outsideRoot, { recursive: true });
    const outsideTmp = await mkdtemp(join(outsideRoot, 'case-'));
    try {
      const outsideConfigPath = join(outsideTmp, 'happier-mcp-remote-bridge.outside-tmp.json');
      await writeFile(outsideConfigPath, '{"headers":{"Authorization":"SECRET"}', { mode: 0o600 });

      const outsideChild = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: outsideConfigPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const outsideExitCode = await new Promise<number>((resolve, reject) => {
        outsideChild.once('error', reject);
        outsideChild.once('exit', (code) => resolve(code ?? -1));
      });

      expect(outsideExitCode).not.toBe(0);
      expect(existsSync(outsideConfigPath)).toBe(true);
    } finally {
      await rm(outsideTmp, { recursive: true, force: true });
    }
  });
});
