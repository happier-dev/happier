import { expect, it } from 'vitest';
import { plugin } from '../../../../../../packages/plugins/backup-destinations/src/manifest';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployments/contracts/v1';
import {
  createAuthoredAdmittedPluginRuntimeFixture,
  requireDaemonEntrypoint,
} from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { openDeploymentBackupDestinationForHost } from './backupDestination';

it('hands native SFTP operands to the host while public Action results stay redacted', async () => {
  // Recorded #167b failure: restic received sftp://[REDACTED]@host and exited
  // with "net/url: invalid userinfo" before SSH.
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [
      {
        manifest: plugin.manifest,
        files: {
          [requireDaemonEntrypoint(plugin.manifest)]:
            'export function activate() {}',
          'package.json': '{"type":"module"}',
        },
        instantiateCommittedModule: () => ({ activate: plugin.activate }),
      },
    ],
    async resolveContributes(happyHomeDir) {
      return createResolvedContributionRegistry(
        projectLoadedPluginContributes({
          loadResult: await loadInstalledPlugins({ happyHomeDir }),
          provenance: 'external',
        }),
      );
    },
    coldStart: true,
  });
  try {
    const occurrenceId = runtime.registry.readPluginOccurrenceId(
      plugin.manifest.id,
    );
    const config = {
      host: '172.17.0.10',
      port: 22,
      username: 'w1_backup_165',
      path: '/upload',
      hostKey:
        '172.17.0.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFX+qRZjjWlOYMCNFPV67EqMN66oiY6BqbopaXcbPcfS',
    };
    const configuration = DeploymentBackupConfigurationV1Schema.parse({
      configRevision: 1,
      destinationRef: { pluginId: plugin.manifest.id, localId: 'sftp' },
      occurrenceId,
      config,
      credentialBindings: ['repositoryPassword', 'sshPrivateKey'].map(
        (role) => ({
          purpose: 'backupDestination',
          configKey: 'destination',
          role,
        }),
      ),
      sources: [
        {
          kind: 'dump',
          sourceId: 'database',
          service: 'postgres',
          consistency: 'logical',
        },
      ],
      ownership: {
        environmentId: 'environment',
        prefix: 'w1-backup-165-sftp-r2',
      },
      retention: { kind: 'keepEverything' },
    });
    const opened = await openDeploymentBackupDestinationForHost({
      registry: runtime.registry,
      configuration,
      context: {},
      signal: new AbortController().signal,
    });
    expect(opened.repository).toBe(
      'sftp://w1_backup_165@172.17.0.10:22//upload/w1-backup-165-sftp-r2',
    );

    // Any other caller of the same Action still receives the public projection.
    const published = await runtime.registry.targetActionInvocations.invoke({
      pluginId: plugin.manifest.id,
      localId: 'sftp/open',
      surface: 'plugin',
      requiredReadOnly: true,
      input: {
        config,
        credentialRoles: ['repositoryPassword', 'sshPrivateKey'],
        ownershipPrefix: 'w1-backup-165-sftp-r2',
      },
    });
    expect(published).toMatchObject({
      status: 'executed',
      value: {
        repository:
          'sftp://[REDACTED]@172.17.0.10:22//upload/w1-backup-165-sftp-r2',
      },
    });
  } finally {
    await runtime.dispose();
  }
});
