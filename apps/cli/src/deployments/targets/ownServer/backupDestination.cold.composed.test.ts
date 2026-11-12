import { expect, it } from 'vitest';
import { plugin } from '../../../../../../packages/plugins/backup-destinations/src/manifest';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { openDeploymentBackupDestinationForHost } from './backupDestination';

it('opens a saved path-addressed S3 destination from a cold admitted runtime', async () => {
    // Recorded #100 shape: configuration and all three role bindings exist,
    // while an enabled destination need not have executed an Action yet.
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: plugin.manifest,
            files: { [plugin.manifest.entrypoints.daemon]: 'export function activate() {}', 'package.json': '{"type":"module"}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            }));
        },
        coldStart: true,
    });
    try {
        const occurrenceId = runtime.registry.readPluginOccurrenceId(plugin.manifest.id);
        expect(occurrenceId).toBeTruthy();
        expect(runtime.registry.targetActionInvocations.has(plugin.manifest.id, 's3/open')).toBe(false);
        const configuration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1,
            destinationRef: { pluginId: plugin.manifest.id, localId: 's3' }, occurrenceId,
            config: { endpoint: 'http://minio.invalid:9000', bucket: 'backups', prefix: 'qa',
                region: 'us-east-1', addressing: 'path' },
            credentialBindings: ['repositoryPassword', 'accessKeyId', 'secretAccessKey'].map(role => ({
                purpose: 'backupDestination', configKey: 'destination', role })),
            sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
            ownership: { environmentId: 'environment', prefix: 'restore' }, retention: { kind: 'keepEverything' },
        });
        const request = { registry: runtime.registry, configuration, context: {}, signal: new AbortController().signal };
        await expect(openDeploymentBackupDestinationForHost(request)).resolves.toEqual({
            repository: 's3:http://minio.invalid:9000/backups/qa/restore',
            credentialBindings: configuration.credentialBindings, s3: { region: 'us-east-1', addressing: 'path' },
        });
        // The same captured configuration also remains usable after activation.
        await expect(openDeploymentBackupDestinationForHost(request)).resolves.toMatchObject({
            credentialBindings: configuration.credentialBindings,
        });
    } finally { await runtime.dispose(); }
});
