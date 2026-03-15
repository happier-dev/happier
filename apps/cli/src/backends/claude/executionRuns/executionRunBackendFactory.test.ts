import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { reloadConfiguration, configuration } from '@/configuration';
import { resolveIsolation } from './executionRunBackendFactory';

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

  it('adds isolated XDG dirs for Claude Code to avoid shared version locks', () => {
    const bundle = resolveIsolation(
      {
        backendId: 'claude',
        isolationId: 'run_1',
        scope: 'execution_run',
        cwd: '/tmp',
      },
      { env: {} },
    );

    expect(typeof bundle.env.XDG_DATA_HOME).toBe('string');
    expect(typeof bundle.env.XDG_STATE_HOME).toBe('string');
    expect(typeof bundle.env.XDG_CACHE_HOME).toBe('string');
    expect(bundle.env.XDG_DATA_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
    expect(bundle.env.XDG_STATE_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
    expect(bundle.env.XDG_CACHE_HOME).toContain(join(configuration.activeServerDir, 'isolation'));
  });
});
