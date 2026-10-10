import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('resolveBackendIsolationBundle', () => {
  it('creates an isolation root under the active server dir and overlays XDG state/cache/data', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-isolation-home-'));
    const envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS',
      'XDG_CONFIG_HOME',
      'OPENAI_API_KEY',
      'CODEX_HOME',
      'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
      'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON',
      'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT',
    ]);
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'https://api.example.test',
        HAPPIER_WEBAPP_URL: 'https://app.example.test',
        HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '250',
        XDG_CONFIG_HOME: join(homeDir, 'config'),
        OPENAI_API_KEY: 'parent-connected-secret',
        CODEX_HOME: join(homeDir, 'parent-connected-codex-home'),
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
          { kind: 'profile', serviceId: 'openai-codex', profileId: 'parent' },
        ]),
        HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify([
          'OPENAI_API_KEY',
          'CODEX_HOME',
        ]),
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: join(
          homeDir,
          'parent-connected-root',
        ),
      });

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
      expect(bundle.env.HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS).toBe('250');
      expect(bundle.env.XDG_CONFIG_HOME).toBe(join(homeDir, 'config'));
      expect(bundle.env.OPENAI_API_KEY).toBeUndefined();
      expect(bundle.env.CODEX_HOME).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT).toBeUndefined();
      await writeFile(join(bundle.env.XDG_STATE_HOME!, 'native.db'), 'resume state');
      await bundle.cleanup?.();
      await expect(stat(root)).resolves.toBeTruthy();
      await rm(join(bundle.env.XDG_STATE_HOME!, 'native.db'));
      await bundle.cleanup?.();
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.resetModules();
      await rm(homeDir, { recursive: true, force: true });
      envScope.restore();
    }
  });
});
