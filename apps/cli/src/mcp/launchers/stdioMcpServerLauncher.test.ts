import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';
import { writeSecureMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';
import { removeWrittenMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function resolveLauncherInvocation(options: Readonly<{ forceSource?: boolean }> = {}): { command: string; args: string[]; env?: Record<string, string> } {
  const distEntrypoint = join(projectPath(), 'dist', 'mcp', 'launchers', 'stdioMcpServerLauncher.mjs');
  if (!options.forceSource && existsSync(distEntrypoint)) {
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
    args: ['--no-warnings', '--no-deprecation', '--import', pathToFileURL(tsxHook).href, sourceEntrypoint],
    env: {
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    },
  };
}

describe('stdioMcpServerLauncher', () => {
  it('cleans up an owned config directory when its writer exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-writer-exit-test-'));
    try {
      const invocation = resolveLauncherInvocation({ forceSource: true });
      const writer = pathToFileURL(join(projectPath(), 'src', 'mcp', 'runtime', 'writeSecureMcpRuntimeConfigFile.ts'));
      const { stdout } = await promisify(execFile)(invocation.command, [
        ...invocation.args.slice(0, -1), '--input-type=module', '--eval',
        `const writer = await import(${JSON.stringify(writer.href)});
         const writeConfig = writer.writeSecureMcpRuntimeConfigFile ?? writer.default.writeSecureMcpRuntimeConfigFile;
         process.stdout.write(await writeConfig({ prefix: 'happier-mcp-stdio-launcher', tmpDir: null, payload: {} }));`,
      ], { env: { ...process.env, ...invocation.env, TMPDIR: root, TMP: root, TEMP: root } });
      const configPath = stdout.trim();
      expect(configPath).toContain('happier-mcp-stdio-launcher');
      expect(existsSync(dirname(configPath))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the writer-owned config for relaunch until its owner cleans up', async () => {
    const prefix = 'happier-mcp-stdio-launcher';
    const configPath = await writeSecureMcpRuntimeConfigFile({
      prefix,
      tmpDir: null,
      payload: { env: { API_KEY: 'SHOULD_NOT_PERSIST' } },
    });
    const ownedDirectory = dirname(configPath);

    try {
      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).not.toContain('ENOENT');
      expect(existsSync(configPath)).toBe(true);
      removeWrittenMcpRuntimeConfigFile(configPath, true);
      expect(existsSync(ownedDirectory)).toBe(false);
    } finally {
      await rm(ownedDirectory, { recursive: true, force: true });
    }
  });

  it('preserves the config file when startup fails before config parsing succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const configPath = join(tmp, 'happier-mcp-stdio-launcher.test.json');
      await writeFile(configPath, '{"env":{"API_KEY":"SHOULD_NOT_PERSIST"}', { mode: 0o600 });

      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
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
      expect(existsSync(tmp)).toBe(true);
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

      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
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
