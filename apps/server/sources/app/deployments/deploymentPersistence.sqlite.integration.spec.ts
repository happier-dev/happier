import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readDeploymentTargetsInTx } from './deploymentTargetLinkService';

const plainMachineContent = {
    metadata: encodePlainMachineStoredContent({ host: 'Persistence', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/deployment', happyHomeDir: '/home/deployment/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
};

describe('deployment storage real SQLite boundary', () => {
    const serverId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-storage-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('discloses exact Machine deployment custody without loading inventories or private bodies', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Private reference Source', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'private/references', cloneUrl: 'https://github.com/private/references.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const [machine, peer] = await Promise.all(['reference', 'peer'].map(async label => db.machine.create({ data: {
            id: `${label}-${crypto.randomUUID()}`, accountId: owner.id, ...plainMachineContent, installationId: crypto.randomUUID(),
        } })));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Private Environment' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ sentinel: 'never-open-reference-body' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, buildMachineId: machine.id, edgeMachineId: machine.id, ...content,
        } });
        const targetArtifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Private target' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!targetArtifact.ok) throw new Error(targetArtifact.error);
        const target = await db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', createdByAccountId: owner.id,
            contentArtifactId: targetArtifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            machines: { create: [peer, machine].map((member, position) => ({ machineId: member.id,
                installationId: member.installationId!, position, state: 'joining' })) },
        } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: target.id } });
        const domainId = crypto.randomUUID();
        await db.deploymentDomain.create({ data: { id: domainId, environmentId: environment.id,
            targetLinkId: target.id, state: 'active', createdByAccountId: owner.id, ...content,
            capturedPlacements: [machine, peer].map(member => ({ placement: { serverId, accountId: owner.id,
                environmentId: environment.id, targetLinkId: target.id, domainId, machineId: member.id,
                installationId: member.installationId!, nativeServer: 'private', actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() },
                content, desired: true, listener: 'privateOrigin', installationPublicKey: privacyKit.encodeBase64(new Uint8Array(32)) })),
        } });
        expect(await inTx(tx => readDeploymentTargetsInTx(tx, environment.id))).toMatchObject([{
            machines: [peer.id, machine.id], members: [{ machineId: peer.id, state: 'joining' }, { machineId: machine.id, state: 'joining' }],
        }]);
        await db.deploymentEnvironment.createMany({ data: Array.from({ length: 1_000 }, () => ({
            id: crypto.randomUUID(), projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: peer.id, ...content,
        })) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/machine-references?homeId=${serverId}&machineId=${machine.id}`;
            const queries: { model: string | undefined; action: string; args: unknown }[] = [];
            const stop = observeSqliteRequests({ before: request => { queries.push({ model: request.model, action: request.action, args: request.args }); } });
            try {
                const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ homeId: serverId, machineId: machine.id, coverage: 'complete',
                    references: [{ kind: 'deployment_environment', id: environment.id, deploymentRoles: ['runtime', 'controller', 'build', 'edge'],
                        deploymentDomains: [{ environmentId: environment.id, targetLinkId: target.id, domainId,
                            machineId: machine.id, installationId: machine.installationId }] }], nextCursor: null });
                expect(response.body).not.toContain(peer.installationId);
                expect(response.body).not.toContain('never-open-reference-body');
                expect(response.body).not.toContain('Private');
                const environmentQueries = queries.filter(query => query.model === 'DeploymentEnvironment');
                expect(environmentQueries).toHaveLength(1);
                expect(environmentQueries[0]).toMatchObject({ action: 'findMany' });
                expect(queries.filter(query => query.model === 'Artifact')).toEqual([]);
            } finally { stop(); }
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': outsider.id } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(serverId, `srv_${'b'.repeat(32)}`), headers: { 'x-test-user-id': owner.id } })).statusCode).toBe(404);
            await db.deploymentTargetLink.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
            const retained = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(retained.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['retiring', 'controller', 'build', 'edge'] }] });
            await db.deploymentTargetLink.update({ where: { id: target.id }, data: { detachedAt: new Date() } });
            const detached = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(detached.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['detached', 'controller', 'build', 'edge'] }] });
            await db.deploymentTargetLinkMachine.delete({ where: { targetLinkId_machineId: { targetLinkId: target.id, machineId: machine.id } } });
            const separateRoles = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(separateRoles.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['controller', 'build', 'edge'] }] });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: peer.id, buildMachineId: peer.id } });
            const edgeOnly = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(edgeOnly.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['edge'] }] });
            const sourceList = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments?serverId=${serverId}&projectSourceId=${source.source.id}&machineId=${machine.id}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(sourceList.statusCode, sourceList.body).toBe(200);
            expect(sourceList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            const machineListUrl = `/v1/deployments/environments?serverId=${serverId}&machineId=${machine.id}`;
            const machineListQueries: { model: string | undefined; action: string; args: unknown }[] = [];
            const stopMachineListQueries = observeSqliteRequests({ before: request => {
                machineListQueries.push({ model: request.model, action: request.action, args: request.args });
            } });
            const machineList = await (async () => {
                try { return await app.inject({ method: 'GET', url: machineListUrl, headers: { 'x-test-user-id': owner.id } }); }
                finally { stopMachineListQueries(); }
            })();
            expect(machineList.statusCode, machineList.body).toBe(200);
            expect(machineList.json()).toMatchObject({ coverage: 'complete', nextCursor: null });
            expect(machineList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            expect(machineListQueries.filter(query => query.model === 'DeploymentEnvironment')).toMatchObject([
                { action: 'findMany' },
            ]);
            expect(machineListQueries.filter(query => query.model === 'Artifact')).toEqual([]);
            expect(machineListQueries.filter(query => query.model === 'ProjectSource' && query.action === 'findUnique')).toHaveLength(1);
            expect((await app.inject({ method: 'GET', url: machineListUrl,
                headers: { 'x-test-user-id': outsider.id } })).statusCode).toBe(404);
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: machine.id, buildMachineId: machine.id } });
            await db.deploymentTargetLinkMachine.create({ data: { targetLinkId: target.id, machineId: machine.id,
                installationId: machine.installationId!, position: 1, state: 'active' } });
            const hidden = await inTx(tx => createProjectSourceInTx(tx, outsider.id, {
                serverId, requestKey: crypto.randomUUID(), name: 'Hidden source', audience: [], repository: source.source.repository,
            }));
            if (!hidden.ok) throw new Error(hidden.error);
            const hiddenEnvironment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: hidden.source.id, createdByAccountId: outsider.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machine.id, ...content,
            } });
            const partial = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(partial.json()).toMatchObject({ coverage: 'partial', references: [{ id: environment.id }] });
            expect(partial.body).not.toContain(hiddenEnvironment.id);
            expect(partial.body).not.toContain('Hidden');
            const partialMachineList = await app.inject({ method: 'GET', url: machineListUrl,
                headers: { 'x-test-user-id': owner.id } });
            expect(partialMachineList.statusCode, partialMachineList.body).toBe(200);
            expect(partialMachineList.json()).toMatchObject({ coverage: 'partial' });
            expect(partialMachineList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            expect(partialMachineList.body).not.toContain(hiddenEnvironment.id);
            expect(partialMachineList.body).not.toContain(hidden.source.id);
            const sibling = await db.deploymentEnvironment.create({ data: {
                projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machine.id, ...content,
            } });
            let sourceReads = 0;
            const stopSources = observeSqliteRequests({ before: request => {
                if (request.model === 'ProjectSource' && request.action === 'findUnique') sourceReads += 1;
            } });
            try {
                const grouped = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
                expect(grouped.json().references.map((reference: { id: string }) => reference.id).sort()).toEqual([environment.id, sibling.id].sort());
                expect(sourceReads, 'one current admission per matching Source, independent of its Environment count').toBe(2);
            } finally { stopSources(); }
        });
        const members = await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId: target.id }, orderBy: { position: 'asc' } });
        expect(members.map(member => member.machineId)).toEqual([peer.id, machine.id]);
        await expect(db.deploymentTargetLinkMachine.create({ data: { targetLinkId: target.id, machineId: crypto.randomUUID(),
            installationId: 'foreign', position: 2, state: 'joining' } })).rejects.toThrow();
        await expect(db.deploymentTargetLinkMachine.update({ where: { targetLinkId_machineId: { targetLinkId: target.id, machineId: machine.id } },
            data: { position: 0 } })).rejects.toThrow();
        await expect(db.machine.delete({ where: { id: machine.id } })).rejects.toThrow();
    });

});
