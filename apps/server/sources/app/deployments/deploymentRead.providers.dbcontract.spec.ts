import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { listDeploymentEnvironmentsInTx } from './deploymentReadService';
import { initEncrypt } from '@/modules/encrypt';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('exact Machine deployment list on native providers', () => {
    const serverId = `srv_${'c'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousMasterSecret = process.env.HANDY_MASTER_SECRET;
    let connected = false;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !target || process.env.DATABASE_URL !== target) {
            throw new Error('Run with the disposable native DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-read-native-test-only';
        await initEncrypt();
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (previousIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousIdentity;
        if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
    });

    it.each(['environment', 'preview'] as const)('pages caller-sized %s selections across the PostgreSQL bind boundary', async selector => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: randomUUID(), name: 'Large exact selection', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            headerVersion: 1, bodyVersion: 1, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const base = { projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction',
            deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const template = await db.deploymentEnvironment.create({ data: { ...base, purpose: 'standard' } });
        const target = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const children = await Promise.all(['a', 'Z', '_'].map(position => db.deploymentEnvironment.create({ data: {
            ...base, id: `${position}-${randomUUID()}`, purpose: 'preview', previewTemplateEnvironmentId: template.id,
            previewRepositoryId: source.source.id, previewPullRequestId: `pr:${position}`, previewTargetLinkId: target.id,
        } })));
        // Missing selections need no rows: their bind parameters alone cross
        // Prisma/PostgreSQL's 32767-parameter query boundary.
        const selection = Array.from({ length: 32_768 }, (_, index) => `missing-${index}`);
        const selectedIds = children.map(row => selector === 'environment' ? row.id : row.previewPullRequestId!);
        selection.splice(0, 1, selectedIds[0]!);
        selection.splice(16_384, 1, selectedIds[1]!);
        selection.push(selectedIds[2]!, selectedIds[0]!);
        const input = { serverId, projectSourceId: source.source.id, limit: 1,
            ...(selector === 'environment' ? { environmentIds: selection }
                : { previewRepositoryId: source.source.id, previewPullRequestIds: selection }) };
        // The provider owns collation; concatenating chunk results and sorting
        // in JavaScript must not change the existing page/cursor contract.
        const ordered = await db.deploymentEnvironment.findMany({ where: { id: { in: children.map(row => row.id) } },
            orderBy: { id: 'asc' }, select: { id: true } });
        let cursor: string | undefined;
        for (const [index, expected] of ordered.entries()) {
            const admissions: string[] = [];
            const stop = observePrismaRequests(db, { before: request => {
                if (request.model === 'ProjectSource' && request.action === 'findUnique') admissions.push(request.model);
            } });
            const page = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, { ...input, cursor })).finally(stop);
            expect(page).toMatchObject({ ok: true, coverage: 'complete' });
            if (!page.ok) throw new Error(page.error);
            expect(page.items).toHaveLength(1);
            expect(page.items[0]!.id).toBe(expected.id);
            expect(page.nextCursor).toBe(index === ordered.length - 1 ? null : expected.id);
            expect(admissions, 'selection chunks share one Source admission per page').toHaveLength(1);
            cursor = page.nextCursor ?? undefined;
        }
        const intersection = await inReadSnapshot(tx => listDeploymentEnvironmentsInTx(tx, owner.id, {
            ...input, limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1,
            environmentIds: selector === 'environment' ? selection : [children[1]!.id],
            previewRepositoryId: source.source.id,
            previewPullRequestIds: selector === 'preview' ? selection : [children[1]!.previewPullRequestId!],
        }));
        expect(intersection).toMatchObject({ ok: true, coverage: 'complete', items: [{ id: children[1]!.id }], nextCursor: null });
        if (!intersection.ok) throw new Error(intersection.error);
        expect(intersection.items).toHaveLength(1);
    });
});
