import { expect, it } from 'vitest';
import { OwnServerDeploymentInputBasisV1Schema } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
    createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentTargetHostInput,
    type OwnServerDeploymentRequest } from './ownServerDeploymentTarget';

it('settles an admitted rollout on captured Machines after the next placement changes', async () => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['machine-a'];
    link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
    link.activeDeploymentId = 'uniform';
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id: 'rollback', operation: 'rollback',
        state: 'queued', acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' },
            builder: { machineId: 'machine-a', installationId: 'installation-a' } } });
    receipt.content = { ...receipt.content, machines: ['machine-a'], machineResults: [],
        ownServer: { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
            environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'rollback',
            toolVersion: '2.40.1', services: ['app'], profiles: [], bindings: [], images: receipt.content.images,
            ownServer: environment.content.ownServer, members: [{ machineId: 'machine-a', installationId: 'installation-a' }] }) } };
    const uniform = structuredClone(receipt);
    uniform.deployment = { ...uniform.deployment, id: 'uniform', state: 'succeeded' };
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.rollback',
        input: { serverId: 'home', environmentId: environment.environment.id, deploymentId: uniform.deployment.id,
            expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
            requestKey: 'admitted-placement', contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1 },
        receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
        context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
    const activated: string[] = [];
    // Home storage and remote native effects are the boundaries. The real
    // executor, receipt placement and aggregate settlement stay intact.
    const host: OwnServerDeploymentTargetHostInput = {
        credentials: { token: 'storage-boundary', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
        readEnvironment: async () => structuredClone(environment),
        readReceipt: async ({ deploymentId }) => structuredClone(deploymentId === 'uniform' ? uniform : receipt),
        async writeTransition(input) {
            if (input.content.platform) throw new Error('The own-server fixture admits only own-server receipt content');
            receipt.content = input.content;
            receipt.deployment = { ...receipt.deployment, revision: receipt.deployment.revision + 1, state: input.state };
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
        },
        runtime: { async acquire() { throw new Error('Only the remote native Machine executes'); } },
        async dispatchMember({ phase, machineId, installationId, selectedDeploymentId }) {
            if (phase === 'activate') {
                activated.push(machineId);
                receipt.content.machineResults = [{ machineId, installationId, activation: 'succeeded', health: 'healthy',
                    currentDeploymentId: selectedDeploymentId, actionOperationId: receipt.deployment.actionOperationId, steps: [] }];
                receipt.deployment.revision++;
            }
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        },
    };
    link.revision++;
    link.machines = ['next-machine'];
    link.members = [{ machineId: 'next-machine', installationId: 'next-installation', state: 'active' }];
    environment.environment.controllerMachineId = 'next-controller';
    environment.environment.buildMachineId = 'next-builder';
    const result = await createOwnServerDeploymentTargetForHost(host).execute(request);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: 'succeeded' });
    expect(activated).toEqual(['machine-a']);
});
