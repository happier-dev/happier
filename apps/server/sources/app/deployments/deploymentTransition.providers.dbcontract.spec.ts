import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    computeDeploymentTransitionRequestDigestV1, readDeploymentAccountChangeV1, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { withAccountPublicationBeforeTransactionSql } from '@/app/changes/accountPublicationContention.testkit';
import { initEncrypt } from '@/modules/encrypt';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCaller } from '@/app/artifacts/artifactAccessService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { transitionDeploymentInTx } from './deploymentService';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('deployment transition publication on native providers', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousSecret = process.env.HANDY_MASTER_SECRET;
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    let connected = false;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || process.env.DATABASE_URL !== target) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-transition-native-test-only';
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        for (const [key, value] of Object.entries({ HAPPIER_SERVER_IDENTITY_ID: previousIdentity,
            HANDY_MASTER_SECRET: previousSecret, HAPPIER_DB_TX_MAX_RETRIES: previousRetries })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    it('admits teardown once despite unrelated Account publication and retains Environment exclusion', async () => {
        if (provider !== 'postgres') return;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Teardown publication', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Teardown receipt' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: [] }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content,
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        const input = { serverId, environmentId: environment.id, targetLinkId: link.id, expectedRevision: 1,
            expectedTargetLinkRevision: 1, requestKey: randomUUID(), actionOperationId: randomUUID(), reason: 'manual', ...content };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const request = (payload = input) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/teardown`,
                headers: { 'x-test-user-id': owner.id }, payload });
            const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, state: 'queued', revision: 2 });
            expect(advances).toBe(1);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await request()).json()).toEqual(response.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            const competing = await request({ ...input, requestKey: randomUUID(), actionOperationId: randomUUID() });
            expect(competing.statusCode, competing.body).toBe(409);
            expect(competing.json()).toMatchObject({ ok: false, error: 'deployment_in_progress' });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(1);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(2);
            await db.deployment.update({ where: { id: response.json().deploymentId }, data: { state: 'failed' } });
            const next = () => request({ ...input, expectedRevision: 2, requestKey: randomUUID(), actionOperationId: randomUUID() });
            const concurrent = await Promise.all([next(), next()]);
            expect(concurrent.map(answer => answer.statusCode).sort()).toEqual([200, 409]);
            expect(concurrent.find(answer => answer.statusCode === 409)!.json()).toMatchObject({ error: 'deployment_in_progress' });
            expect(await db.deployment.count({ where: { environmentId: environment.id } })).toBe(2);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).revision).toBe(3);
        });
    });

    it('settles private receipt content and activation atomically despite unrelated Account publication, and replays the exact signed settle', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId, requestKey: randomUUID(),
            name: 'Shared deployment Source', audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}',
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Private receipt' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: [] }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...content } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'queued', requestKey: randomUUID(), actionOperationId: randomUUID(),
            requestedByAccountId: owner.id, acceptedControllerMachineId: machine.id,
            acceptedControllerInstallationId: machine.installationId, ...content } });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
            deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: 1,
            machineId: machine.id, installationId: machine.installationId!, kind: 'stage', state: 'running',
            contentUpdate: { body: encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: ['started'] }) }), expectedBodyVersion: 1 } };
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
            installationId: machine.installationId!, accountId: owner.id, deploymentTransition: { serverId,
                environmentId: environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                expectedRevision: 1, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
        const result = await inTx(tx => transitionDeploymentInTx(tx, owner.id, { ...body, proof }), { isolationLevel: 'Serializable' });
        expect(result).toMatchObject({ ok: true, deploymentId: receipt.id, deploymentRevision: 2, state: 'running' });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({ state: 'running', contentBodyVersion: 2 });
        const readerChanges = await db.accountChange.findMany({ where: { accountId: reader.id, kind: 'account' } });
        expect(readerChanges.map(readDeploymentAccountChangeV1)).toContainEqual(expect.objectContaining({
            environmentId: environment.id, deploymentId: receipt.id,
        }));
        expect(await readArtifactForCaller({ actorAccountId: reader.id, artifactId: artifact.artifact.id })).toMatchObject({ ok: false });

        if (provider !== 'postgres') return;
        const settleBody: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
            deploymentId: receipt.id, actionOperationId: receipt.actionOperationId, expectedRevision: 2,
            machineId: machine.id, installationId: machine.installationId!, kind: 'settle', state: 'succeeded',
            expectedTargetLinkRevision: 1,
            contentArtifactId: content.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 2,
            contentUpdate: { body: encodePlainArtifactStoredContent({ body: JSON.stringify({ steps: ['started', 'activated'] }) }),
                expectedBodyVersion: 2 } };
        const signTransition = (input: Omit<DeploymentTransitionInputV1, 'proof'>): DeploymentTransitionInputV1 => ({
            ...input, proof: signMachineInstallationProof({ payload: { version: 1,
                machineId: machine.id, installationId: machine.installationId!, accountId: owner.id,
                deploymentTransition: { serverId, environmentId: environment.id, deploymentId: receipt.id,
                    actionOperationId: input.actionOperationId, expectedRevision: input.expectedRevision,
                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(input) } }, privateKey: keys.secretKey }) });
        const settle = signTransition(settleBody);
        const atPublication = (sql: string) => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE');
        const beforeReceipt = await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } });
        const beforeArtifact = await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } });
        const beforeLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
        // Real peer commits at Prisma's SQL boundary; no domain logic is replaced.
        await expect(withAccountPublicationBeforeTransactionSql(owner.id, atPublication,
            () => inTx(tx => transitionDeploymentInTx(tx, owner.id, settle), { isolationLevel: 'Serializable' })))
            .rejects.toMatchObject({ code: 'database_transaction_conflict_exhausted' });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(beforeReceipt);
        expect(await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } })).toEqual(beforeArtifact);
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(beforeLink);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const request = () => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id }, payload: settle });
            const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id, atPublication, request);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: 3 });
            expect(advances).toBe(1);
            const publishedSeq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const repeated = await request();
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json()).toEqual(response.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publishedSeq);
            const failedBody = { ...settleBody, state: 'failed' as const };
            delete failedBody.expectedTargetLinkRevision;
            const differentState = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id }, payload: signTransition(failedBody) });
            expect(differentState.statusCode, differentState.body).toBe(409);
            expect(differentState.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const differentOperation = await app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}/transitions`,
                headers: { 'x-test-user-id': owner.id },
                payload: signTransition({ ...settleBody, actionOperationId: randomUUID() }) });
            expect(differentOperation.statusCode, differentOperation.body).toBe(404);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publishedSeq);
        });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } }))
            .toMatchObject({ state: 'succeeded', revision: 3, contentBodyVersion: 3 });
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } }))
            .toMatchObject({ activeDeploymentId: receipt.id, revision: 2, state: 'deployed' });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: content.contentArtifactId } })).bodyVersion).toBe(3);
    });
});
