import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();

describe.skipIf(provider !== 'postgres')('PostgreSQL named preview companion relation contract', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('PostgreSQL companion contract requires the disposable database harness');
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('retains ordinary NULL relations and enforces one companion, a real parent and physical delete restriction', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { createdByAccountId: account.id,
            name: 'Preview companion storage contract', audience: [], attachments: [] } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            headerVersion: 1, bodyVersion: 1 } });
        const common = { projectSourceId: source.id, createdByAccountId: account.id,
            protection: 'nonProduction', deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const template = await db.deploymentEnvironment.create({ data: { ...common, purpose: 'standard' } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const main = await db.deploymentEnvironment.create({ data: { ...common, purpose: 'preview',
            previewTemplateEnvironmentId: template.id, previewRepositoryId: source.id,
            previewPullRequestId: 'companion-pr', previewTargetLinkId: link.id } });
        const companion = await db.deploymentEnvironment.create({ data: { ...common, purpose: 'standard' } });
        const other = await db.deploymentEnvironment.create({ data: { ...common, purpose: 'standard' } });
        expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: template.id } })).previewCompanionOfEnvironmentId).toBeNull();
        expect(companion.previewCompanionOfEnvironmentId).toBeNull();
        const associate = (id: string, parentId: string) => db.deploymentEnvironment.update({ where: { id },
            data: { previewCompanionOfEnvironmentId: parentId } });
        expect((await associate(companion.id, main.id)).previewCompanionOfEnvironmentId).toBe(main.id);
        await expect(associate(other.id, main.id)).rejects.toMatchObject({ code: 'P2002' });
        await expect(associate(other.id, randomUUID())).rejects.toMatchObject({ code: 'P2003' });
        await expect(db.deploymentEnvironment.delete({ where: { id: main.id } })).rejects.toMatchObject({ code: 'P2003' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: main.id } })).not.toBeNull();
        await db.deploymentEnvironment.update({ where: { id: companion.id }, data: { previewCompanionOfEnvironmentId: null } });
        await expect(db.deploymentEnvironment.delete({ where: { id: main.id } })).resolves.toMatchObject({ id: main.id });
    });
});
