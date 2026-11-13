import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import fastify, { type FastifyRequest } from 'fastify';
import { validatorCompiler, serializerCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type DeploymentDomain, type DeploymentEnvironment } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { DeploymentDomainPageSuccessV1Schema, DeploymentDataPageSuccessV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { listDeploymentDomainPageInTx, listDeploymentDataPageInTx } from './deploymentAccountPageReadService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('account deployment pages on PostgreSQL', () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    const previousIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const previousSecret = process.env.HANDY_MASTER_SECRET;
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('An explicit isolated PostgreSQL test connection is required');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        process.env.HANDY_MASTER_SECRET ??= 'deployment-account-page-test-only';
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (previousIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousIdentity;
        if (previousSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previousSecret;
    });

    it('uses one statement per page including Source, Team and Artifact access, and advances beyond denied candidates', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Account pages Team' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: reader.id, role: 'member' },
        ] });
        const source = async (actorAccountId: string, audience: { principal: { kind: 'account'; accountId: string }; level: 'view' }[],
            teamOwner = false) => {
            const result = await inTx(tx => createProjectSourceInTx(tx, actorAccountId, { serverId,
                requestKey: randomUUID(), name: 'Page source', audience,
                ...(teamOwner ? { owner: { kind: 'team', teamId: team.id } } : {}) }));
            if (!result.ok) throw new Error(result.error);
            return result.source;
        };
        const ownSource = await source(reader.id, []);
        const sharedSource = await source(owner.id, [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }]);
        const teamSource = await source(owner.id, [], true);
        const privateSource = await source(owner.id, []);
        async function content(accountId: string, kind: string, teamOwned = false) {
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId,
                kind: `v1:other:${kind}`, headerVersion: 1, bodyVersion: 1,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Page fixture' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
            if (teamOwned) await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), artifactId: artifact.id } });
            return { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        const environments: DeploymentEnvironment[] = [];
        const domains: DeploymentDomain[] = [];
        for (const [index, selected] of [ownSource, sharedSource, teamSource, privateSource].entries()) {
            const accountId = index === 0 ? reader.id : owner.id;
            const environment = await db.deploymentEnvironment.create({ data: {
                id: `pfc-${index}-${randomUUID()}`, controllerMachineId: machine.id, projectSourceId: selected.id, createdByAccountId: accountId,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                ...await content(accountId, 'deployment-environment.v1', index === 2),
            } });
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: accountId, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...await content(accountId, 'deployment-target-link.v1', index === 2) } });
            const domain = await db.deploymentDomain.create({ data: { id: `pfc-${index}-${randomUUID()}`,
                environmentId: environment.id, targetLinkId: link.id, createdByAccountId: accountId,
                state: 'pending', ...await content(accountId, 'deployment-domain.v1', index === 2) } });
            environments.push(environment);
            domains.push(domain);
        }
        const statements: string[] = [];
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event.query));
        await client.$connect();
        const dataStatements = () => statements.filter(sql => !/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(sql.trim()));
        try {
            for (const kind of ['domains', 'data'] as const) {
                const read = (actorAccountId: string, cursor?: string) => client.$transaction(tx => kind === 'domains'
                    ? listDeploymentDomainPageInTx(tx, actorAccountId, { serverId, limit: 2, ...(cursor ? { cursor } : {}) })
                    : listDeploymentDataPageInTx(tx, actorAccountId, { serverId, limit: 2, ...(cursor ? { cursor } : {}) }));
                statements.length = 0;
                const first = await read(reader.id);
                expect(dataStatements(), `${kind} includes every access read`).toHaveLength(1);
                expect(first).toMatchObject({ ok: true, items: [{ environment: { id: environments[0]!.id } },
                    { environment: { id: environments[1]!.id } }], nextCursor: expect.any(String) });
                if (!first.ok || !first.nextCursor) throw new Error('Expected page continuation');
                if (kind === 'domains') {
                    statements.length = 0;
                    expect(await client.$transaction(tx => listDeploymentDataPageInTx(tx, reader.id, { serverId, cursor: first.nextCursor! })))
                        .toMatchObject({ ok: false, error: 'deployment_invalid' });
                    expect(dataStatements()).toHaveLength(0);
                }
                statements.length = 0;
                const second = await read(reader.id, first.nextCursor);
                expect(dataStatements()).toHaveLength(1);
                expect(second).toMatchObject({ ok: true, items: [{ environment: { id: environments[2]!.id } }], nextCursor: null });
                if (!second.ok) throw new Error(second.error);
                expect(second.artifacts.some(item => item.id === environments[3]!.contentArtifactId)).toBe(false);
                if (kind === 'domains') DeploymentDomainPageSuccessV1Schema.parse(second);
                else DeploymentDataPageSuccessV1Schema.parse(second);
                statements.length = 0;
                expect(await read(outsider.id)).toMatchObject({ ok: true, items: [], nextCursor: expect.any(String) });
                expect(dataStatements()).toHaveLength(1);
                statements.length = 0;
                expect(await read(outsider.id, first.nextCursor)).toMatchObject({ ok: false, error: 'deployment_invalid' });
                expect(dataStatements()).toHaveLength(0);
            }
            // Inventory growth beyond the existing page budget must not multiply admission reads.
            const base = environments[0]!;
            await db.deploymentEnvironment.createMany({ data: Array.from({ length: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 + 1 }, (_, index) => ({
                id: `pfc-scale-${index}-${randomUUID()}`, controllerMachineId: machine.id, projectSourceId: ownSource.id, createdByAccountId: reader.id,
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                contentArtifactId: base.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            })) });
            statements.length = 0;
            expect(await client.$transaction(tx => listDeploymentDataPageInTx(tx, reader.id, { serverId, limit: 2 })))
                .toMatchObject({ ok: true, items: expect.any(Array), nextCursor: expect.any(String) });
            expect(dataStatements()).toHaveLength(1);
            await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: reader.id }, data: { status: 'suspended' } });
            statements.length = 0;
            const withdrawn = await client.$transaction(tx => listDeploymentDomainPageInTx(tx, reader.id, { serverId }));
            expect(withdrawn).toMatchObject({ ok: true });
            if (!withdrawn.ok) throw new Error(withdrawn.error);
            expect(withdrawn.items.some(item => item.domain.id === domains[2]!.id)).toBe(false);
            expect(dataStatements()).toHaveLength(1);
            const app = fastify().withTypeProvider<ZodTypeProvider>();
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            // Authentication is the system boundary; the complete page handler and access owners remain real.
            app.decorate('authenticate', async (request: FastifyRequest) => {
                request.userId = reader.id;
                request.authAuthority = 'present_user';
            });
            registerDeploymentRoutes(app);
            try {
                for (const [path, schema] of [
                    ['/v1/deployments/domains', DeploymentDomainPageSuccessV1Schema],
                    ['/v1/deployments/data-services', DeploymentDataPageSuccessV1Schema],
                ] as const) {
                    const response = await app.inject({ method: 'GET', url: path + '?serverId=' + serverId + '&limit=2' });
                    expect(response.statusCode, response.body).toBe(200);
                    const page = schema.parse(response.json());
                    expect(page.items).toHaveLength(2);
                    expect(page.artifacts.length).toBeGreaterThan(0);
                }
            } finally { await app.close(); }
            // A stale head is partial content, never a current body silently attached to an older reference.
            await db.artifact.update({ where: { id: base.contentArtifactId }, data: { headerVersion: 2 } });
            statements.length = 0;
            const stale = await client.$transaction(tx => listDeploymentDomainPageInTx(tx, reader.id, { serverId }));
            expect(stale).toMatchObject({ ok: true, coverage: 'partial' });
            if (!stale.ok) throw new Error(stale.error);
            expect(stale.artifacts.some(item => item.id === base.contentArtifactId)).toBe(false);
            expect(dataStatements()).toHaveLength(1);
        } finally { await client.$disconnect(); }
    });
});
