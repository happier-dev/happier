import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { executePluginDevLoopAction } from './actions';

async function materializeDevPlugin(rootDir: string, pluginId = 'acme.dev-loop'): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(join(rootDir, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: pluginId,
      displayName: 'Acme Dev Loop',
      description: 'Dev-loop action fixture',
      entrypoints: {
        main: './daemon.mjs',
        dev: './src/daemon.ts',
      },
    }), null, 2),
    'utf8',
  );
}

describe('executePluginDevLoopAction', () => {
  it('rejects remote archive locators before the installer can fetch network content', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('remote fetch should not be reached');
    });

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: {
          path: 'https://example.test/plugins/acme.dev-loop.tgz',
          dev: true,
        },
        happyHomeDir: home,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(install).toMatchObject({
        ok: false,
        kind: 'plugins_install',
        diagnostics: [
          {
            code: 'plugin_source_missing',
            message: expect.stringMatching(/local plugin path/i),
          },
        ],
      });
    } finally {
      fetchSpy.mockRestore();
      await removeTempDir(home);
    }
  });

  it('installs a local dev plugin and lists structured diagnostics', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    await materializeDevPlugin(pluginRoot);

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: {
          path: pluginRoot,
          dev: true,
        },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(install).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        plugin: {
          pluginId: 'acme.dev-loop',
          source: {
            kind: 'path',
            devWatch: true,
          },
        },
      });

      const list = await executePluginDevLoopAction({
        actionId: 'plugins.list',
        input: {},
        happyHomeDir: home,
      });

      expect(list).toMatchObject({
        ok: true,
        kind: 'plugins_list',
        plugins: [
          {
            id: 'acme.dev-loop',
            version: '1.0.0',
            state: 'enabled',
            sourceKind: 'path',
            diagnostics: [],
          },
        ],
      });

      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins['acme.dev-loop']?.source.devWatch).toBe(true);
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('does not silently trust arbitrary local dev installs outside the workspace', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-loop-outside-workspace-'));
    await materializeDevPlugin(pluginRoot, 'acme.dev-loop-outside');

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: {
          path: pluginRoot,
          dev: true,
        },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(install).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        plugin: {
          pluginId: 'acme.dev-loop-outside',
          source: {
            kind: 'path',
            trustPolicy: 'prompt',
          },
        },
      });

      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins['acme.dev-loop-outside']?.source.trustPolicy).toBe('prompt');
      expect(state.plugins['acme.dev-loop-outside']?.source).not.toHaveProperty('devWatch');
    } finally {
      await removeTempDir(pluginRoot);
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('rejects scaffold targets outside the current workspace root', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-loop-scaffold-outside-'));
    const targetDir = join(outsideRoot, 'generated-plugin');

    try {
      const result = await executePluginDevLoopAction({
        actionId: 'plugins.scaffold',
        input: {
          targetDir,
          id: 'acme.generated',
          name: 'Acme Generated',
        },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(result).toMatchObject({
        ok: false,
        kind: 'plugins_scaffold',
        diagnostics: [
          {
            code: 'plugin_scaffold_invalid_input',
            message: expect.stringMatching(/inside the workspace/i),
          },
        ],
      });
      await expect(readFile(join(targetDir, 'package.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await removeTempDir(outsideRoot);
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('uninstalls an installed plugin through the catalog owner and returns reload diagnostics', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-loop-source-'));
    await materializeDevPlugin(pluginRoot);
    const reloadCalls: Array<Parameters<PluginReloadController['reload']>[0]> = [];
    const reload: PluginReloadController['reload'] = async (params) => {
      reloadCalls.push(params);
      return {
        ok: true as const,
        generation: 2,
        attemptedGeneration: 2,
        requestedPluginIds: ['acme.dev-loop'],
        changedPluginIds: ['acme.dev-loop'],
        affectedPluginIds: ['acme.dev-loop'],
        activeGenerationId: 'reload:2',
        registryStatus: 'active' as const,
        diagnostics: [],
        diagnosticsByPluginId: {},
        registry: {} as never,
      };
    };

    try {
      await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: {
          path: pluginRoot,
          dev: true,
        },
        happyHomeDir: home,
        workspaceRoot: pluginRoot,
      });

      const result = await executePluginDevLoopAction({
        actionId: 'plugins.uninstall' as any,
        input: {
          pluginId: 'acme.dev-loop',
        },
        happyHomeDir: home,
        reload,
      });

      expect(result).toMatchObject({
        ok: true,
        kind: 'plugins_uninstall',
        plugin: {
          pluginId: 'acme.dev-loop',
          source: {
            kind: 'path',
            devWatch: true,
          },
        },
        reload: {
          registryStatus: 'active',
          affectedPluginIds: ['acme.dev-loop'],
          diagnostics: [],
        },
      });
      expect(reloadCalls).toEqual([{ pluginId: 'acme.dev-loop' }]);
      const state = await createPluginStateStore({ happyHomeDir: home }).read();
      expect(state.plugins['acme.dev-loop']).toBeUndefined();
    } finally {
      await removeTempDir(home);
    }
  });

  it('returns structured diagnostics when uninstall is missing a plugin id or target', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const reload = vi.fn<PluginReloadController['reload']>();

    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.uninstall' as any,
        input: {},
        happyHomeDir: home,
        reload,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_uninstall',
        diagnostics: [
          {
            code: 'plugin_manifest_semantic_invalid',
            message: expect.stringMatching(/pluginId/i),
          },
        ],
      });

      await expect(executePluginDevLoopAction({
        actionId: 'plugins.uninstall' as any,
        input: {
          pluginId: 'acme.missing',
        },
        happyHomeDir: home,
        reload,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_uninstall',
        diagnostics: [
          {
            code: 'plugin_source_missing',
            message: expect.stringMatching(/acme\.missing/),
          },
        ],
      });
      expect(reload).not.toHaveBeenCalled();
    } finally {
      await removeTempDir(home);
    }
  });

  it('returns structured reload diagnostics from the reload controller', async () => {
    const reloadCalls: Array<Parameters<PluginReloadController['reload']>[0]> = [];
    const reload: PluginReloadController['reload'] = async (params) => {
      reloadCalls.push(params);
      return {
      ok: false as const,
      generation: 2,
      attemptedGeneration: 3,
      requestedPluginIds: ['acme.broken'],
      changedPluginIds: [],
      affectedPluginIds: ['acme.broken'],
      activeGenerationId: 'reload:2',
      registryStatus: 'unavailable' as const,
      diagnostics: [{ code: 'plugin_reload_failed' as const, message: 'syntax error at line 2' }],
      diagnosticsByPluginId: {
        'acme.broken': [
          {
            code: 'plugin_activation_failed',
            message: 'syntax error at line 2',
          },
        ],
      },
      registry: null,
      };
    };

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.reload',
      input: { pluginId: 'acme.broken' },
      happyHomeDir: '/tmp/happier-home',
      reload,
    })).resolves.toMatchObject({
      ok: false,
      kind: 'plugins_reload',
      diagnostics: [{ code: 'plugin_reload_failed', message: 'syntax error at line 2' }],
      diagnosticsByPluginId: {
        'acme.broken': [
          {
            code: 'plugin_activation_failed',
            message: 'syntax error at line 2',
          },
        ],
      },
    });
    expect(reloadCalls).toEqual([{ pluginId: 'acme.broken' }]);
  });
});
