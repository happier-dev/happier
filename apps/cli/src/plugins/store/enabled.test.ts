import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginStateStore, PluginStateFileV1Schema } from '@/plugins/store/state.testkit';
import type { UserPluginChangeResult } from '@/plugins/daemon/changeClient';

import { setInstalledPluginEnabled } from './enabled';

const changeClient = vi.hoisted(() => ({
  requestUserPluginChange: vi.fn(async (): Promise<UserPluginChangeResult> => ({
    kind: 'unavailable',
    code: 'unexpected_test_call',
  })),
}));

vi.mock('@/plugins/daemon/changeClient', () => changeClient);

describe('setInstalledPluginEnabled', () => {
  it('routes a state change through the daemon without writing the registry locally', async () => {
    const happyHomeDir = await createTempDir('happier-plugin-enabled-');
    const store = createPluginStateStore({ happyHomeDir });
    await store.write(PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.example': {
          source: {
            kind: 'path',
            locator: happyHomeDir,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: happyHomeDir,
            manifestPath: `${happyHomeDir}/.happier-plugin/plugin.json`,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0' },
          state: { enabled: true },
        },
      },
    }));
    changeClient.requestUserPluginChange.mockResolvedValueOnce({
      kind: 'committed' as const,
      pluginId: 'acme.example',
      desiredGeneration: null,
      appliedGeneration: null,
      pendingSurfaces: [],
    });

    try {
      await expect(setInstalledPluginEnabled({
        happyHomeDir,
        pluginId: 'acme.example',
        enabled: false,
      })).resolves.toMatchObject({ ok: true, changed: true });

      expect(changeClient.requestUserPluginChange).toHaveBeenCalledWith({
        request: { kind: 'disable', pluginId: 'acme.example' },
        approval: 'none',
      });
      expect((await store.read()).plugins['acme.example']?.state.enabled).toBe(true);
    } finally {
      await removeTempDir(happyHomeDir);
    }
  });
});
