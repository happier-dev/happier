import { afterAll, beforeAll, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { withAccountPublicationBeforeTransactionSql } from '@/app/changes/accountPublicationContention.testkit';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';

const serverId = `srv_${'f'.repeat(32)}`;

beforeAll(async () => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Run with the disposable PostgreSQL DB-contract harness');
    }
    process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
    process.env.HANDY_MASTER_SECRET ??= 'disposition-disposable-contract';
    await initDbPostgres();
    await db.$connect();
    await initEncrypt();
});
afterAll(async () => { await db.$disconnect(); });

async function fixture() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
        serverId, requestKey: crypto.randomUUID(), name: 'Disposition contention', audience: [],
    }));
    if (!source.ok) throw new Error(source.error);
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        installationId: crypto.randomUUID(),
        metadata: encodePlainMachineStoredContent({ host: 'Disposition', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
    const content = async (kind: string) => {
        const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Disposition' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!created.ok) throw new Error(created.error);
        return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    };
    const environment = await db.deploymentEnvironment.create({ data: {
        projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
        ...await content('deployment-environment.v1'),
    } });
    const link = await db.deploymentTargetLink.create({ data: {
        environmentId: environment.id, createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host',
        hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
        ...await content('deployment-target-link.v1'),
        machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'joining' }] },
    } });
    await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
    const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
        requestKey: crypto.randomUUID() };
    return { owner, environment, link, input };
}

it.each(['delete', 'unlink', 'detach'] as const)('%s survives a concurrent Account publication without replaying admission', async action => {
    const f = await fixture();
    const app = createAuthenticatedTestApp();
    registerDeploymentRoutes(app);
    await app.ready();
    try {
        const url = `/v1/deployments/environments/${f.environment.id}/${action === 'delete' ? 'delete'
            : action === 'unlink' ? `targets/${f.link.id}/unlink` : 'teardown'}`;
        const payload = action === 'delete' ? f.input : { ...f.input, targetLinkId: f.link.id,
            expectedTargetLinkRevision: f.link.revision, ...(action === 'detach' ? { detachKeepRunning: true, reason: 'manual' } : {}) };
        const request = (): Promise<LightMyRequestResponse> => app.inject({ method: 'POST', url, headers: { 'x-test-user-id': f.owner.id }, payload });
        // Publish on the same Account after the Environment snapshot/domain writes,
        // immediately before the real terminal Account lock. No internal owner is mocked.
        const { result, advances } = await withAccountPublicationBeforeTransactionSql(f.owner.id,
            sql => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE'), request);
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json()).toMatchObject({ ok: true, revision: 2, detached: action === 'detach' });
        expect(advances).toBe(1);
        const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
        expect(environment.deletedAt).toEqual(action === 'delete' ? expect.any(Date) : null);
        expect(environment.runtimeTargetLinkId).toBeNull();
        expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } })).deletedAt).toEqual(expect.any(Date));
        const cursor = (await db.account.findUniqueOrThrow({ where: { id: f.owner.id } })).seq;
        const replay = await request();
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(result.json());
        expect((await db.account.findUniqueOrThrow({ where: { id: f.owner.id } })).seq).toBe(cursor);
    } finally { await app.close(); }
});

it('serializes competing deletes at the Environment lock and preserves the revision refusal', async () => {
    const f = await fixture();
    const app = createAuthenticatedTestApp();
    registerDeploymentRoutes(app);
    await app.ready();
    try {
        const responses = await Promise.all([f.input, { ...f.input, requestKey: crypto.randomUUID() }].map(payload =>
            app.inject({ method: 'POST', url: `/v1/deployments/environments/${f.environment.id}/delete`,
                headers: { 'x-test-user-id': f.owner.id }, payload })));
        expect(responses.map(response => response.statusCode).sort()).toEqual([200, 404]);
        expect(responses.find(response => response.statusCode === 404)?.json()).toMatchObject({ error: 'deployment_unavailable' });
        expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).revision).toBe(2);
    } finally { await app.close(); }
});


it('persists the selected restore backup with rollback lineage through receipt readback', async () => {
    const f = await fixture();
    await db.deploymentEnvironment.update({ where: { id: f.environment.id },
        data: { buildMachineId: f.environment.controllerMachineId } });
    const artifact = await createArtifact({ actorUserId: f.owner.id, artifactId: crypto.randomUUID(),
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Restore' })),
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ snapshot: 'retained-release' })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!artifact.ok) throw new Error(artifact.error);
    const reference = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    const retained = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
        operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.owner.id,
        actionOperationId: crypto.randomUUID(), ...reference } });
    await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: retained.id } });
    const app = createAuthenticatedTestApp();
    registerDeploymentRoutes(app);
    await app.ready();
    try {
        const payload = { ...f.input, ...reference, targetLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
            deploymentId: retained.id, actionOperationId: crypto.randomUUID(), restoreBackupId: 'retained-backup' };
        const url = `/v1/deployments/environments/${f.environment.id}/rollback`;
        const response = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': f.owner.id }, payload });
        expect(response.statusCode, response.body).toBe(200);
        const result = response.json<{ deploymentId: string }>();
        expect(await db.deployment.findUniqueOrThrow({ where: { id: result.deploymentId } }))
            .toMatchObject({ restoreBackupId: payload.restoreBackupId, predecessorDeploymentId: retained.id,
                rollbackOfDeploymentId: retained.id });
        const read = await app.inject({ method: 'GET',
            url: `/v1/deployments/receipts/${result.deploymentId}?serverId=${serverId}`,
            headers: { 'x-test-user-id': f.owner.id } });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({ ok: true, deployment: { restoreBackupId: payload.restoreBackupId } });
        const conflict = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': f.owner.id },
            payload: { ...payload, restoreBackupId: 'different-backup' } });
        expect(conflict.statusCode, conflict.body).toBe(409);
    } finally { await app.close(); }
});
