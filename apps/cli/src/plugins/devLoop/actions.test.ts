import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { executePluginDevLoopAction } from './actions';

const daemonControl = vi.hoisted(() => ({
  request: vi.fn(),
  decide: vi.fn(),
  ensure: vi.fn(async () => {}),
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonPluginChange: daemonControl.request,
  decideDaemonPluginChange: daemonControl.decide,
}));

vi.mock('@/daemon/ensureDaemon', () => ({
  ensureDaemonRunningForSessionCommand: daemonControl.ensure,
}));

async function materializeDevPlugin(rootDir: string, pluginId = 'acme.dev-loop'): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(join(rootDir, 'src', 'daemon.ts'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: pluginId,
      version: '1.0.0',
      displayName: 'Acme Dev Loop',
      description: 'Dev-loop action fixture',
      engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: {
        daemon: './daemon.mjs',
        development: './src/daemon.ts',
      },
      contributes: {},
    }, null, 2),
    'utf8',
  );
}

describe('executePluginDevLoopAction', () => {
  beforeEach(() => {
    daemonControl.request.mockReset();
    daemonControl.decide.mockReset();
    daemonControl.ensure.mockClear();
  });

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

  it('previews a local development plugin without executing or trusting it', async () => {
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
          dryRun: true,
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

      expect(daemonControl.request).not.toHaveBeenCalled();
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('does not start an opaque Install and trust review the ActionSpec consumer cannot decide', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    await materializeDevPlugin(pluginRoot);

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: { path: pluginRoot, dev: true },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(install).toMatchObject({
        ok: false,
        kind: 'plugins_install',
        diagnostics: [{
          code: 'plugin_install_review_unavailable',
          message: expect.stringMatching(/CLI.*Install.*Trust/i),
        }],
      });
      expect(daemonControl.request).not.toHaveBeenCalled();
      expect(daemonControl.decide).not.toHaveBeenCalled();
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
          dryRun: true,
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

      expect(daemonControl.request).not.toHaveBeenCalled();
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
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

  it('uninstalls through the canonical daemon change without a second reload', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-dev-loop-source-'));
    await materializeDevPlugin(pluginRoot);
    try {
      await createPluginStateStore({ happyHomeDir: home }).write({
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          'acme.dev-loop': {
            source: {
              kind: 'path',
              locator: pluginRoot,
              resolvedPath: pluginRoot,
              manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
              trustPolicy: 'prompt',
              installPolicy: 'link',
              devWatch: true,
            },
            compatibility: { status: 'compatible', diagnostics: [] },
            install: { mode: 'link', manifestVersion: '1.0.0' },
            state: { enabled: true },
          },
        },
      });
      daemonControl.request.mockResolvedValue({
        kind: 'committed',
        pluginId: 'acme.dev-loop',
        desiredGeneration: null,
        appliedGeneration: null,
        pendingSurfaces: [],
      });

      const result = await executePluginDevLoopAction({
        actionId: 'plugins.uninstall' as any,
        input: {
          pluginId: 'acme.dev-loop',
        },
        happyHomeDir: home,
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
      });
      expect(result).not.toHaveProperty('reload');
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'uninstall',
        pluginId: 'acme.dev-loop',
      });
    } finally {
      await removeTempDir(home);
    }
  });

  it('returns structured diagnostics when uninstall is missing a plugin id or target', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.uninstall' as any,
        input: {},
        happyHomeDir: home,
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
      expect(daemonControl.request).not.toHaveBeenCalled();
    } finally {
      await removeTempDir(home);
    }
  });

  it('routes development reload through the daemon change owner without self-approval', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const sourceRoot = '/plugins/acme.broken';
    await createPluginStateStore({ happyHomeDir: home }).write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.broken': {
          source: {
            kind: 'path',
            locator: sourceRoot,
            resolvedPath: '/plugins/generations/acme-broken-1',
            manifestPath: '/plugins/generations/acme-broken-1/.happier-plugin/plugin.json',
            trustPolicy: 'prompt',
            installPolicy: 'link',
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: '1.0.0' },
          state: { enabled: true },
        },
      },
    });
    daemonControl.request.mockResolvedValue({
      kind: 'failed' as const,
      code: 'plugin_change_failed',
    });

    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.reload',
        input: { pluginId: 'acme.broken' },
        happyHomeDir: home,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{ code: 'plugin_change_failed' }],
      });
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'development',
        pluginId: 'acme.broken',
        sourceRootPath: sourceRoot,
      });
    } finally {
      await removeTempDir(home);
    }
  });
});
