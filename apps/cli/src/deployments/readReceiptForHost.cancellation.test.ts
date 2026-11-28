import { expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { openDeploymentReceiptForHost, readDeploymentReceiptHistoryHeadersForHost, readOwnServerDeploymentReceiptHistoryForHost } from './readReceiptForHost';

it('refuses a foreign Environment receipt before yielding any row from its page', async () => {
    const { deployment } = createDeploymentReceiptDetailV1();
    const readPage = async () => ({ ok: true, items: [deployment, {
        ...deployment, id: 'foreign-receipt', environmentId: 'foreign-environment',
    }], nextCursor: null });
    const history = readDeploymentReceiptHistoryHeadersForHost({ environmentId: deployment.environmentId, readPage });
    await expect(history.next()).rejects.toMatchObject({ code: 'deployment_invalid' });
});

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

it('opens settled attempts in one batch per page while keeping live attempts exact', async () => {
    const fixture = createDeploymentReceiptDetailV1();
    const retained = ['older', 'newer'].map(id => ({ ...fixture.deployment, id, contentArtifactId: id,
        state: 'succeeded' as const }));
    const live = { ...fixture.deployment, id: 'running', state: 'running' as const, settledAtMs: undefined };
    const calls: string[][] = [];
    const input = {
        environmentId: fixture.deployment.environmentId,
        async readPage(cursor?: string) {
            return { ok: true, items: cursor ? [live] : retained, nextCursor: cursor ? null : 'next' };
        },
        async readCurrent(id: string) { calls.push([id]); return { ...fixture, deployment: live }; },
        async open(deployment: typeof fixture.deployment) { calls.push([deployment.id]); return { ...fixture, deployment }; },
        async openSettledPage(deployments: readonly (typeof fixture.deployment)[]) {
            calls.push(deployments.map(deployment => deployment.id));
            return deployments.map(deployment => ({ status: 'fulfilled' as const, value: { ...fixture, deployment } }));
        },
    };
    const ids = [];
    for await (const receipt of readOwnServerDeploymentReceiptHistoryForHost(input)) ids.push(receipt.deployment.id);
    expect(ids).toEqual(['older', 'newer', 'running']);
    expect(calls).toEqual([['older', 'newer'], ['running']]);
});
