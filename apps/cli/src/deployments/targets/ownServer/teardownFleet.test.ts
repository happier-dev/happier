import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema, type DeploymentOwnServerContentV1 } from '@happier-dev/deployment-protocol';
import { createOwnServerTeardownForHost } from './teardown';

it.each([undefined, ['machine-b']])('prepares exactly the selected fleet members, retaining installation custody (%j)', async machines => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0].targetLink;
    link.members = [
        { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
        { machineId: 'machine-b', installationId: 'installation-b', state: 'active' },
    ];
    link.machines = link.members.map(member => member.machineId);
    const prior = createDeploymentReceiptDetailV1();
    let candidate: DeploymentOwnServerContentV1 | undefined;
    // Home records and Artifact publication are IO boundaries. Preparation and
    // admission run through their real owners; no native effect is authorized.
    const teardown = createOwnServerTeardownForHost({ serverId: 'home', machineId: 'machine-a',
        credentials: { token: 'test-token', encryption: null }, serverHttpBaseUrl: 'https://unused-home.test',
        runtime: { async acquire() { throw new Error('No deployment is admitted'); },
            async acquireTeardown() { throw new Error('Preparation must not remove workloads'); } },
        async readEnvironment() { return environment; },
        async *readBuildHistory() { yield prior; },
        async readReceipt() { throw new Error('No teardown receipt exists yet'); },
        async writeTransition() { throw new Error('Preparation cannot settle a receipt'); },
        async findReceipt() { return null; },
        async createCandidate(_environment, content) {
            candidate = DeploymentOwnServerContentV1Schema.parse(content);
            return { contentArtifactId: 'fleet-teardown-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
        },
    });
    const prepared = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
        targetLinkId: link.id, reason: 'manual', requestKey: 'fleet-teardown', ...(machines ? { machines } : {}) }, context: {} });
    expect(prepared, JSON.stringify(prepared)).toHaveProperty('input');
    if (!('input' in prepared) || !candidate) throw new Error('Expected admitted fleet review');
    const selected = link.members.filter(member => !machines || machines.includes(member.machineId));
    expect(candidate.teardown?.machines).toEqual(selected.map(({ machineId, installationId }) => ({ machineId, installationId })));
    expect(candidate.teardown?.resources).toEqual(selected.map(({ machineId }) => ({ id: environment.environment.id,
        kind: 'workload', machineId, ownership: 'owned', disposition: 'remove' })));
    const duplicate = structuredClone(candidate);
    duplicate.teardown!.resources.push({ ...duplicate.teardown!.resources[0] });
    expect(DeploymentOwnServerContentV1Schema.safeParse(duplicate).success).toBe(false);
    expect(await teardown.admit(environment, link.id, candidate, prepared.input, {})).toBeNull();
    const missingMember = structuredClone(candidate);
    missingMember.teardown!.resources.pop();
    expect(await teardown.admit(environment, link.id, missingMember, prepared.input, {})).toMatchObject({ ok: false });
});
