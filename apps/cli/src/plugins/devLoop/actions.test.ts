import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { createDaemonPathPluginChangePreparer } from '@/plugins/daemon/pathChangePreparer';
import { startPluginDevelopmentSourceObserver } from '@/plugins/authoring/sourceObserver';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';

import { executePluginDevLoopAction } from './actions';
import { createCliApprovalActionDeps } from '@/session/actions/approvals/cliActionDeps';

const daemonControl = vi.hoisted(() => ({
  request: vi.fn(),
  decide: vi.fn(),
  status: vi.fn(),
  development: vi.fn(),
  ensure: vi.fn(async () => {}),
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonPluginChange: daemonControl.request,
  decideDaemonPluginChange: daemonControl.decide,
  readDaemonPluginChangeStatus: daemonControl.status,
  controlDaemonPluginDevelopment: daemonControl.development,
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
      engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
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
    daemonControl.status.mockReset();
    daemonControl.ensure.mockClear();
    daemonControl.development.mockReset();
  });

  it('carries the daemon busy reason through uninstall and the public approval result projection', async () => {
    daemonControl.request.mockResolvedValue({ kind: 'busy', pluginId: 'acme.dev-loop' });
    const result = await executePluginDevLoopAction({ actionId: 'plugins.uninstall', input: { pluginId: 'acme.dev-loop' } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, actionId: 'plugins.uninstall',
      actionArgs: { pluginId: 'acme.dev-loop' }, status: 'executed', summary: 'Remove plugin',
      createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home-1', serverIdentityId: 'home-identity', accountId: 'account-1', machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' }, actionId: 'plugins.uninstall', requestId: 'uninstall-1' },
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
      execution: { executedAtMs: 3, ok: true, result },
    });
    expect(readApprovalExecutionFailure(request)).toMatchObject({ ok: false, errorCode: 'busy',
      error: expect.stringContaining('acme.dev-loop') });
  });

  it('unregisters the exact development root through the daemon owner and reports failures', async () => {
    const status = { roots: [], plugins: [] };
    daemonControl.development.mockResolvedValueOnce({ kind: 'status', status });
    const signal = new AbortController().signal;
    await expect(executePluginDevLoopAction({
      actionId: 'plugins.dev.unregister',
      input: { projectRoot: '/workspace/plugin' }, context: { signal },
    })).resolves.toEqual({ ok: true, kind: 'plugins_dev_unregister', status });
    expect(daemonControl.development).toHaveBeenCalledWith(
      { kind: 'unregisterExplicit', rootPath: '/workspace/plugin' }, { signal },
    );
    daemonControl.development.mockResolvedValueOnce({ kind: 'failed', code: 'root_missing', message: 'Missing root', status });
    await expect(executePluginDevLoopAction({
      actionId: 'plugins.dev.unregister', input: { projectRoot: '/workspace/plugin' },
    })).resolves.toEqual({ ok: false, kind: 'plugins_dev_unregister', diagnostics: [{ code: 'root_missing', message: 'Missing root' }] });
  });

  const failureCause = { phase: 'plugins.change.prepare', errorClass: 'Error' as const,
    errorCode: 'plugin_change_superseded', httpStatus: null };
  const registryRequirement = { registryOrigin: 'https://registry.example.test',
    packageName: '@acme/dev-loop', registryProfileId: null };

  it.each([
    {
      name: 'failure cause',
      input: { path: '/workspace/plugin', dev: true },
      daemonResult: { kind: 'failed', code: 'plugin_change_failed', details: { failureCause } },
      failure: { errorCode: 'plugin_change_failed', failureCause },
    },
    {
      name: 'registry profile requirement',
      input: { source: { kind: 'marketplace', sourceId: 'catalog-1', pluginId: 'acme.dev-loop',
        version: '1.0.0', packageName: registryRequirement.packageName } },
      daemonResult: { kind: 'registryProfileRequired', ...registryRequirement },
      failure: { errorCode: 'plugin_registry_profile_required', details: registryRequirement },
    },
  ])('retains the daemon $name in install approval preparation', async ({ input, daemonResult, failure }) => {
    daemonControl.request.mockResolvedValueOnce(daemonResult);
    const deps = createCliApprovalActionDeps({}, {
      approvalsStore: null,
      managedMachineReferences: async () => { throw new Error('Unexpected Machine lookup'); },
      normalizeStringValue: value => typeof value === 'string' ? value : null,
      pluginInstallApprovalChangeServices: {},
      readRecord: value => value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {},
      resolvePluginInstallWorkspaceRoot: async () => undefined,
      resolvePluginInstallRegistry: async () => ({ ok: true, registry: createCliRegistryHostV1() }),
    });
    if (!deps.buildApprovalPreview) throw new Error('Expected approval preview owner');
    await expect(deps.buildApprovalPreview({ actionId: 'plugins.install',
      input, context: { surface: 'cli' }, defaultPreview: { actionId: 'plugins.install', actionArgs: input, summary: 'Install plugin' },
    })).resolves.toMatchObject({ ok: false, ...failure });
  });

  it.each(['prepare', 'adopt'] as const)('retains the daemon %s failure cause in the install Action', async (phase) => {
    const failureCause = { phase: `plugins.development.${phase}`, errorClass: 'Error' as const,
      errorCode: 'plugin_change_superseded', httpStatus: null };
    const failed = { kind: 'failed', code: 'plugin_change_failed', details: { failureCause } };
    const pending = { kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'pending-cause',
      reason: 'firstInstall', currentVersion: null, authorityExpansion: [], review: createPluginInstallationReviewFixture() };
    daemonControl.request.mockResolvedValueOnce(phase === 'prepare' ? failed : pending);
    daemonControl.status.mockResolvedValueOnce(pending);
    daemonControl.decide.mockResolvedValueOnce(failed);
    await expect(executePluginDevLoopAction({ actionId: 'plugins.install',
      input: { path: '/workspace/plugin', dev: true },
    }, { installEffectAdmitted: true })).resolves.toMatchObject({
      ok: false, errorCode: 'plugin_change_failed', failureCause,
    });
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

  it('prepares a development install through the daemon change owner', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const workspaceRoot = await createTempDir('happier-plugin-dev-loop-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-dev-loop-source-', workspaceRoot);
    await materializeDevPlugin(pluginRoot);
    daemonControl.request.mockResolvedValue({
      kind: 'committed',
      pluginId: 'acme.dev-loop',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    });

    try {
      const install = await executePluginDevLoopAction({
        actionId: 'plugins.install',
        input: { path: pluginRoot, dev: true },
        happyHomeDir: home,
        workspaceRoot,
      });

      expect(install).toMatchObject({
        ok: true,
        kind: 'plugins_install',
        outcome: 'applied',
      });
      expect(daemonControl.request).toHaveBeenCalledWith({
        kind: 'development', sourceRootPath: pluginRoot,
      });
      expect(daemonControl.development).not.toHaveBeenCalled();
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
      kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
          kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
      });
      expect(daemonControl.decide).not.toHaveBeenCalled();
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('settles a daemon install review once with approval-owner proof', async () => {
    const integrity = `sha256-${Buffer.alloc(32, 7).toString('base64')}`;
    const review = createPluginInstallationReviewFixture({
      pluginId: 'acme.reviewed',
      source: { kind: 'archive', locator: '/tmp/acme-reviewed.tgz', integrity, integrityBasis: 'observed' },
      updateChannel: { kind: 'archive', locator: '/tmp/acme-reviewed.tgz' },
    });
    const pending = {
      kind: 'reviewRequired' as const,
      reviewKind: 'installation' as const,
      pendingChangeId: 'pending-approved-install',
      reason: 'firstInstall' as const,
      currentVersion: null,
      authorityExpansion: [],
      review,
    };
    daemonControl.status.mockResolvedValue(pending);
    daemonControl.decide.mockResolvedValue({
      kind: 'committed',
      pluginId: 'acme.reviewed',
      desiredGeneration: 'generation-1',
      appliedGeneration: 'generation-1',
      pendingSurfaces: [],
    });

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-reviewed.tgz', kind: 'archive', integrity },
      context: {
        presentUserApproval: {
          artifactId: 'approval-1',
          actionId: 'plugins.install',
          requestId: 'agent-install-1',
          inputDigest: 'digest-1',
        },
      },
    }, { approvedInstallReview: pending })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins_install',
      outcome: 'applied',
      change: { kind: 'committed', pluginId: 'acme.reviewed' },
    });
    expect(daemonControl.request).not.toHaveBeenCalled();
    expect(daemonControl.decide).toHaveBeenCalledTimes(1);
    expect(daemonControl.decide).toHaveBeenCalledWith({
      pendingChangeId: 'pending-approved-install',
      decision: 'installAndTrust',
      optionalSelections: [],
    });
  });

  it('returns a typed failure when the approved Artifact names an expired daemon review', async () => {
    const pending = {
      kind: 'reviewRequired' as const,
      reviewKind: 'installation' as const,
      pendingChangeId: 'pending-expired-install',
      reason: 'firstInstall' as const,
      currentVersion: null,
      authorityExpansion: [],
      review: createPluginInstallationReviewFixture({ pluginId: 'acme.expired' }),
    };
    daemonControl.status.mockResolvedValue({ kind: 'expired' });

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-expired', dev: true },
      context: { presentUserApproval: { artifactId: 'approval-expired', actionId: 'plugins.install',
        requestId: 'agent-install-expired', inputDigest: 'digest-expired' } },
    }, { approvedInstallReview: pending })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_change_expired',
      error: 'plugin_change_expired',
    });
    expect(daemonControl.decide).not.toHaveBeenCalled();
  });

  it('recovers an exact committed terminal daemon result without deciding it again', async () => {
    const pending = {
      kind: 'reviewRequired' as const,
      reviewKind: 'installation' as const,
      pendingChangeId: 'pending-committed-install',
      reason: 'firstInstall' as const,
      currentVersion: null,
      authorityExpansion: [],
      review: createPluginInstallationReviewFixture({ pluginId: 'acme.committed' }),
    };
    daemonControl.status.mockResolvedValue({
      kind: 'terminal',
      pendingChangeId: pending.pendingChangeId,
      result: {
        kind: 'committed',
        pluginId: 'acme.committed',
        desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1',
        pendingSurfaces: [],
      },
    });

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.install',
      input: { path: '/tmp/acme-committed', dev: true },
      context: { presentUserApproval: { artifactId: 'approval-committed', actionId: 'plugins.install',
        requestId: 'agent-install-committed', inputDigest: 'digest-committed' } },
    }, { approvedInstallReview: pending })).resolves.toMatchObject({
      ok: true,
      kind: 'plugins_install',
      outcome: 'applied',
      change: { kind: 'committed', pluginId: 'acme.committed' },
    });
    expect(daemonControl.decide).not.toHaveBeenCalled();
  });

  it('does not approve a second daemon review that was not carried by the approval Artifact', async () => {
    const review = createPluginInstallationReviewFixture({ pluginId: 'acme.reviewed' });
    const approved = {
      kind: 'reviewRequired' as const, reviewKind: 'installation' as const,
      pendingChangeId: 'pending-approved-install', reason: 'firstInstall' as const,
      currentVersion: null, authorityExpansion: [], review,
    };
    const next = { ...approved, pendingChangeId: 'pending-unreviewed-install', reason: 'permissionsChanged' as const };
    daemonControl.status.mockResolvedValue(approved);
    daemonControl.decide
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce({ kind: 'committed', pluginId: 'acme.reviewed', desiredGeneration: 'generation-1',
        appliedGeneration: 'generation-1', pendingSurfaces: [] });

    await expect(executePluginDevLoopAction({
      actionId: 'plugins.install', input: { path: '/tmp/acme-reviewed.tgz', kind: 'archive' },
      context: { presentUserApproval: { artifactId: 'approval-1', actionId: 'plugins.install',
        requestId: 'agent-install-1', inputDigest: 'digest-1' } },
    }, { approvedInstallReview: approved })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_change_superseded',
      error: 'plugin_change_superseded',
      details: { change: { kind: 'reviewRequired', pendingChangeId: 'pending-unreviewed-install' } },
    });
    expect(daemonControl.decide).toHaveBeenCalledTimes(1);
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

  it('validates uninstall input before dispatch and retains the daemon rejection for an unknown target', async () => {
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), pluginsDevLoopAction: executePluginDevLoopAction });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'plugins.uninstall': ['ui'] } }) };
    expect(await executor.execute('plugins.uninstall', {}, context)).toMatchObject({ ok: false });
    expect(daemonControl.request).not.toHaveBeenCalled();
    daemonControl.request.mockResolvedValue({ kind: 'failed', code: 'plugin_change_preparation_failed', message: 'Unknown plugin id: acme.missing' });
    const unknownTarget = await executor.execute('plugins.uninstall', { pluginId: 'acme.missing' }, context);
    expect(unknownTarget, JSON.stringify(unknownTarget)).toMatchObject({
      ok: true, result: { ok: false, kind: 'plugins_uninstall',
        change: { kind: 'failed', code: 'plugin_change_preparation_failed' } },
    });
    expect(daemonControl.request).toHaveBeenCalledWith({ kind: 'uninstall', pluginId: 'acme.missing' });
  });

  it('routes UI reload directly through the real owner while retaining waivable automation review and explicit Ask', async () => {
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
    daemonControl.development.mockResolvedValue({
      kind: 'failed' as const,
      code: 'plugin_change_failed',
      message: "Development entrypoint './src/daemon.ts' failed to compile: Unexpected token",
    });

    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), pluginsDevLoopAction: async args => executePluginDevLoopAction({ ...args, happyHomeDir: home }) });
      const input = { pluginId: 'acme.broken' };
      for (const surface of ['agent', 'mcp'] as const) {
        expect(await executor.execute('plugins.reload', input, { surface })).toMatchObject({ ok: false });
      }
      const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'plugins.reload': { approvalRequiredSurfaces: ['ui'] } } });
      expect(await executor.execute('plugins.reload', input, { surface: 'ui', authority: 'present_user', actionsSettings: ask })).toMatchObject({ ok: false });
      expect(daemonControl.development).not.toHaveBeenCalled();
      for (const surface of ['ui', 'agent', 'mcp'] as const) {
        const actionsSettings = surface === 'ui' ? undefined : ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'plugins.reload': [surface] } });
        await expect(executor.execute('plugins.reload', input, { surface, actionsSettings,
          ...(surface === 'ui' ? { authority: 'present_user' as const } : {}) })).resolves.toMatchObject({
          ok: true, result: { ok: false, kind: 'plugins_reload', diagnostics: [{ code: 'plugin_change_failed',
            message: "Development entrypoint './src/daemon.ts' failed to compile: Unexpected token" }] },
        });
      }
      expect(daemonControl.development).toHaveBeenCalledWith({
        kind: 'reload', rootPath: sourceRoot,
      }, {});
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
    daemonControl.development.mockResolvedValue({
      kind: 'failed' as const,
      code: 'plugin_change_failed',
      message: 'Plugin change failed',
    });

    try {
      await executePluginDevLoopAction({
        actionId: 'plugins.reload',
        input: { pluginId: 'acme.realpath' },
        happyHomeDir: home,
      });

      expect(daemonControl.development).toHaveBeenCalledWith({
        kind: 'reload', rootPath: linkedSourceRoot,
      }, {});
    } finally {
      await removeTempDir(workspaceRoot);
      await removeTempDir(home);
    }
  });

  it('registers Agent development with the daemon watcher owner without self-approval', async () => {
    const home = await createTempDir('happier-plugin-dev-loop-action-');
    const sourceRoot = await createTempDir('happier-plugin-dev-loop-source-');
    await materializeDevPlugin(sourceRoot, 'acme.one-shot');
    daemonControl.development.mockResolvedValue({
      kind: 'status', status: { roots: [], plugins: [] },
    });

    try {
      const result = await executePluginDevLoopAction({
        actionId: 'plugins.dev.submit',
        input: { projectRoot: sourceRoot },
        happyHomeDir: home,
      });

      expect(result).toMatchObject({
        ok: true,
        kind: 'plugins_dev_submit',
        status: { roots: [], plugins: [] },
      });
      expect(daemonControl.development).toHaveBeenCalledWith({
        kind: 'registerExplicit', rootPath: sourceRoot,
      }, {});
      expect(daemonControl.decide).not.toHaveBeenCalled();
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });

  it.each([
    { invalidSettings: true, expectedCode: 'PLUGIN_SETTINGS_DEFAULT_INVALID' },
    { invalidSettings: false, expectedCode: 'plugin_dev_manifest_invalid' },
  ])('preserves the source refusal through native Submit ($expectedCode)', async ({ invalidSettings, expectedCode }) => {
    const home = await createTempDir('happier-plugin-submit-diagnostic-home-');
    const sourceRoot = await createTempDir('happier-plugin-submit-diagnostic-source-');
    const authoredValue = 'private-authored-default';
    const pluginId = 'acme.submit-diagnostic';
    const manifest = createPluginManifestV2Fixture({
      id: pluginId,
      ...(invalidSettings ? {
        contributes: {
          settings: [{
            id: 'preferences', title: 'Preferences', scope: 'daemon', target: { kind: 'plugin' },
            fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: authoredValue }],
          }],
        },
      } : { version: 'invalid-version' }),
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonPathPluginChangePreparer({
        happyHomeDir: home,
        runtimeLifecycle: { prepare: async () => { throw new Error('Invalid sources must not activate plugin code'); } },
        runManagedPluginPnpm: async () => { throw new Error('Invalid sources must not launch dependency tooling'); },
      }),
    });
    const owner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: home,
      submitObservation: async ({ request }) => service.requestPluginChange({
        ...request, sourceRootPath: request.projectRoot,
      }),
      // Only OS watches, dependency processes and plugin execution are system
      // boundaries; source admission, change service and Action remain real.
      startCollectionObserver: async () => ({ stop() {} }),
      startSourceObserver: async (projectRoot, onObservation) => startPluginDevelopmentSourceObserver({
        projectRoot, onObservation,
        startWatchingDirectory: () => ({ ready: Promise.resolve(), stop() {} }),
      }),
    });
    try {
      await mkdir(join(sourceRoot, '.happier-plugin'));
      await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(manifest));
      await owner.initialize();

      const result = await executePluginDevLoopAction({
        actionId: 'plugins.dev.submit', input: { projectRoot: sourceRoot }, happyHomeDir: home,
      }, { controlPluginDevelopment: request => owner.control(request) });

      expect(result).toMatchObject({
        ok: false, kind: 'plugins_dev_submit', diagnostics: [{ code: expectedCode }],
      });
      const serialized = JSON.stringify(result);
      if (invalidSettings) {
        expect(serialized).toContain(pluginId);
        expect(serialized).toContain('preferences');
        expect(serialized).toContain('enabled');
      } else {
        expect(serialized).not.toContain('PLUGIN_SETTINGS_');
      }
      expect(serialized).not.toContain(authoredValue);
      expect(owner.readStatus().plugins).toEqual([
        expect.objectContaining({ phase: 'unavailable', diagnostic: expect.objectContaining({ code: expectedCode }) }),
      ]);
      expect((await createPluginStateStore({ happyHomeDir: home }).read()).plugins).toEqual({});
    } finally {
      await owner.stop();
      await service.shutdown();
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
    daemonControl.development.mockResolvedValue({
      kind: 'failed' as const,
      code: 'plugin_change_service_unavailable',
      message: 'Plugin development control is unavailable',
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
          message: 'Plugin development control is unavailable',
        }],
      });
    } finally {
      await removeTempDir(sourceRoot);
      await removeTempDir(home);
    }
  });
});
