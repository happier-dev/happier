import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx, readProjectSourceInTx, updateProjectSourceInTx, listProjectSourcesInTx } from './projectSourceService';
import { runPostgresMigrationDeploy } from '../../../../scripts/migrate.full.deploy';
import { runMysqlMigrationDeployMain } from '../../../../scripts/migrate.mysql.deploy';

const provider = getDbProviderFromEnv(process.env, 'postgres');
const repository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'acme/retained', cloneUrl: 'https://github.com/acme/retained.git' }, protocol: 'https' };

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Source owner provider storage', () => {
    let connected = false;
    beforeAll(async () => {
        const testUrl = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !testUrl || process.env.DATABASE_URL !== testUrl) {
            throw new Error('Run with the disposable provider DB-contract harness');
        }
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('creates, attaches and clears a repository with real SQL null, then preserves rows across two canonical deploys', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const input = { serverId: 'home', requestKey: crypto.randomUUID(), name: 'Stored provider app' };
        const created = await inTx(tx => createProjectSourceInTx(tx, creator.id, input));
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error(created.error);
        expect(created.source).not.toHaveProperty('repository');
        const quote = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
        const assertSqlNull = async () => {
            const rows = await db.$queryRawUnsafe<Array<{ absent: number | bigint }>>(
                `SELECT COUNT(*) AS ${quote('absent')} FROM ${quote('ProjectSource')} WHERE ${quote('id')} = ${provider === 'mysql' ? '?' : '$1'} AND ${quote('repository')} IS NULL`, created.source.id);
            expect(Number(rows[0]?.absent)).toBe(1);
        };
        await assertSqlNull();
        expect(await inTx(tx => listProjectSourcesInTx(tx, creator.id, { serverId: 'home', query: input.name })))
            .toMatchObject({ ok: true, sources: [{ id: created.source.id }] });
        const attached = await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: created.source.revision, patch: { repository } }));
        expect(attached).toMatchObject({ ok: true, source: { repository } });
        if (!attached.ok) throw new Error(attached.error);
        const cleared = await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: attached.source.revision, patch: { repository: null } }));
        expect(cleared).toMatchObject({ ok: true, source: { revision: attached.source.revision + 1 } });
        if (!cleared.ok) throw new Error(cleared.error);
        expect(cleared.source).not.toHaveProperty('repository');
        await assertSqlNull();
        expect(await inTx(tx => createProjectSourceInTx(tx, creator.id, input))).toEqual(cleared);
        expect(await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: attached.source.revision, patch: { repository } })))
            .toMatchObject({ ok: false, error: 'source_conflict' });
        const count = await db.projectSource.count();
        for (let pass = 0; pass < 2; pass++) {
            if (provider === 'mysql') await runMysqlMigrationDeployMain();
            else await runPostgresMigrationDeploy(process.env);
        }
        expect(await db.projectSource.count()).toBe(count);
        expect(await inTx(tx => readProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id }))).toEqual(cleared);
        await assertSqlNull();
        await db.projectSource.delete({ where: { id: created.source.id } });
    });

    it('backfills ownership and widens repository storage while retaining Source rows and both FK children', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const retained = await db.projectSource.create({ data: { createdByAccountId: creator.id,
            name: 'Retained repository', repository, audience: [], attachments: [] } });
        // The harness owns a disposable worker database. Removing only the new
        // column recreates the actual prior Source schema for the forward SQL.
        const quote = (name: string) => provider === 'mysql' ? `\`${name}\`` : `"${name}"`;
        await db.$executeRawUnsafe(`ALTER TABLE ${quote('ProjectSource')} DROP COLUMN ${quote('owner')}`);
        const sql = await readFile(new URL(`../../../../prisma/${provider === 'mysql' ? 'mysql/' : ''}migrations/20261027103000_add_project_source_owner/migration.sql`, import.meta.url), 'utf8');
        for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
        const stored = await db.projectSource.findUniqueOrThrow({ where: { id: retained.id } });
        expect(stored).toMatchObject({ owner: { kind: 'account', accountId: creator.id }, repository,
            audience: [], revision: retained.revision, createdByAccountId: creator.id });
        expect(await inTx(tx => readProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: retained.id })))
            .toMatchObject({ ok: true, source: { owner: stored.owner, repository } });
        const team = await db.team.create({ data: { name: 'Retained Team owner' } });
        await db.projectSource.create({ data: { createdByAccountId: creator.id, name: 'Retained Team Source', repository,
            owner: { kind: 'team', teamId: team.id }, audience: [], attachments: [] } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id, metadata: '{}' } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
            header: new Uint8Array([1]), body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array([3]) } });
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: retained.id, createdByAccountId: creator.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const defaults = await db.projectDeploymentDefaults.create({ data: { projectSourceId: retained.id } });
        const before = await db.projectSource.findMany({ orderBy: { id: 'asc' } });
        expect(await db.projectSource.count()).toBe(before.length);
        await db.$executeRawUnsafe(provider === 'mysql'
            ? 'ALTER TABLE `ProjectSource` MODIFY COLUMN `repository` JSON NOT NULL'
            : 'ALTER TABLE "ProjectSource" ALTER COLUMN "repository" SET NOT NULL');
        const nullableSql = await readFile(new URL(`../../../../prisma/${provider === 'mysql' ? 'mysql/' : ''}migrations/20261027122000_project_source_optional_repository/migration.sql`, import.meta.url), 'utf8');
        for (const statement of nullableSql.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
        expect(await db.projectSource.count()).toBe(before.length);
        expect(await db.projectSource.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).toEqual(environment);
        expect(await db.projectDeploymentDefaults.findUniqueOrThrow({ where: { projectSourceId: defaults.projectSourceId } })).toEqual(defaults);
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: retained.id } })).toBe(1);
        expect(await db.projectDeploymentDefaults.count({ where: { projectSourceId: retained.id } })).toBe(1);
    });

    it('admits explicit Team ownership without audience inference and rejects stale or unadmitted owner changes', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Workload owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const owner = { kind: 'team', teamId: team.id };
        const input = { serverId: 'home', requestKey: crypto.randomUUID(), name: 'Explicit Team', repository, owner, audience: [] };
        const created = await inTx(tx => createProjectSourceInTx(tx, creator.id, input));
        expect(created).toMatchObject({ ok: true, source: { owner, audience: [] } });
        if (!created.ok) throw new Error(created.error);
        expect(await inTx(tx => createProjectSourceInTx(tx, creator.id, input))).toEqual(created);
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, { serverId: 'home', sourceId: created.source.id })))
            .toMatchObject({ ok: true, canManage: false, source: { owner } });
        expect(await inTx(tx => updateProjectSourceInTx(tx, member.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: created.source.revision, patch: { owner: { kind: 'account', accountId: member.id } } })))
            .toEqual({ ok: false, error: 'source_access_denied' });
        const updated = await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: created.source.revision, patch: { name: 'Current Team' } }));
        expect(updated).toMatchObject({ ok: true });
        expect(await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId: 'home', sourceId: created.source.id,
            expectedRevision: created.source.revision, patch: { owner: { kind: 'account', accountId: creator.id } } })))
            .toMatchObject({ ok: false, error: 'source_conflict' });
    });
});
