import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, type DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';

function fixture() {
    const detail = createDeploymentEnvironmentDetailV1();
    detail.environment.revision = 4;
    const configuration: DeploymentBackupConfigurationV1 = {
        configRevision: 2, destinationRef: { pluginId: 'example.backups', localId: 'repository' }, occurrenceId: 'installed',
        config: { path: '/backups/app' }, credentialBindings: [],
        sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
        ownership: { environmentId: detail.environment.id, prefix: 'app' }, retention: { kind: 'keepEverything' },
    };
    detail.content.backup = configuration;
    const { configRevision: _configRevision, ...backupPolicy } = configuration;
    let targetLinks = [createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'capture-a' })];
    detail.environment.runtimeTargetLinkId = targetLinks[0]!.id;
    const counts = { metadata: 0, content: 0 };
    // Home metadata and opened Artifact storage are boundaries. The real
    // Environment reader and canonical target selectors remain under test.
    const host: Parameters<typeof readDeploymentEnvironmentForHost>[1] = {
        async readMetadata() { counts.metadata++; return { ok: true, environment: detail.environment, targetLinks }; },
        async open() { counts.content++; return { artifactId: detail.environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name },
            body: JSON.stringify(detail.content), revision: { headerVersion: 1, bodyVersion: 1 } }; },
        async assertCurrent() {},
    };
    const request = { environmentId: detail.environment.id, context: {}, backupPolicy };
    return { detail, configuration, backupPolicy, counts, host, request,
        redeploy() {
            detail.environment.revision = 5;
            targetLinks = [createDeploymentTargetLinkHeaderV1({ activeDeploymentId: 'capture-b',
                machines: ['machine-b'], members: [{ machineId: 'machine-b', installationId: 'installation-b', state: 'active' }] })];
        },
        removeTarget() { targetLinks = []; delete detail.environment.runtimeTargetLinkId; },
    };
}

describe('Environment backup occurrence projection', () => {
    it('resolves each occurrence from the current Environment and retains the actual destination policy', async () => {
        const f = fixture();
        expect(await readDeploymentEnvironmentForHost(f.request, f.host)).toMatchObject({
            backupTarget: { environmentId: f.detail.environment.id, expectedRevision: 4, configRevision: 2,
                targetLinkId: 'target-link', deploymentId: 'capture-a', machineId: 'machine-a', installationId: 'installation-a' },
            backupPolicy: f.backupPolicy,
        });
        f.redeploy();
        expect(await readDeploymentEnvironmentForHost(f.request, f.host)).toMatchObject({
            backupTarget: { expectedRevision: 5, configRevision: 2, deploymentId: 'capture-b',
                machineId: 'machine-b', installationId: 'installation-b' }, backupPolicy: f.backupPolicy,
        });
        f.detail.content.backup = { ...f.configuration, configRevision: 3, config: { path: '/backups/changed' } };
        expect(await readDeploymentEnvironmentForHost(f.request, f.host)).toMatchObject({
            backupTarget: { configRevision: 3 }, backupPolicy: { config: { path: '/backups/changed' } },
        });
        expect(f.counts).toEqual({ metadata: 3, content: 3 });
    });

    it('reports an unavailable occurrence before any runtime Target exists', async () => {
        const f = fixture();
        f.removeTarget();
        await expect(readDeploymentEnvironmentForHost(f.request, f.host)).rejects.toMatchObject({ code: 'deployment_unavailable' });
        expect(f.counts).toEqual({ metadata: 1, content: 1 });
    });
});
