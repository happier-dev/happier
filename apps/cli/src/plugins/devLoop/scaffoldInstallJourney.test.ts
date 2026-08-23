import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { executePluginDevLoopAction } from './actions';
import { buildPluginInstallApprovalPreview } from './installApprovalPreview';

const daemonBoundary = vi.hoisted(() => ({
  ensureRunning: vi.fn(async () => undefined),
  requestChange: vi.fn(),
  decideChange: vi.fn(),
}));

vi.mock('@/daemon/ensureDaemon', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/ensureDaemon')>(),
  ensureDaemonRunningForSessionCommand: daemonBoundary.ensureRunning,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemonBoundary.requestChange,
  decideDaemonPluginChange: daemonBoundary.decideChange,
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
  it('previews and installs a pristine code-defined scaffold through the daemon installPath request', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-install-'));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-home-'));
    const targetDir = join(workspaceRoot, 'fresh-plugin');
    daemonBoundary.requestChange.mockReset();
    daemonBoundary.requestChange.mockResolvedValue({
      kind: 'sourceRootReviewRequired',
      pendingChangeId: 'pending-scaffold-install-1',
      review: { source: { kind: 'path', locator: targetDir } },
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
      });
      expect(preview).toMatchObject({
        actionId: 'plugins.install',
        pluginInstall: {
          ok: true,
          authoring: 'code',
          source: { kind: 'path', dev: true, trustPolicy: 'prompt', installPolicy: 'link' },
          provenance: {
            sourceKind: 'path',
            entryPath: expect.stringContaining(join('fresh-plugin', 'src', 'index.ts')),
          },
          // Identity and host access are the daemon's to establish, so the
          // preview must not present an empty permission set as "none".
          permissionsDisclosure: 'pendingDaemonEvaluation',
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
        ok: false,
        kind: 'plugins_install',
        outcome: 'reviewRequired',
        pendingReview: {
          kind: 'sourceRootReviewRequired',
          pendingChangeId: 'pending-scaffold-install-1',
        },
      });
      expect(daemonBoundary.requestChange).toHaveBeenCalledWith({
        kind: 'installPath',
        locator: targetDir,
        development: true,
      });

      await expect(executePluginDevLoopAction({
        actionId: 'plugins.change.status',
        input: { pendingChangeId: 'pending-scaffold-install-1' },
        workspaceRoot,
        happyHomeDir,
      }, {
        readUserPluginChangeStatus: async ({ pendingChangeId }) => ({
          kind: 'sourceRootReviewRequired' as const,
          pendingChangeId,
          review: { source: { kind: 'path' as const, locator: targetDir } },
        }),
      })).resolves.toMatchObject({
        ok: true,
        kind: 'plugins_change_status',
        status: { kind: 'sourceRootReviewRequired', pendingChangeId: 'pending-scaffold-install-1' },
      });
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
