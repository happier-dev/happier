import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createDeploymentEnvironmentV1, createDeploymentTargetLinkV1, createDeploymentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { auth } from '@/app/auth/auth';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';

const publishedMachine = { metadata: encodePlainMachineStoredContent({ host: 'Controller', platform: 'linux',
    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };

describe('storage-only Environment controller assignment', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-controller-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('diagnoses a personally owned Machine missing Team placement access without retaining a new Project', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'New Environment owner' } });
        await db.teamMembership.create({ data: { accountId: owner.id, teamId: team.id, role: 'owner' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...publishedMachine, installationId: crypto.randomUUID(), active: false } });
        const environmentContent = createDeploymentEnvironmentV1().content;
        if (environmentContent.t !== 'plain') throw new Error('Expected plain deployment fixture');
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team placement' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(environmentContent.v) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: artifact.artifact.id,
            principal: { kind: 'team', teamId: team.id }, accessLevel: 'admin' }))).toMatchObject({ ok: true });
        const input = { serverId, requestKey: crypto.randomUUID(),
            newProject: { requestKey: crypto.randomUUID(), name: 'New Team workload', owner: { kind: 'team', teamId: team.id } },
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'members', controllerMachineId: machine.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = () => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { authorization: `Bearer ${token}` }, payload: input });
            const refused = await send();
            expect(refused.statusCode, refused.body).toBe(503);
            expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            expect(await db.deploymentEnvironment.count({ where: { createdByAccountId: owner.id } })).toBe(0);
            expect(refused.json()).toEqual({ ok: false, error: 'machine_unavailable', role: 'controller',
                machineIds: [machine.id], nextActions: ['start', 'chooseAnother'], effectAttempted: false,
                diagnostic: { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use',
                    remedy: 'share_machine_with_source_owner' } });
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id,
                machineId: machine.id, principal: { kind: 'team', teamId: team.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
            const created = await send();
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json()).toMatchObject({ ok: true });
            expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(1);
            expect(await db.deploymentEnvironment.findFirstOrThrow({ where: { createdByAccountId: owner.id } }))
                .toMatchObject({ controllerMachineId: machine.id, deployerMode: 'members' });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false);
        }, { authentication: 'real' });
    });

    it('changes future placement while offline, preserves existing receipt records and writes nothing for equal input', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Controller placement',
            audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
        }));
        if (!source.ok) throw new Error(source.error);
        const [first, next, foreign] = await Promise.all([owner.id, owner.id, outsider.id].map(accountId => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, ...publishedMachine, installationId: crypto.randomUUID(), active: false,
        } })));
        const artifactReference = async (kind: string, content: ReturnType<typeof createDeploymentEnvironmentV1>['content']
            | ReturnType<typeof createDeploymentTargetLinkV1>['content'] | ReturnType<typeof createDeploymentV1>['content']) => {
            if (content.t !== 'plain') throw new Error('Expected plain deployment fixture');
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Controller' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content.v) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const content = await artifactReference('deployment-environment.v1', createDeploymentEnvironmentV1().content);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...content, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: first.id, buildMachineId: first.id,
        }));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        // Persisted receipt is the fixture boundary; continued old-host settlement has a separate Action custody prerequisite.
        const link = await db.deploymentTargetLink.create({ data: {
            ...await artifactReference('deployment-target-link.v1', createDeploymentTargetLinkV1().content),
            environmentId, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed',
            machines: { create: { machineId: first.id, installationId: first.installationId!, position: 0, state: 'active' } } } });
        const receipt = await db.deployment.create({ data: {
            ...await artifactReference('deployment-receipt.v1', createDeploymentV1().content), environmentId, targetLinkId: link.id,
            requestedByAccountId: owner.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            operation: 'deploy', state: 'running' } });
        const beforeContent = await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } });
        const beforeEnvironment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
        const beforeSequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environmentId}/controller`;
            const input = { serverId, environmentId, expectedRevision: created.revision, controllerMachineId: next.id };
            const headers = { 'x-test-user-id': owner.id };
            const accepted = await app.inject({ method: 'POST', url, headers, payload: input });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ ok: true, environmentId, revision: 2 });
            const after = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            expect(after).toEqual({ ...beforeEnvironment, controllerMachineId: next.id, revision: 2, updatedAt: after.updatedAt });
            expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(receipt);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(link);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } })).toEqual(beforeContent);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect(sequence).toBeGreaterThan(beforeSequence);
            const read = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${environmentId}?serverId=${serverId}`, headers });
            expect(read.json()).toMatchObject({ ok: true, environment: { controllerMachineId: next.id, revision: 2 } });
            let writes = 0;
            const stop = observeSqliteRequests({ before: request => {
                if (['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(request.action)) writes++;
            } });
            try {
                const equal = await app.inject({ method: 'POST', url, headers, payload: { ...input, expectedRevision: 2 } });
                expect(equal.json()).toEqual(accepted.json());
                expect(writes, 'equal controller input must not write or publish').toBe(0);
            } finally { stop(); }
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(409);
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': reader.id },
                payload: { ...input, expectedRevision: 2 } })).statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': outsider.id },
                payload: { ...input, expectedRevision: 2 } })).statusCode).toBe(404);
            const unavailable = await app.inject({ method: 'POST', url, headers,
                payload: { ...input, expectedRevision: 2, controllerMachineId: foreign.id } });
            expect(unavailable.statusCode).toBe(503);
            expect(unavailable.json()).toEqual({ ok: false, error: 'machine_unavailable', role: 'controller',
                machineIds: [foreign.id], nextActions: ['start', 'chooseAnother'], effectAttempted: false,
                diagnostic: { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use',
                    remedy: 'share_machine_with_source_owner' } });
            expect((await app.inject({ method: 'POST', url, headers,
                payload: { ...input, environmentId: crypto.randomUUID() } })).statusCode).toBe(400);
            expect((await app.inject({ method: 'POST', url, headers,
                payload: { ...input, expectedRevision: 2, serverId: `srv_${'e'.repeat(32)}` } })).statusCode).toBe(404);
        });
    });

    it('requires the current Source Team grant rather than the manager personal Machine ownership', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Controller owner' } });
        await db.teamMembership.create({ data: { accountId: owner.id, teamId: team.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Team controller', audience: [], owner: { kind: 'team', teamId: team.id },
        }));
        if (!source.ok) throw new Error(source.error);
        const [first, next] = await Promise.all([0, 1].map(() => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, ...publishedMachine, installationId: crypto.randomUUID(), active: false,
        } })));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'production', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: first.id, contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: first.id } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environment.id}/controller`;
            const headers = { 'x-test-user-id': owner.id };
            const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision, controllerMachineId: next.id };
            const unavailable = await app.inject({ method: 'POST', url, headers, payload: input });
            expect(unavailable.statusCode).toBe(503);
            expect(unavailable.json()).toMatchObject({ ok: false, error: 'machine_unavailable', effectAttempted: false,
                diagnostic: { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use',
                    remedy: 'share_machine_with_source_owner' } });
            await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: next.id } });
            expect((await app.inject({ method: 'POST', url, headers, payload: input })).json())
                .toEqual({ ok: true, environmentId: environment.id, revision: 2 });
            await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId: next.id, teamId: team.id } });
            const retainedPlacement = await app.inject({ method: 'POST', url, headers, payload: { ...input, expectedRevision: 2 } });
            expect(retainedPlacement.statusCode).toBe(503);
            expect(retainedPlacement.json()).toMatchObject({ ok: false, error: 'machine_unavailable',
                diagnostic: { reason: 'source_machine_access_missing', requiredFact: 'source_machine_use',
                    remedy: 'share_machine_with_source_owner' } });
            expect(retainedPlacement.json()).not.toHaveProperty('effectAttempted');
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: owner.id } });
            expect((await app.inject({ method: 'POST', url, headers, payload: { ...input, expectedRevision: 2 } })).statusCode).toBe(404);
        });
    });
});
