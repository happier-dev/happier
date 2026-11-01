import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { reloadConfiguration, configuration } from '@/configuration';
import { executionRunBackendFactory, resolveIsolation } from './executionRunBackendFactory';

describe('claude execution run isolation', () => {
  let prevHomeDir: string | undefined;
  let homeDir: string | null = null;

  beforeEach(async () => {
    prevHomeDir = process.env.HAPPIER_HOME_DIR;
    homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    reloadConfiguration();
  });

  afterEach(async () => {
    if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHomeDir;
    reloadConfiguration();
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
    }
    homeDir = null;
  });

  it('isolates only Claude settings and preserves inherited user cache directories', async () => {
    const env = {
      HOME: '/user/home',
      XDG_CONFIG_HOME: '/user/config',
      XDG_DATA_HOME: '/user/data',
      XDG_STATE_HOME: '/user/state',
      XDG_CACHE_HOME: '/user/cache',
    };
    const bundle = resolveIsolation(
      {
        backendId: 'claude',
        isolationId: 'run_1',
        scope: 'execution_run',
        cwd: '/tmp',
      },
      { env },
    );

    expect(bundle.env).toEqual(env);
    expect(bundle.settingsPath).toBe(join(configuration.activeServerDir, 'isolation', 'claude', 'execution_run', 'run_1', 'claude', 'settings.json'));
    expect(JSON.parse(await readFile(bundle.settingsPath!, 'utf8'))).toEqual({});
    await bundle.cleanup?.();
    await expect(access(join(configuration.activeServerDir, 'isolation', 'claude', 'execution_run', 'run_1'))).rejects.toThrow();
  });

  it('uses the canonical execution-run permission handler', () => {
    const permissionHandler = {
      handleToolCall: async () => ({ decision: 'denied' as const }),
    };
    const backend = executionRunBackendFactory({
      cwd: '/tmp',
      backendId: 'claude',
      permissionMode: 'read_only',
      permissionHandler,
    });

    expect((backend as any).opts.permissionHandler).toBe(permissionHandler);
  });
});
