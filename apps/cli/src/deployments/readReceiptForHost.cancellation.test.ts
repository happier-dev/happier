import { expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { openDeploymentReceiptForHost } from './readReceiptForHost';

it('carries the observed stopped incumbent through the canonical private receipt read until recovery', async () => {
    const fixture = createDeploymentReceiptDetailV1();
    const machine = { machineId: fixture.content.machines[0]!, installationId: 'installation',
        steps: [], activation: 'pending', health: 'unknown', incumbentStopped: true };
    const body = { ...fixture.content, machineResults: [machine] };
    let opens = 0;
    const read = () => openDeploymentReceiptForHost({ ...fixture.deployment, state: 'running' }, {}, {
        async open() { opens++; return { artifactId: fixture.deployment.contentArtifactId,
            revision: { headerVersion: fixture.deployment.contentHeaderVersion, bodyVersion: fixture.deployment.contentBodyVersion },
            header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Candidate' }, body: JSON.stringify(body) }; },
        async assertCurrent() {},
    });
    expect(await read()).toMatchObject({ cancellationConsequence: { kind: 'service-down-until-rollback' } });
    body.machineResults = [{ ...machine, incumbentStopped: false }];
    expect(await read()).not.toHaveProperty('cancellationConsequence');
    expect(opens).toBe(2);
});

it('distinguishes possible interruption during activation from the earlier build phase', async () => {
    const fixture = createDeploymentReceiptDetailV1();
    const body = { ...fixture.content, steps: [{ id: 'build', label: 'Build', state: 'running' }] };
    const read = () => openDeploymentReceiptForHost({ ...fixture.deployment, state: 'running', predecessorDeploymentId: 'incumbent' }, {}, {
        async open() { return { artifactId: fixture.deployment.contentArtifactId,
            revision: { headerVersion: fixture.deployment.contentHeaderVersion, bodyVersion: fixture.deployment.contentBodyVersion },
            header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Candidate' }, body: JSON.stringify(body) }; },
        async assertCurrent() {},
    });
    expect(await read()).not.toHaveProperty('cancellationConsequence');
    body.steps = [{ id: 'activate', label: 'Activate', state: 'running' }];
    expect(await read()).toMatchObject({ cancellationConsequence: { kind: 'may-leave-service-down-until-rollback' } });
});
