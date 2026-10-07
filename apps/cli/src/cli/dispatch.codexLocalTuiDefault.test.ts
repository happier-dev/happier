import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';

// Vendor process execution is external; registry, command policy, argument
// admission and executable resolution stay real.
const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync,
}));

import { dispatchCli } from './dispatch';

describe('dispatchCli (codex local TUI default)', () => {
  let prevEnv: string | undefined;
  let prevInTty: boolean | undefined;
  let prevOutTty: boolean | undefined;
  let directory: string;
  let executable: string;
  let envScope: ReturnType<typeof createEnvKeyScope>;
  const processExit = new Error('fixture-process-exit');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-dispatch-codex-'));
    executable = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(executable, 0o755);
    envScope = createEnvKeyScope(['HAPPIER_CODEX_PATH']);
    envScope.patch({ HAPPIER_CODEX_PATH: executable });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw processExit; });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    prevEnv = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    prevInTty = process.stdin.isTTY;
    prevOutTty = process.stdout.isTTY;
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    spawnSync.mockClear();
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = prevEnv;
    Object.defineProperty(process.stdin, 'isTTY', { value: prevInTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: prevOutTty, configurable: true });
    envScope.restore();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('does not force daemon autostart for `happier codex` in a TTY when unset', async () => {
    await expect(dispatchCli({
      args: ['codex', '--help'],
      rawArgv: ['happier', 'codex', '--help'],
      terminalRuntime: null,
    })).rejects.toBe(processExit);

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
    expect(spawnSync).toHaveBeenCalledWith(executable, ['--help'], expect.any(Object));
  });

  it('does not disable daemon autostart when `--started-by=daemon` is used', async () => {
    await expect(dispatchCli({
      args: ['codex', '--started-by=daemon', '--help'],
      rawArgv: ['happier', 'codex', '--started-by=daemon', '--help'],
      terminalRuntime: null,
    })).rejects.toBe(processExit);

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).not.toBe('0');
    expect(spawnSync).toHaveBeenCalled();
  });

  it('does not disable daemon autostart when `--started-by` is malformed', async () => {
    await expect(dispatchCli({
      args: ['codex', '--started-by', '--help'],
      rawArgv: ['happier', 'codex', '--started-by', '--help'],
      terminalRuntime: null,
    })).rejects.toBe(processExit);

    expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).not.toBe('0');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('projects daemon-spawned explicit environment values and unsets into command scope', async () => {
    const keys = [
      'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'UNMARKED_AMBIENT_VALUE',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    process.env.ANTHROPIC_BASE_URL = 'https://provider.example.test/anthropic';
    process.env.ANTHROPIC_API_KEY = 'provider-api-key';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.UNMARKED_AMBIENT_VALUE = 'must-not-be-scoped';

    try {
      const scopedEnvironment = resolveExplicitSpawnScopedEnvironmentFromProcessEnv(process.env);
      expect(scopedEnvironment).toEqual({
          env: {
            ANTHROPIC_BASE_URL: 'https://provider.example.test/anthropic',
            ANTHROPIC_API_KEY: 'provider-api-key',
          },
          unsetEnvKeys: ['ANTHROPIC_AUTH_TOKEN'],
      });
      expect(scopedEnvironment?.env).not.toHaveProperty('UNMARKED_AMBIENT_VALUE');
      expect(scopedEnvironment?.env).not.toHaveProperty(
        'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
