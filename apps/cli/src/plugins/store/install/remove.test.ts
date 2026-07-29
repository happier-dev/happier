import { describe, expect, it, vi } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createPluginStateStore, PluginStateFileV1Schema } from '@/plugins/store/state.testkit';
import type { UserPluginChangeResult } from '@/plugins/daemon/changeClient';

import { removeInstalledPlugin } from './remove';

const changeClient = vi.hoisted(() => ({
  requestUserPluginChange: vi.fn(async (): Promise<UserPluginChangeResult> => ({
    kind: 'unavailable',
    code: 'unexpected_test_call',
  })),
}));

vi.mock('@/plugins/daemon/changeClient', () => changeClient);

describe('removeInstalledPlugin', () => {
  it('routes uninstall through the daemon without deleting registry state locally', async () => {
    const happyHomeDir = await createTempDir('happier-plugin-remove-');
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
          install: { mode: 'link', manifestVersion: '1.0.0', installedPath: happyHomeDir },
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
      await expect(removeInstalledPlugin({ happyHomeDir, pluginId: 'acme.example' }))
        .resolves.toMatchObject({ ok: true, pluginId: 'acme.example' });

      expect(changeClient.requestUserPluginChange).toHaveBeenCalledWith({
        request: { kind: 'uninstall', pluginId: 'acme.example' },
        approval: 'none',
      });
      expect((await store.read()).plugins['acme.example']).toBeDefined();
    } finally {
      await removeTempDir(happyHomeDir);
    }
  });
});
