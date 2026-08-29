import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

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

  it('returns a truthful pending source-root review without deciding it', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    await materializeDevPlugin(pluginRoot);
    daemonControl.request.mockResolvedValue({
      kind: 'sourceRootReviewRequired',
      pendingChangeId: 'pending-source-root-1',
      review: { source: { kind: 'path', locator: pluginRoot } },
    });

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
        outcome: 'reviewRequired',
        pendingReview: {
          kind: 'sourceRootReviewRequired',
          pendingChangeId: 'pending-source-root-1',
          review: { source: { kind: 'path', locator: pluginRoot } },
        },
      });
      expect(install).not.toHaveProperty('pendingChangeId');
      expect(install).not.toHaveProperty('review');
      expect(daemonControl.request).toHaveBeenCalledTimes(1);
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'installPath',
        locator: pluginRoot,
        development: true,
      });
      expect(daemonControl.decide).not.toHaveBeenCalled();
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('returns a truthful pending package review without self-approval', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    await materializeDevPlugin(pluginRoot);
    const review = createPluginInstallationReviewFixture({
      pluginId: 'acme.dev-loop',
      displayName: 'Acme Dev Loop',
      source: { kind: 'path', locator: pluginRoot },
      updateChannel: { kind: 'path', locator: pluginRoot, development: false },
    });
    daemonControl.request.mockResolvedValue({
      kind: 'reviewRequired',
      pendingChangeId: 'pending-package-review-1',
      review,
    });

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: { path: pluginRoot, force: true },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(install).toMatchObject({
        ok: false,
        kind: 'plugins_install',
        outcome: 'reviewRequired',
        pendingReview: {
          kind: 'reviewRequired',
          pendingChangeId: 'pending-package-review-1',
          review,
        },
      });
      expect(install).not.toHaveProperty('pendingChangeId');
      expect(install).not.toHaveProperty('review');
      expect(daemonControl.request).toHaveBeenCalledTimes(1);
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'installPath',
        locator: pluginRoot,
        development: false,
      });
      expect(daemonControl.decide).not.toHaveBeenCalled();
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
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

  it('passes the current CLI invoker into pristine scaffold scripts and generated skill guidance', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const targetDir = join(workspaceRoot, 'generated-plugin');
    const envScope = createEnvKeyScope(['HAPPIER_CLI_INVOKER_NAME']);
    envScope.patch({ HAPPIER_CLI_INVOKER_NAME: 'hdev' });

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
        ok: true,
        kind: 'plugins_scaffold',
      });
      const packageJson = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8')) as Readonly<{
        scripts: Readonly<Record<string, string>>;
      }>;
      const skill = await readFile(join(
        targetDir,
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      expect(packageJson.scripts.build).toBe('hdev plugins dev build .');
      expect(packageJson.scripts.typecheck).toBe('hdev plugins dev typecheck .');
      expect(packageJson.scripts.test).toBe('hdev plugins test .');
      expect(packageJson.scripts['pack:plugin']).toBe('hdev plugins pack .');
      expect(skill).toContain('hdev plugins dev');
      expect(skill).toContain('hdev plugins doctor .');
      expect(skill).not.toContain('happier plugins dev');
    } finally {
      envScope.restore();
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
    const sourceRoot = await createTempDir('happier-plugin-dev-loop-source-');
    await materializeDevPlugin(sourceRoot, 'acme.broken');
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
      message: "Development entrypoint './src/daemon.ts' failed to compile: Unexpected token",
    });

    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.reload',
        input: { pluginId: 'acme.broken' },
        happyHomeDir: home,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{
          code: 'plugin_change_failed',
          message: "Development entrypoint './src/daemon.ts' failed to compile: Unexpected token",
        }],
      });
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'development',
        pluginId: 'acme.broken',
        sourceRootPath: await realpath(sourceRoot),
      });
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });

  it('keeps the source inspector realpath when a reloaded catalog locator is a symlink', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const sourceRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    const linkedSourceRoot = join(workspaceRoot, 'linked-plugin-source');
    await materializeDevPlugin(sourceRoot, 'acme.realpath');
    await symlink(sourceRoot, linkedSourceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await createPluginStateStore({ happyHomeDir: home }).write({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.realpath': {
          source: {
            kind: 'path',
            locator: linkedSourceRoot,
            resolvedPath: '/plugins/generations/acme-realpath-1',
            manifestPath: '/plugins/generations/acme-realpath-1/.happier-plugin/plugin.json',
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
      await executePluginDevLoopAction({
        actionId: 'plugins.reload',
        input: { pluginId: 'acme.realpath' },
        happyHomeDir: home,
      });

      expect(daemonControl.request).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'development',
        pluginId: 'acme.realpath',
        sourceRootPath: await realpath(sourceRoot),
      }));
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('submits one Agent development snapshot through the daemon change owner without starting a watcher or self-approval', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const sourceRoot = await createTempDir('happier-plugin-dev-loop-source-');
    await materializeDevPlugin(sourceRoot, 'acme.one-shot');
    daemonControl.request.mockResolvedValue({
      kind: 'sourceRootReviewRequired',
      pendingChangeId: 'pending-one-shot-1',
      review: { source: { kind: 'path', locator: sourceRoot } },
    });

    try {
      const result = await executePluginDevLoopAction({
        actionId: 'plugins.dev.submit' as any,
        input: { projectRoot: sourceRoot },
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: false,
        kind: 'plugins_dev_submit',
        outcome: 'reviewRequired',
        pendingReview: {
          kind: 'sourceRootReviewRequired',
          pendingChangeId: 'pending-one-shot-1',
          review: { source: { kind: 'path', locator: sourceRoot } },
        },
      });
      expect(result).not.toHaveProperty('pendingChangeId');
      expect(result).not.toHaveProperty('review');
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'development',
        pluginId: 'acme.one-shot',
        sourceRootPath: await realpath(sourceRoot),
      });
      expect(daemonControl.decide).not.toHaveBeenCalled();
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });

  it('falls back to the rejection kind when the daemon reports no diagnosable cause', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const sourceRoot = await createTempDir('happier-plugin-dev-loop-source-');
    await materializeDevPlugin(sourceRoot, 'acme.broken');
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
      kind: 'unavailable' as const,
      code: 'plugin_change_service_unavailable',
    });

    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.reload',
        input: { pluginId: 'acme.broken' },
        happyHomeDir: home,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_reload',
        diagnostics: [{
          code: 'plugin_change_service_unavailable',
          message: 'The daemon rejected the development reload (unavailable).',
        }],
      });
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });
});
