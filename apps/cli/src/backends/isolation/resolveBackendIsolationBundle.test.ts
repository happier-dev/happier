import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

describe('resolveBackendIsolationBundle', () => {
  it('creates an isolation root under the active server dir and overlays XDG state/cache/data', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-isolation-home-'));
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { configuration } = await import('@/configuration');
      const { resolveBackendIsolationBundle } = await import('./resolveBackendIsolationBundle');

      const bundle = resolveBackendIsolationBundle({
        backendId: 'claude',
        isolationId: 'run_1',
        scope: 'execution_run',
        intent: 'memory_hints',
        cwd: process.cwd(),
      });

      const root = join(configuration.activeServerDir, 'isolation', 'claude', 'execution_run', 'run_1');
      expect(bundle.env.XDG_STATE_HOME).toBe(join(root, 'xdg', 'state'));
      expect(bundle.env.XDG_CACHE_HOME).toBe(join(root, 'xdg', 'cache'));
      expect(bundle.env.XDG_DATA_HOME).toBe(join(root, 'xdg', 'data'));
      expect(bundle.env.HOME).toBeUndefined();
      expect(bundle.env.XDG_CONFIG_HOME).toBeUndefined();
    } finally {
      vi.resetModules();
      await rm(homeDir, { recursive: true, force: true });
      delete process.env.HAPPIER_HOME_DIR;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
    }
  });
});

