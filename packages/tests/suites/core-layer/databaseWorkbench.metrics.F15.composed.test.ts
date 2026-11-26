import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { MachineRolesGetResultV1Schema, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { runFreshDeploymentSourceSmoke } from '../../src/scenarios/deployments.scenario';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

it('F15 chooses Metrics independently on a fresh Environment through Action, Postgres Home and collector daemon', async () => {
    const fixture = await startDatabaseWorkbenchFixture({ testDir: run.testDir('dbw-metrics-f15') });
    try {
        const { account, machine, sourceId } = await runFreshDeploymentSourceSmoke(fixture);
        // G1 runs first: the fresh Account created/read its Source and reached
        // the enrolled daemon through the ordinary Machine Action transport.
        console.info('F15-G1-known-good', { serverId: fixture.serverId, machineId: machine.target.machineId });
        const collector = await fixture.enrollDaemon(account);
        await fixture.assertKnownGoodMachineControl(account, collector);
        expect(collector.target.machineId).not.toBe(machine.target.machineId);
        const roles = await account.execute('machines.roles.get', { serverId: fixture.serverId, machineId: collector.target.machineId });
        if (!roles.ok) throw new Error(`F15 collector roles refused (${roles.errorCode})`);
        const policy = MachineRolesGetResultV1Schema.parse(roles.result);
        if (policy.status !== 'ready') throw new Error(`F15 collector roles unavailable (${policy.status})`);
        expect(await account.executeReviewed('machines.roles.set', { serverId: fixture.serverId, machineId: collector.target.machineId,
            expectedPolicy: policy.policy, expectedMetadataVersion: policy.metadataVersion,
            policy: { active: [...policy.policy.active, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1] },
        }, { presentUserConfirmation: { actionId: 'machines.roles.set' } })).toMatchObject({ ok: true });
        const created = await account.executeReviewed('deployments.environments.create', {
            serverId: fixture.serverId, projectSourceId: sourceId, requestKey: randomUUID(),
            name: 'F15 metrics app', retainPreviousDeployments: 1,
            definition: { from: 'compose', document: JSON.stringify({ services: { app: { image: 'node:22' } } }), profiles: [], services: ['app'] },
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.target.machineId, buildMachineId: machine.target.machineId,
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.environments.create' } });
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) throw new Error(`F15 Environment create refused (${created.errorCode})`);
        const environment = DeploymentActionOutputSchemasV1['deployments.environments.create'].parse(created.result);
        if (!environment.ok) throw new Error(`F15 Environment unavailable (${environment.error})`);
        const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
        const linked = await account.executeReviewed('deployments.targets.link', {
            serverId: fixture.serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
            requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
            machines: [{ machineId: machine.target.machineId, installationId: identity.installationId }],
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.targets.link' } });
        if (!linked.ok) throw new Error(`F15 runtime link refused (${linked.errorCode})`);
        const target = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(linked.result);
        if (!target.ok) throw new Error(`F15 runtime link unavailable (${target.error})`);
        const selected = await account.executeReviewed('deployments.environments.telemetry.set', {
            serverId: fixture.serverId, environmentId: environment.environmentId, expectedRevision: target.revision,
            collector: { machineId: collector.target.machineId }, capabilities: { metrics: true, appLlmCost: false, exceptions: false },
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.environments.telemetry.set' } });
        expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { ok: true, state: 'redeploy_required' } });
    } finally { await fixture.stop(); }
});
