import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, prismaRuntime } from '@/storage/prisma';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { projectSourceListFiltersSql } from '@/app/projects/sources/projectSourceQuery';
import { lockPostgresRepeatKeyInTx } from '@/storage/queue/repeatKey';
import { inTx } from '@/storage/inTx';
import { listDeploymentEnvironmentsInTx } from './deploymentReadService';
import { deploymentWriteIsolationLevel, lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { readDeploymentDomainEnvironmentIdsForMachineInTx, readMemberDeploymentDomainContentInTx } from './deploymentDomainService';

// The native PostgreSQL adapter executes both backend profiles against a disposable database.
describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Deployment PostgreSQL-compatible backend dialect', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let owner: { id: string };
    let sourceId: string;
    let environmentId: string;
    const serverId = `srv_${'d'.repeat(32)}`;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'deployment-dialect-', initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
        owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const createdSource = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Dialect Source', audience: [] }));
        if (!createdSource.ok) throw new Error(createdSource.error);
        sourceId = createdSource.source.id;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: sourceId,
            createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction',
            purpose: 'standard', deployerMode: 'managers', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        environmentId = environment.id;
    });
    afterAll(async () => { await harness?.close(); });

    describe.each(['postgres', 'pglite'])('%s profile', backend => {
        let previous: string | undefined;
        beforeEach(() => { previous = process.env.HAPPIER_DB_PROVIDER; process.env.HAPPIER_DB_PROVIDER = backend; });
        afterEach(() => {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        });
        it('reads activity scoped to its Source', async () => {
            expect(await db.$transaction(tx => listDeploymentEnvironmentsInTx(tx, owner.id,
                { serverId, projectSourceId: sourceId, projection: 'activity' })))
                .toMatchObject({ activity: { running: false, failed: false, attentionCount: 0 }, items: [] });
        });
        it('locks the Environment row at the canonical write isolation', async () => {
            await db.$transaction(async tx => {
                await lockDeploymentEnvironmentInTx(tx, environmentId);
                const locks = await tx.$queryRaw<{ mode: string }[]>(prismaRuntime.sql`SELECT mode FROM pg_locks
                    WHERE pid = pg_backend_pid() AND relation = '"DeploymentEnvironment"'::regclass AND mode = 'RowShareLock'`);
                expect(locks).toEqual([{ mode: 'RowShareLock' }]);
            }, { isolationLevel: deploymentWriteIsolationLevel() });
            expect(deploymentWriteIsolationLevel()).toBe('ReadCommitted');
        });
        it('serializes creation intents before ReadCommitted writes', async () => {
            await db.$transaction(async tx => {
                await lockPostgresRepeatKeyInTx(tx, randomUUID());
                const locks = await tx.$queryRaw<{ locktype: string }[]>(prismaRuntime.sql`SELECT locktype FROM pg_locks
                    WHERE pid = pg_backend_pid() AND locktype = 'advisory'`);
                expect(locks).toEqual([{ locktype: 'advisory' }]);
            });
        });
        it('reads a member Domain content capture', async () => {
            expect(await db.$transaction(tx => readMemberDeploymentDomainContentInTx(tx, { environmentId,
                targetLinkId: randomUUID(), machineId: randomUUID(), installationId: randomUUID(), artifactId: randomUUID() }))).toBeNull();
        });
        it('reads Domain placements for a Machine', async () => {
            expect(await db.$transaction(tx => readDeploymentDomainEnvironmentIdsForMachineInTx(tx,
                { machineId: randomUUID(), limit: 1 }))).toEqual([]);
        });
        it('filters Source repository JSON using the backend dialect', async () => {
            const rows = await db.$queryRaw<{ id: string }[]>(prismaRuntime.sql`SELECT s."id" FROM "ProjectSource" s
                WHERE s."id" = ${sourceId} AND ${projectSourceListFiltersSql({ serverId, query: 'Dialect Source' })}`);
            expect(rows).toEqual([{ id: sourceId }]);
        });
    });
});
