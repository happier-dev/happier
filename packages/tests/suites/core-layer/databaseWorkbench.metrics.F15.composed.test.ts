import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentTelemetryAssignmentsV1Schema } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { MachineRolesGetResultV1Schema, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { signPluginInstallationPublisherHeader } from '../../../../apps/cli/src/plugins/installations/publisherProof';
import { startDatabaseWorkbenchFixture } from '../../src/testkit/databaseWorkbench';
import { runFreshDeploymentSourceSmoke } from '../../src/scenarios/deployments.scenario';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { settleReviewedSessionMcpAction, startSessionMcpAgent } from '../../src/testkit/sessionMcpAgent';

const run = createRunDirs({ runLabel: 'core' });

it('F15 chooses Metrics independently on a fresh Environment through Action, Postgres Home and collector daemon', async () => {
    const testDir = run.testDir('dbw-metrics-f15');
    const fixture = await startDatabaseWorkbenchFixture({ testDir });
    let agent: Awaited<ReturnType<typeof startSessionMcpAgent>> | undefined;
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
        const selected = await account.executeReviewed(DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, {
            serverId: fixture.serverId, environmentId: environment.environmentId, expectedRevision: target.revision,
            collector: { machineId: collector.target.machineId }, capabilities: { metrics: true, appLlmCost: false, exceptions: false },
        }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
            presentUserConfirmation: { actionId: 'deployments.environments.telemetry.set' } });
        expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { ok: true, state: 'redeploy_required' } });
        if (!selected.ok) throw new Error(`F15 Telemetry setup refused (${selected.errorCode})`);
        const configured = DeploymentActionOutputSchemasV1[DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1].parse(selected.result);
        if (!configured.ok) throw new Error(`F15 Telemetry setup unavailable (${configured.error})`);

        const session = agent = await startSessionMcpAgent({ testDir, directory: machine.workspaceDir,
            daemonState: machine.daemon.state, executeAsPerson: account.executeAsPerson });
        const change = { serverId: fixture.serverId, environmentId: environment.environmentId,
            expectedRevision: configured.revision, collector: { machineId: collector.target.machineId },
            capabilities: { metrics: true, appLlmCost: false, exceptions: true } };
        const executeSetup = async (input: typeof change) => settleReviewedSessionMcpAction(
            await session.execute(DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, input), {
                serverId: fixture.serverId, serverHttpBaseUrl: fixture.actionServerApiUrl, token: account.credentials.token,
                execute: account.execute,
                decide: artifactId => account.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }),
            });
        const updated = await executeSetup(change);
        if (!updated.ok) throw new Error(`F15 Session Telemetry setup refused (${updated.errorCode})`);
        const setup = DeploymentActionOutputSchemasV1[DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1].parse(updated.result);
        expect(setup).toMatchObject({ ok: true, environmentId: environment.environmentId, state: 'redeploy_required' });
        if (!setup.ok) throw new Error(`F15 Session Telemetry setup unavailable (${setup.error})`);
        expect(setup.revision).toBeGreaterThan(configured.revision);
        expect(await executeSetup({ ...change, environmentId: randomUUID() }))
            .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
        const current = await account.execute('deployments.environments.get', { serverId: fixture.serverId, environmentId: environment.environmentId });
        if (!current.ok) throw new Error(`F15 selected Environment read refused (${current.errorCode})`);
        expect(current.result).toMatchObject({ ok: true, environment: { id: environment.environmentId,
            revision: setup.revision, telemetryMachineId: collector.target.machineId } });
        const collectorIdentity = MachineInstallationIdentityV1Schema.parse(JSON.parse(
            await readFile(join(collector.homeDir, 'installation-identity.json'), 'utf8')));
        const path = `/v1/deployments/machines/${encodeURIComponent(collector.target.machineId)}/telemetry-assignments`;
        const proof = signPluginInstallationPublisherHeader({ identity: collectorIdentity, machineId: collector.target.machineId, path, body: {} });
        const assignments = await fetchJson<unknown>(`${fixture.server.baseUrl}${path}`, { method: 'POST',
            headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json',
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: proof }, body: '{}' });
        expect(assignments.status).toBe(200);
        expect(DeploymentTelemetryAssignmentsV1Schema.parse(assignments.data).assignments).toEqual([
            expect.objectContaining({ environmentId: environment.environmentId, capabilities: change.capabilities }),
        ]);
        console.info('F15 selected Environment Telemetry changed through the MCP Session and refused another scope');
    } finally {
        try { await agent?.stop(); } finally { await fixture.stop(); }
    }
}, 0);
