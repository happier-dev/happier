import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { executePluginDevLoopAction } from './actions';
import { buildPluginInstallApprovalPreview } from './installApprovalPreview';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import * as tar from 'tar';
import { PluginManifestV2Schema } from '@happier-dev/protocol';

const daemonBoundary = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
  development: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/ensureDaemon')>(),
  ensureDaemonRunningForSessionCommand: daemonBoundary.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemonBoundary.requestChange,
  decideDaemonPluginChange: daemonBoundary.decideChange,
  controlDaemonPluginDevelopment: daemonBoundary.development,
}));

/**
 * The Agent-facing authoring journey against the bytes `plugins.scaffold`
 * actually produces: a code-defined author root with no `.happier-plugin`
 * descriptor. Nothing here writes a synthetic legacy manifest, so the approval
 * preview and the install Action must both reach the daemon-owned install path
 * through the canonical author-source resolver rather than a manifest-only one.
 *
 * The only substituted boundary is the daemon transport itself.
 */
describe('scaffold → install authoring journey', () => {
  it('shares a theme batch through scaffold and pack without installing or publishing it', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-theme-share-'));
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.development.mockReset();
    try {
      const targetDir = join(workspaceRoot, 'themes');
      const theme = { schemaVersion: 1, id: 'shared', name: 'Shared theme', createdAt: '2026-11-16', updatedAt: '2026-11-16',
        base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, css: '[data-surface="session"] { color: red; }' };
      const scaffold = await executePluginDevLoopAction({ actionId: 'plugins.scaffold',
        input: { template: 'themes', themes: [theme], targetDir, id: 'acme.shared-themes', name: 'Shared themes' }, workspaceRoot });
      expect(scaffold).toMatchObject({ ok: true, createdPaths: { targetDir } });
      const outPath = join(workspaceRoot, 'shared.tgz');
      const packed = await executePluginDevLoopAction({ actionId: 'plugins.pack', input: { locator: targetDir, outPath }, workspaceRoot });
      expect(packed, JSON.stringify(packed)).toMatchObject({ ok: true, package: { archivePath: outPath, archiveDigest: expect.any(String) } });
      const contents: string[] = [];
      await tar.t({ file: outPath, onReadEntry: entry => { contents.push(entry.path); } });
      expect(contents).toContain('package/.happier-plugin/plugin.json');
      const extracted = join(workspaceRoot, 'extracted');
      await mkdir(extracted);
      await tar.x({ file: outPath, cwd: extracted });
      expect(PluginManifestV2Schema.parse(JSON.parse(await readFile(join(extracted, 'package/.happier-plugin/plugin.json'), 'utf8')))
        .contributes.themes).toEqual([{ id: 'theme-1', theme }]);
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
      expect(daemonBoundary.development).not.toHaveBeenCalled();
    } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
  });
  it('previews and registers a pristine code-defined scaffold through the daemon development-root owner', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-install-'));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-home-'));
    const targetDir = join(workspaceRoot, 'fresh-plugin');
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.development.mockReset();
    daemonBoundary.requestChange.mockResolvedValue({
      kind: 'committed', pluginId: 'acme.fresh-scaffold', desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1', pendingSurfaces: [],
    });

    try {
      await expect(executePluginDevLoopAction({
        actionId: 'plugins.scaffold',
        input: { targetDir, id: 'acme.fresh-scaffold', name: 'Fresh Scaffold' },
        workspaceRoot,
        happyHomeDir,
      })).resolves.toMatchObject({
        ok: true,
        kind: 'plugins_scaffold',
        plugin: { pluginId: 'acme.fresh-scaffold' },
      });
      await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const preview = await buildPluginInstallApprovalPreview({
        input: { path: targetDir, dev: true },
        defaultPreview: { actionId: 'plugins.install' },
        workspaceRoot,
        daemonEvaluation: {
          kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending-code-install',
          reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
          review: createPluginInstallationReviewFixture({
            pluginId: 'acme.fresh-scaffold', source: { kind: 'path', locator: targetDir },
            updateChannel: { kind: 'path', locator: targetDir, development: true },
          }),
        },
      });
      expect(preview).toMatchObject({
        actionId: 'plugins.install',
        pluginInstall: {
          ok: true,
          source: { kind: 'path', dev: true },
          permissionsDisclosure: 'daemonEvaluated',
          pendingReview: expect.objectContaining({ pendingChangeId: 'pending-code-install' }),
        },
      });
      expect(preview).not.toHaveProperty('pluginInstall.diagnostics');
      expect(preview).not.toHaveProperty('pluginInstall.permissions');

      await expect(executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: { path: targetDir, dev: true },
        workspaceRoot,
        happyHomeDir,
      })).resolves.toMatchObject({
        ok: true,
        kind: 'plugins_install',
        outcome: 'applied',
        change: { kind: 'committed', pluginId: 'acme.fresh-scaffold' },
      });
      expect(daemonBoundary.requestChange).toHaveBeenCalledWith({
        kind: 'development', sourceRootPath: targetDir,
      });
      expect(daemonBoundary.development).not.toHaveBeenCalled();

    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('refuses a dry-run preview of a code-defined source instead of pre-judging it without a manifest', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-dryrun-'));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-dryrun-home-'));
    const targetDir = join(workspaceRoot, 'fresh-plugin');
    daemonBoundary.requestChange.mockReset();

    try {
      await executePluginDevLoopAction({
        actionId: 'plugins.scaffold',
        input: { targetDir, id: 'acme.fresh-dryrun', name: 'Fresh Dry Run' },
        workspaceRoot,
        happyHomeDir,
      });

      await expect(executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: { path: targetDir, dev: true, dryRun: true },
        workspaceRoot,
        happyHomeDir,
      })).resolves.toMatchObject({
        ok: false,
        kind: 'plugins_install',
        outcome: 'failed',
        diagnostics: [{ code: 'plugin_source_kind_unsupported' }],
      });
      expect(daemonBoundary.requestChange).not.toHaveBeenCalled();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });
});
