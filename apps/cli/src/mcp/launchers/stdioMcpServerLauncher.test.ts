import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function resolveLauncherInvocation(): { command: string; args: string[]; env?: Record<string, string> } {
  const distEntrypoint = join(projectPath(), 'dist', 'mcp', 'launchers', 'stdioMcpServerLauncher.mjs');
  if (existsSync(distEntrypoint)) {
    return {
      command: process.execPath,
      args: [distEntrypoint],
    };
  }

  const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'launchers', 'stdioMcpServerLauncher.ts');
  const tsxHook = resolveTsxImportHookPath();
  if (!tsxHook) {
    throw new Error('Expected tsx import hook to be resolvable when the built launcher entrypoint is unavailable');
  }

  return {
    command: process.execPath,
    args: ['--no-warnings', '--no-deprecation', '--import', tsxHook, sourceEntrypoint],
    env: {
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    },
  };
}

describe('stdioMcpServerLauncher', () => {
  it('removes the config file when startup fails before config parsing succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const configPath = join(tmp, 'happier-mcp-stdio-launcher.test.json');
      await writeFile(configPath, '{"env":{"API_KEY":"SHOULD_NOT_PERSIST"}', { mode: 0o600 });

      const launcherInvocation = resolveLauncherInvocation();
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not remove non-tmp config files even when startup fails', async () => {
    const outsideRoot = join(projectPath(), '.project', 'tmp', 'mcp-stdio-launcher-tests');
    await mkdir(outsideRoot, { recursive: true });

    const tmp = await mkdtemp(join(outsideRoot, 'case-'));
    try {
      const configPath = join(tmp, 'happier-mcp-stdio-launcher.outside-tmp.json');
      await writeFile(configPath, '{"env":{"API_KEY":"SHOULD_NOT_PERSIST"}', { mode: 0o600 });

      const launcherInvocation = resolveLauncherInvocation();
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(existsSync(configPath)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
