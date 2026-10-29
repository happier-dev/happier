import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnBoundary, spawnStopped } = vi.hoisted(() => {
  const spawnStopped = new Error('process boundary reached');
  return { spawnStopped, spawnBoundary: vi.fn((_command: string, _args: string[], _options: SpawnOptions) => { throw spawnStopped; }) };
});

// Stop at the OS process boundary while exercising real configuration and invocation resolution.
vi.mock('node:child_process', () => ({ spawn: spawnBoundary }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('stdioMcpServerLauncher Windows commands', () => {
  it('launches a configured cmd wrapper through the canonical Windows invocation owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-windows-launch-'));
    try {
      const command = join(root, 'npx.cmd');
      await writeFile(command, '@echo off\r\n');
      const configPath = join(root, 'config.json');
      const comspec = join(root, 'cmd.exe');
      const args = ['--package', '@scope/server', '--', '--yes', 'value with spaces & symbols'];
      await writeFile(configPath, JSON.stringify({ command, args, env: { COMSPEC: comspec, PATH: root }, cwd: root }));
      vi.stubEnv('Path', join(root, 'inherited-path'));
      vi.stubEnv('HAPPIER_CLI_DIST_INTEGRITY_PROBE', '1');
      vi.stubEnv('HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE', configPath);
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      const { runStdioMcpServerLauncher } = await import('./stdioMcpServerLauncher');
      await expect(runStdioMcpServerLauncher()).rejects.toBe(spawnStopped);
      const [spawnCommand, invocationArgs, options] = spawnBoundary.mock.calls[0]!;
      expect(spawnCommand).toBe(comspec);
      expect(invocationArgs.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(options.cwd).toBe(root);
      expect(options.windowsVerbatimArguments).toBe(true);
      expect(options.env?.COMSPEC).toBe(comspec);
      expect(options.env?.PATH).toBe(root);
      expect(options.shell).toBe(false);
      expect(invocationArgs[3]).toContain('--yes');
      expect(invocationArgs[3]).toContain('--package');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
