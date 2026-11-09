import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { buildPluginInstallApprovalPreview } from './installApprovalPreview';
import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

function daemonEvaluation(source: ReturnType<typeof createPluginInstallationReviewFixture>['source']) {
  return {
    kind: 'reviewRequired' as const,
    reviewKind: 'installation' as const,
    pendingChangeId: 'pending-install-preview',
    reason: 'firstInstall' as const,
    currentVersion: null,
    authorityExpansion: [],
    review: createPluginInstallationReviewFixture({ source }),
  };
}

async function materializePlugin(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await writeFile(join(rootDir, 'daemon.mjs'), 'export function activate() {}\n', 'utf8');
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify(createPluginManifestV2Fixture({
      id: 'acme.install-preview',
      version: '1.2.3',
      displayName: 'Acme Install Preview',
      hostAccess: {
        required: [
          {
            id: 'network', capability: 'network', reason: 'Call the fixture API.',
            scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] },
          },
          {
            id: 'workspace', capability: 'filesystem', reason: 'Read the workspace.',
            scope: { locations: [{ root: 'workspace' }], access: ['read', 'delete'] },
          },
          {
            id: 'gateway', capability: 'network.client', reason: 'Maintain the gateway connection.',
            scope: {
              targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
              transports: ['websocket'],
            },
          },
        ],
        optional: [
          {
            id: 'synced-storage', capability: 'storage.account', reason: 'Synchronize state when selected.',
            scope: { enabled: true },
          },
        ],
      },
    }), null, 2),
    'utf8',
  );
}

describe('buildPluginInstallApprovalPreview', () => {
  it('presents retained daemon rights as last-known without probing or claiming current authority', async () => {
    const evaluation = daemonEvaluation({ kind: 'path', locator: '/unavailable-reviewed-source' });
    const review = createPluginInstallationReviewFixture({ daemonRights: {
      freshness: 'current', observation: {
        version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
        rootEquivalentGroups: ['docker'], passwordlessSudoToRoot: 'denied', managedDropIn: 'absent',
        tailscaledOperator: { authorization: 'allowed' },
      },
    } });
    expect(await buildPluginInstallApprovalPreview({ input: { path: '/unavailable-reviewed-source' },
      defaultPreview: {}, daemonEvaluation: { ...evaluation, review } })).toMatchObject({
        pluginInstall: { daemonAuthority: { hostAuthority: 'unknown', lastKnownHostAuthority: 'administrator', freshness: 'stale',
          tailscaledOperator: { authorization: 'allowed', currentAuthorization: 'unknown' } } },
      });
  });

  it('previews the requested marketplace pin without presenting unverified permissions as empty', async () => {
    const source = { kind: 'marketplace', sourceId: 'marketplace:team', pluginId: 'acme.plugin', version: '1.2.3' };
    expect(await buildPluginInstallApprovalPreview({ input: { source, machineId: 'machine-1' },
      daemonEvaluation: daemonEvaluation({ kind: 'npm', locator: '@acme/plugin@1.2.3',
        integrity: 'sha512-exact', integrityBasis: 'expected' }),
      defaultPreview: { actionId: 'plugins.install' } })).toMatchObject({
      actionId: 'plugins.install', pluginInstall: { ok: true, source, machineId: 'machine-1',
        permissionsDisclosure: 'daemonEvaluated',
        pendingReview: expect.objectContaining({ pendingChangeId: 'pending-install-preview' }) },
    });
  });
  it('uses the retained daemon review as the only local identity and permission disclosure', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-install-preview-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-install-preview-source-', workspaceRoot);
    await materializePlugin(pluginRoot);
    const evaluation = daemonEvaluation({ kind: 'path', locator: pluginRoot });

    try {
      const preview = await buildPluginInstallApprovalPreview({
        input: {
          path: pluginRoot,
          dev: true,
          force: true,
        },
        defaultPreview: {
          actionId: 'plugins.install',
          actionArgs: {
            path: pluginRoot,
            dev: true,
            force: true,
          },
        },
        workspaceRoot,
        daemonEvaluation: evaluation,
      });

      expect(preview).toEqual({
        actionId: 'plugins.install',
        actionArgs: {
          path: pluginRoot,
          dev: true,
          force: true,
        },
        pluginInstall: {
          ok: true,
          source: {
            kind: 'path',
            locator: pluginRoot,
            dev: true,
            force: true,
            dryRun: false,
          },
          permissionsDisclosure: 'daemonEvaluated',
          pendingReview: evaluation,
          daemonAuthority: expect.objectContaining({ hostAuthority: 'unknown' }),
        },
      });
    } finally {
      await removeTempDir(workspaceRoot);
    }
  });

  it('reuses the daemon-reviewed local candidate after its author source becomes unavailable', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-install-preview-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-install-preview-source-', workspaceRoot);
    await materializePlugin(pluginRoot);
    const evaluation = daemonEvaluation({ kind: 'path', locator: pluginRoot });
    await removeTempDir(pluginRoot);

    try {
      await expect(buildPluginInstallApprovalPreview({
        input: { path: pluginRoot, dev: true },
        defaultPreview: { actionId: 'plugins.install' },
        workspaceRoot,
        daemonEvaluation: evaluation,
      })).resolves.toMatchObject({
        actionId: 'plugins.install',
        pluginInstall: {
          ok: true,
          permissionsDisclosure: 'daemonEvaluated',
          pendingReview: evaluation,
        },
      });
    } finally {
      await removeTempDir(workspaceRoot);
    }
  });

  it('previews arbitrary local dev installs outside the workspace as prompt-trust installs', async () => {
    const workspaceRoot = await createTempDir('happier-plugin-install-preview-workspace-');
    const pluginRoot = await createTempDir('happier-plugin-install-preview-outside-');
    await materializePlugin(pluginRoot);

    try {
      const preview = await buildPluginInstallApprovalPreview({
        input: {
          path: pluginRoot,
          dev: true,
        },
        defaultPreview: {
          actionId: 'plugins.install',
          actionArgs: {
            path: pluginRoot,
            dev: true,
          },
        },
        workspaceRoot,
      });

      expect(preview).toEqual(expect.objectContaining({
        pluginInstall: expect.objectContaining({
          source: expect.objectContaining({
            kind: 'path',
            dev: true,
            trustPolicy: 'prompt',
            installPolicy: 'link',
          }),
        }),
      }));
    } finally {
      await removeTempDir(pluginRoot);
      await removeTempDir(workspaceRoot);
    }
  });
});
