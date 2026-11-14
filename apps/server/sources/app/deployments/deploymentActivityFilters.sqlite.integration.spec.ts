import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';

describe('Activity receipt selection at the authenticated history route', () => {
    const serverId = `srv_${'f'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'activity-filters-', initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId } }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('filters requester and a half-open requested-time window in storage before pagination', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Activity', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Activity' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'unopened by history metadata read' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...content } });
        const target = await db.deploymentTargetLink.create({ data: { environmentId: environment.id, role: 'runtime',
            sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...content } });
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await db.deployment.createMany({ data: ids.map((id, index) => ({ id, environmentId: environment.id,
            targetLinkId: target.id, operation: 'deploy', state: 'succeeded', requestKey: randomUUID(),
            actionOperationId: randomUUID(), requestedByAccountId: index === 2 ? other.id : owner.id,
            requestedAt: new Date([999, 1000, 1500, 1999, 2000][index]!), ...content })) });
        const app = createAuthenticatedTestApp();
        registerDeploymentRoutes(app);
        const queries: unknown[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === 'Deployment' && request.action === 'findMany') queries.push(request.args);
        } });
        try {
            const query = new URLSearchParams({ serverId, actorAccountId: owner.id,
                requestedAtFromMs: '1000', requestedAtToMs: '2000', limit: '1' });
            const read = () => app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${environment.id}/deployments?${query}`,
                headers: { 'x-test-user-id': owner.id } });
            const first = await read();
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({ items: [{ id: ids[3] }], nextCursor: ids[3] });
            query.set('cursor', first.json().nextCursor);
            const next = await read();
            expect(next.statusCode, next.body).toBe(200);
            expect(next.json()).toMatchObject({ items: [{ id: ids[1] }], nextCursor: null });
            expect(queries).toHaveLength(2);
            for (const args of queries) expect(args).toMatchObject({ where: { environmentId: environment.id,
                requestedByAccountId: owner.id, requestedAt: { gte: new Date(1000), lt: new Date(2000) } }, take: 2 });
        } finally { stop(); await app.close(); }
    });
});
