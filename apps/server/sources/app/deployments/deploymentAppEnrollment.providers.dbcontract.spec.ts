import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createDbMaintenanceClient, getDbProviderFromEnv } from '@/storage/prisma';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { readDeploymentAppEnrollmentsForMachinesInTx } from './deploymentAppEnrollment';

const provider = getDbProviderFromEnv(process.env, 'postgres');

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('App enrollment native schema compatibility', () => {
    it('creates ordinary Machines and projects only their exact admitted App receipt on a fresh native database', async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || process.env.DATABASE_URL !== target) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        const client = await createDbMaintenanceClient(provider);
        try {
            const account = await client.account.create({ data: { encryptionMode: 'plain' } });
            const machine = await client.machine.create({ data: { id: randomUUID(), accountId: account.id,
                metadata: '{}', installationId: randomUUID() } });
            expect(await client.machine.findUnique({ where: { id: machine.id } })).toMatchObject({
                id: machine.id, accountId: account.id, metadata: '{}',
            });
            const requests: { model?: string; action: string; args: unknown }[] = [];
            let stop = observePrismaRequests(client, { before: request => { requests.push(request); } });
            try {
                expect(await client.$transaction(tx => readDeploymentAppEnrollmentsForMachinesInTx(tx,
                    { machines: [machine] }))).toEqual(new Map());
                expect(requests).toEqual([]);
            } finally { stop(); }
            const source = await client.projectSource.create({ data: { createdByAccountId: account.id,
                name: 'Native App association', owner: { kind: 'account', accountId: account.id }, audience: [], attachments: [] } });
            const artifact = await client.artifact.create({ data: { id: randomUUID(), accountId: account.id,
                header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
            const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
            const environment = await client.deploymentEnvironment.create({ data: { projectSourceId: source.id,
                createdByAccountId: account.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machine.id, ...content } });
            const link = await client.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...content } });
            const receipt = await client.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                requestedByAccountId: account.id, requestKey: randomUUID(), actionOperationId: randomUUID(),
                operation: 'deploy', state: 'succeeded', acceptedControllerMachineId: machine.id,
                acceptedControllerInstallationId: machine.installationId, ...content } });
            const child = await client.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}',
                installationId: randomUUID(), deploymentAppDeploymentId: receipt.id } });
            requests.length = 0;
            stop = observePrismaRequests(client, { before: request => { requests.push(request); } });
            try {
                expect(await client.$transaction(tx => readDeploymentAppEnrollmentsForMachinesInTx(tx,
                    { machines: [machine, child] }))).toEqual(new Map([[child.id, { environmentId: environment.id,
                    deploymentId: receipt.id, targetLinkId: link.id,
                    controller: { machineId: machine.id, installationId: machine.installationId } }]]));
                expect(requests).toEqual([expect.objectContaining({ model: 'Deployment', action: 'findMany',
                    args: expect.objectContaining({ where: { id: { in: [receipt.id] } } }) })]);
            } finally { stop(); }
            if (provider === 'postgres') {
                const plan = await client.$transaction(async tx => {
                    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
                    return tx.$queryRawUnsafe<unknown[]>('EXPLAIN (FORMAT JSON) SELECT "id" FROM "Deployment" WHERE "id" = $1', receipt.id);
                });
                expect(JSON.stringify(plan)).toContain('"Index Cond"');
                expect(JSON.stringify(plan)).not.toContain('"Node Type":"Seq Scan"');
            }
        } finally { await client.$disconnect(); }
    });
});
