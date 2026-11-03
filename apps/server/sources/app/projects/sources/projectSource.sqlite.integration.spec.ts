import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as privacyKit from 'privacy-kit';
import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime/server';
import { PrismaClient as SqlitePrismaClient } from '../../../../generated/sqlite-client/index.js';
import { applySqliteMigrations } from '../../../../scripts/prismaMigrations';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createProjectSourceInTx, readProjectSourceInTx, updateProjectSourceInTx, deleteProjectSourceInTx, listProjectSourcesInTx } from './projectSourceService';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';

const repository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, repository: { nameWithOwner: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', visibility: 'private' }, protocol: 'https' };
const serverId = 'home';
describe('Source catalog real SQLite owner', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-source-catalog-', initEncrypt: true }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });
    const account = () => db.account.create({ data: { encryptionMode: 'plain' } });
    it('widens retained SQLite Sources without losing either FK child, data, indexes or integrity', async () => {
        const migrationName = '20261027122000_project_source_optional_repository';
        const migrationsDir = fileURLToPath(new URL('../../../../prisma/sqlite/migrations/', import.meta.url));
        const directory = await mkdtemp(join(tmpdir(), 'happier-source-nullable-upgrade-'));
        const previousMigrations = join(directory, 'migrations');
        const databasePath = join(directory, 'upgrade.sqlite');
        await mkdir(previousMigrations);
        for (const entry of await readdir(migrationsDir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== migrationName) await cp(join(migrationsDir, entry.name), join(previousMigrations, entry.name), { recursive: true });
        }
        const client = new SqlitePrismaClient({ datasources: { db: { url: renderPrismaCompatibleSqliteDatabaseUrl({ dbPath: databasePath, platform: process.platform }) } } });
        try {
            await applySqliteMigrations({ databasePath, migrationsDir: previousMigrations });
            const creator = await client.account.create({ data: { encryptionMode: 'plain' } });
            const team = await client.team.create({ data: { name: 'Retained owner' } });
            const sources = await Promise.all([
                client.projectSource.create({ data: { createdByAccountId: creator.id, name: 'Personal retained', repository,
                    owner: { kind: 'account', accountId: creator.id }, audience: [], attachments: [] } }),
                client.projectSource.create({ data: { createdByAccountId: creator.id, name: 'Team retained', repository,
                    owner: { kind: 'team', teamId: team.id }, audience: [], attachments: [] } }),
            ]);
            const machine = await client.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id, metadata: '{}' } });
            const artifact = await client.artifact.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
                header: new Uint8Array([1]), body: new Uint8Array([2]), dataEncryptionKey: new Uint8Array([3]) } });
            const environment = await client.deploymentEnvironment.create({ data: { projectSourceId: sources[0].id,
                createdByAccountId: creator.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machine.id, contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const defaults = await client.projectDeploymentDefaults.create({ data: { projectSourceId: sources[0].id } });
            const childFks = await Promise.all(['DeploymentEnvironment', 'ProjectDeploymentDefaults']
                .map(table => client.$queryRawUnsafe(`PRAGMA foreign_key_list("${table}")`)));
            expect(await client.projectSource.count()).toBe(2);
            expect(await client.deploymentEnvironment.count()).toBe(1);
            expect(await client.projectDeploymentDefaults.count()).toBe(1);
            expect(await applySqliteMigrations({ databasePath, migrationsDir })).toEqual({ applied: [migrationName] });
            expect(await applySqliteMigrations({ databasePath, migrationsDir })).toEqual({ applied: [] });
            expect(await client.projectSource.findMany({ orderBy: { id: 'asc' } })).toEqual([...sources].sort((a, b) => a.id.localeCompare(b.id)));
            expect(await client.deploymentEnvironment.findMany()).toEqual([environment]);
            expect(await client.projectDeploymentDefaults.findMany()).toEqual([defaults]);
            expect(await Promise.all(['DeploymentEnvironment', 'ProjectDeploymentDefaults']
                .map(table => client.$queryRawUnsafe(`PRAGMA foreign_key_list("${table}")`)))).toEqual(childFks);
            expect(await client.$queryRawUnsafe('PRAGMA index_info("ProjectSource_createdByAccountId_id_idx")'))
                .toMatchObject([{ name: 'createdByAccountId' }, { name: 'id' }]);
            expect(await client.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            expect(await client.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
            const repositoryFree = await client.projectSource.create({ data: { createdByAccountId: creator.id,
                name: 'Stored after upgrade', owner: { kind: 'account', accountId: creator.id }, audience: [], attachments: [] } });
            expect(repositoryFree.repository).toBeNull();
            const sqlNull = await client.$queryRawUnsafe<Array<{ absent: number | bigint }>>(
                'SELECT COUNT(*) AS absent FROM "ProjectSource" WHERE "id" = ? AND "repository" IS NULL', repositoryFree.id);
            expect(Number(sqlNull[0]?.absent)).toBe(1);
            expect(await client.projectSource.count()).toBe(3);
        } finally {
            await client.$disconnect();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('backfills retained SQLite Sources to creator ownership without deriving an owner from plural audience', async () => {
        const retained = new DatabaseSync(':memory:');
        try {
            retained.exec('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY)');
            retained.exec(await readFile(new URL('../../../../prisma/sqlite/migrations/20261008131000_add_project_sources/migration.sql', import.meta.url), 'utf8'));
            retained.exec('INSERT INTO "Account" ("id") VALUES (\'retained-creator\')');
            const audience = ['team-a', 'team-b'].map(teamId => ({ principal: { kind: 'team', teamId }, level: 'view' }));
            retained.prepare('INSERT INTO "ProjectSource" ("id","createdByAccountId","name","repository","audience","attachments","updatedAt") VALUES (?,?,?,?,?,?,?)')
                .run('retained-source', 'retained-creator', 'Retained', JSON.stringify(repository), JSON.stringify(audience), '[]', '2026-10-26T00:00:00Z');
            retained.exec(await readFile(new URL('../../../../prisma/sqlite/migrations/20261027103000_add_project_source_owner/migration.sql', import.meta.url), 'utf8'));
            const row = retained.prepare('SELECT "owner","repository","audience","revision" FROM "ProjectSource"').get();
            expect(row).toBeDefined();
            expect(JSON.parse(String(row?.owner))).toEqual({ kind: 'account', accountId: 'retained-creator' });
            expect(JSON.parse(String(row?.repository))).toEqual(repository);
            expect(JSON.parse(String(row?.audience))).toEqual(audience);
            expect(row?.revision).toBe(1);
            expect(retained.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally { retained.close(); }
    });
    it('keeps one admitted owner independent of plural audience and protects owner changes with current authority and CAS', async () => {
        const [creator, administrator, outsider] = await Promise.all([account(), account(), account()]);
        const teams = await Promise.all(['Owner team', 'Audience team'].map(name => db.team.create({ data: { name } })));
        for (const team of teams) await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'owner' } });
        await db.teamMembership.create({ data: { teamId: teams[0].id, accountId: administrator.id, role: 'admin' } });
        const audience = teams.map(team => ({ principal: { kind: 'team', teamId: team.id }, level: 'view' }));
        const input = { serverId, requestKey: crypto.randomUUID(), name: 'Owned source', repository, audience };
        const personal = await inTx(tx => createProjectSourceInTx(tx, creator.id, input));
        expect(personal).toMatchObject({ ok: true, source: { owner: { kind: 'account', accountId: creator.id } } });
        if (!personal.ok) throw new Error(personal.error);
        expect(await inTx(tx => createProjectSourceInTx(tx, creator.id, { ...input,
            owner: { kind: 'account', accountId: creator.id } }))).toEqual(personal);
        const teamOwner = { kind: 'team', teamId: teams[0].id };
        expect(await inTx(tx => updateProjectSourceInTx(tx, administrator.id, { serverId, sourceId: personal.source.id,
            expectedRevision: personal.source.revision, patch: { owner: teamOwner } }))).toEqual({ ok: false, error: 'source_access_denied' });
        expect(await inTx(tx => createProjectSourceInTx(tx, outsider.id, { ...input, requestKey: crypto.randomUUID(),
            audience: [], owner: teamOwner }))).toEqual({ ok: false, error: 'source_access_denied' });
        expect(await inTx(tx => createProjectSourceInTx(tx, creator.id, { ...input, owner: teamOwner })))
            .toEqual({ ok: false, error: 'source_conflict' });
        const owned = await inTx(tx => createProjectSourceInTx(tx, creator.id, { ...input,
            requestKey: crypto.randomUUID(), audience: [], owner: teamOwner }));
        expect(owned).toMatchObject({ ok: true, source: { owner: teamOwner } });
        if (!owned.ok) throw new Error(owned.error);
        expect(await inTx(tx => readProjectSourceInTx(tx, administrator.id, { serverId, sourceId: owned.source.id })))
            .toMatchObject({ ok: true, canManage: true });
        const moved = await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: personal.source.id,
            expectedRevision: personal.source.revision, patch: { owner: teamOwner, audience: [] } }));
        expect(moved).toMatchObject({ ok: true, source: { owner: teamOwner, createdByAccountId: creator.id, audience: [] } });
        if (!moved.ok) throw new Error(moved.error);
        expect(await inTx(tx => readProjectSourceInTx(tx, administrator.id, { serverId, sourceId: personal.source.id })))
            .toMatchObject({ ok: true, canManage: true, source: { owner: teamOwner } });
        expect(await inTx(tx => listProjectSourcesInTx(tx, administrator.id, { serverId, query: 'Owned source' })))
            .toMatchObject({ ok: true, sources: expect.arrayContaining([expect.objectContaining({ id: personal.source.id })]) });
        const mutations: string[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === 'ProjectSource' && ['create', 'update', 'updateMany', 'delete', 'deleteMany'].includes(request.action)) mutations.push(request.action);
        } });
        try {
            expect(await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: personal.source.id,
                expectedRevision: moved.source.revision, patch: { owner: teamOwner } }))).toEqual(moved);
            expect(mutations).toEqual([]);
        } finally { stop(); }
        expect(await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: personal.source.id,
            expectedRevision: personal.source.revision, patch: { owner: { kind: 'account', accountId: creator.id } } })))
            .toMatchObject({ ok: false, error: 'source_conflict' });
        await db.teamMembership.updateMany({ where: { teamId: teams[0].id, accountId: creator.id }, data: { status: 'suspended' } });
        expect(await inTx(tx => updateProjectSourceInTx(tx, creator.id, { serverId, sourceId: personal.source.id,
            expectedRevision: moved.source.revision, patch: { owner: { kind: 'account', accountId: creator.id } } })))
            .toEqual({ ok: false, error: 'source_unavailable' });
        expect(await inTx(tx => updateProjectSourceInTx(tx, administrator.id, { serverId, sourceId: personal.source.id,
            expectedRevision: moved.source.revision, patch: { owner: { kind: 'team', teamId: teams[0].id, accountId: creator.id } } })))
            .toEqual({ ok: false, error: 'source_invalid' });
    });
    it('persists repository-free Sources with one explicit owner, canonical replay and repository attachment under CAS', async () => {
        const owner = await account();
        const input = { serverId, requestKey: crypto.randomUUID(), name: 'Stored application' };
        const created = await inTx(tx => createProjectSourceInTx(tx, owner.id, input));
        expect(created).toMatchObject({ ok: true, source: { owner: { kind: 'account', accountId: owner.id } } });
        if (!created.ok) throw new Error(created.error);
        expect(created.source).not.toHaveProperty('repository');
        expect((await db.projectSource.findUniqueOrThrow({ where: { id: created.source.id } })).repository).toBeNull();
        expect(await inTx(tx => listProjectSourcesInTx(tx, owner.id, { serverId, query: 'Stored application' })))
            .toMatchObject({ ok: true, sources: [{ id: created.source.id }] });
        expect(await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id }))).toEqual(created);
        expect(await inTx(tx => createProjectSourceInTx(tx, owner.id, input))).toEqual(created);
        const beforeReplay = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } });
        const attached = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id,
            expectedRevision: created.source.revision, patch: { repository } }));
        expect(attached).toMatchObject({ ok: true, source: { repository, owner: { kind: 'account', accountId: owner.id } } });
        if (!attached.ok) throw new Error(attached.error);
        expect(await inTx(tx => createProjectSourceInTx(tx, owner.id, input))).toEqual(attached);
        const afterChange = await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } });
        expect(afterChange.cursor).toBeGreaterThan(beforeReplay.cursor);
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id,
            expectedRevision: attached.source.revision, patch: { repository } }))).toEqual(attached);
        expect((await db.accountChange.findFirstOrThrow({ where: {
            accountId: owner.id, entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1,
        } })).cursor).toBe(afterChange.cursor);
        expect(await inTx(tx => listProjectSourcesInTx(tx, owner.id, { serverId, query: 'Stored application' })))
            .toMatchObject({ ok: true, sources: [{ id: created.source.id }] });
        const cleared = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id,
            expectedRevision: attached.source.revision, patch: { repository: null } }));
        expect(cleared).toMatchObject({ ok: true, source: { revision: attached.source.revision + 1 } });
        if (!cleared.ok) throw new Error(cleared.error);
        expect(cleared.source).not.toHaveProperty('repository');
        expect((await db.projectSource.findUniqueOrThrow({ where: { id: created.source.id } })).repository).toBeNull();
        expect(await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id }))).toEqual(cleared);
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id,
            expectedRevision: cleared.source.revision, patch: { repository: null } }))).toEqual(cleared);
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: created.source.id,
            expectedRevision: attached.source.revision, patch: { repository } })))
            .toMatchObject({ ok: false, error: 'source_conflict' });
    });
    it('serves acknowledged mutations and current conflicts through authenticated HTTP, with exact path/body identity', async () => {
        const owner = await account();
        await withAuthenticatedTestApp(projectSourceRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const createInput = { serverId, requestKey: crypto.randomUUID(), name: 'HTTP source', repository };
            const created = await app.inject({ method: 'POST', url: '/v1/projects/sources', headers, payload: createInput });
            expect(created.statusCode, created.body).toBe(200);
            const row = created.json().source;
            const payload = { serverId, sourceId: row.id, expectedRevision: row.revision, patch: { name: 'HTTP update' } };
            const updated = await app.inject({ method: 'PATCH', url: `/v1/projects/sources/${row.id}`, headers, payload });
            expect(updated.statusCode, updated.body).toBe(200);
            expect(updated.json()).toMatchObject({ ok: true, canManage: true, source: { name: 'HTTP update' } });
            const replayed = await app.inject({ method: 'POST', url: '/v1/projects/sources', headers, payload: createInput });
            expect(replayed.json()).toEqual(updated.json());
            const changedIntent = await app.inject({ method: 'POST', url: '/v1/projects/sources', headers, payload: { ...createInput, name: 'Changed create' } });
            expect(changedIntent.statusCode).toBe(409);
            expect(changedIntent.json()).toEqual({ ok: false, error: 'source_conflict' });
            const conflict = await app.inject({ method: 'PATCH', url: `/v1/projects/sources/${row.id}`, headers, payload });
            expect(conflict.statusCode, conflict.body).toBe(409);
            expect(conflict.json()).toMatchObject({ ok: false, error: 'source_conflict', current: { name: 'HTTP update' } });
            expect((await app.inject({ method: 'PATCH', url: `/v1/projects/sources/another-source`, headers, payload })).statusCode).toBe(400);
            const invalid = await app.inject({ method: 'POST', url: '/v1/projects/sources', headers, payload: { serverId, requestKey: crypto.randomUUID(), name: 'Invalid', repository, token: 'must-not-persist' } });
            expect(invalid.statusCode).toBe(400);
            expect(invalid.json()).toEqual({ ok: false, error: 'source_invalid' });
            const listed = await app.inject({ method: 'GET', url: '/v1/projects/sources?serverId=home&query=HTTP', headers });
            expect(listed.json()).toMatchObject({ ok: true, sources: [{ id: row.id }], coverage: { complete: true, nextCursor: null } });
            const apiHeaders = { ...headers, 'x-test-auth-token-kind': 'api_token', 'x-test-api-token-account-id': owner.id,
                'x-test-api-token-principal-id': 'full-principal', 'x-test-api-token-credential-id': 'full-credential' };
            expect((await app.inject({ method: 'GET', url: `/v1/projects/sources/${row.id}?serverId=home`, headers: apiHeaders })).statusCode).toBe(200);
        });
    });
    async function source(ownerId: string, audience: unknown[] = []) {
        const result = await inTx(tx => createProjectSourceInTx(tx, ownerId, { serverId, requestKey: crypto.randomUUID(), name: 'Repo', repository, audience }));
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        return result.source;
    }
    it('replays one create intent as current state, refusing changed payloads and deleted rows without duplicating', async () => {
        const owner = await account();
        const input = { serverId, requestKey: 'one-create-intent', name: 'Retry source', repository };
        const create = () => inTx(tx => createProjectSourceInTx(tx, owner.id, input));
        const first = await create(); expect(first.ok).toBe(true); if (!first.ok) return;
        expect(await create()).toEqual(first);
        expect(await inTx(tx => createProjectSourceInTx(tx, owner.id, { ...input, name: 'Different intent' }))).toEqual({ ok: false, error: 'source_conflict' });
        const updated = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: first.source.id, expectedRevision: first.source.revision, patch: { name: 'Current source' } }));
        expect(updated.ok).toBe(true); if (!updated.ok) return;
        expect(await create()).toEqual(updated);
        expect(await inTx(tx => deleteProjectSourceInTx(tx, owner.id, { serverId, sourceId: first.source.id, expectedRevision: updated.source.revision }))).toMatchObject({ ok: true });
        expect(await create()).toEqual({ ok: false, error: 'source_conflict' });
        expect(await db.projectSource.count({ where: { createdByAccountId: owner.id } })).toBe(0);
    });
    it('uses current Team and group lifetimes for reads; ordinary audience cannot edit and revoked access cannot use metadata', async () => {
        const [owner, member, outsider] = await Promise.all([account(), account(), account()]);
        const team = await db.team.create({ data: { name: 'Source team' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        const row = await source(owner.id, [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }]);
        const input = { serverId, sourceId: row.id };
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, input))).toMatchObject({ ok: true, canManage: false, source: { id: row.id } });
        expect(await inTx(tx => readProjectSourceInTx(tx, outsider.id, input))).toEqual({ ok: false, error: 'source_unavailable' });
        await db.account.update({ where: { id: outsider.id }, data: { homeRole: 'admin' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, outsider.id, input))).toEqual({ ok: false, error: 'source_unavailable' });
        expect(await inTx(tx => updateProjectSourceInTx(tx, member.id, { ...input, expectedRevision: row.revision, patch: { name: 'Unauthorized' } }))).toEqual({ ok: false, error: 'source_access_denied' });
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'guest' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, input))).toEqual({ ok: false, error: 'source_unavailable' });
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'member' } });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, input))).toEqual({ ok: false, error: 'source_unavailable' });
        await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, input))).toEqual({ ok: false, error: 'source_unavailable' });
        expect(await inTx(tx => listProjectSourcesInTx(tx, member.id, { serverId }))).toMatchObject({ ok: true, sources: [] });
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'active', role: 'admin' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, input))).toMatchObject({ ok: true, canManage: true });
        expect(await inTx(tx => updateProjectSourceInTx(tx, member.id, { ...input, expectedRevision: row.revision, patch: { name: 'Managed' } }))).toMatchObject({ ok: true, source: { name: 'Managed' } });
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Contributors', nameKey: 'contributors' } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const grouped = await source(owner.id, [{ principal: { kind: 'group', teamId: team.id, groupId: group.id }, level: 'view' }]);
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, { serverId, sourceId: grouped.id }))).toMatchObject({ ok: true });
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'guest' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, { serverId, sourceId: grouped.id }))).toMatchObject({ ok: true });
        await db.teamMembership.update({ where: { id: membership.id }, data: { role: 'member' } });
        const administrator = await account();
        await db.teamMembership.create({ data: { teamId: team.id, accountId: administrator.id, role: 'admin' } });
        const changed = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: grouped.id, expectedRevision: grouped.revision, patch: { name: 'Group source update' } }));
        expect(changed).toMatchObject({ ok: true });
        expect(await inTx(tx => readProjectSourceInTx(tx, administrator.id, { serverId, sourceId: grouped.id }))).toMatchObject({ ok: true, canManage: true });
        expect(await db.accountChange.count({ where: { accountId: administrator.id, entityId: PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } })).toBe(1);
        await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, { serverId, sourceId: grouped.id }))).toEqual({ ok: false, error: 'source_unavailable' });
    });
    it('keeps overlapping direct and Team access independent and pages only authorized matching metadata', async () => {
        const [owner, member, outsider] = await Promise.all([account(), account(), account()]);
        const team = await db.team.create({ data: { name: 'Overlapping' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
        await makeShareEligibleForTest(owner.id, member.id);
        const first = await source(owner.id, [{ principal: { kind: 'account', accountId: member.id }, level: 'view' }, { principal: { kind: 'team', teamId: team.id }, level: 'view' }]);
        const second = await source(owner.id, [{ principal: { kind: 'account', accountId: member.id }, level: 'view' }]);
        await source(outsider.id);
        await db.teamMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } });
        expect(await inTx(tx => readProjectSourceInTx(tx, member.id, { serverId, sourceId: first.id }))).toMatchObject({ ok: true, canManage: false });
        const page = await inTx(tx => listProjectSourcesInTx(tx, member.id, { serverId, query: 'acme/repo', limit: 1 }));
        expect(page).toMatchObject({ ok: true, sources: [expect.objectContaining({ id: [first.id, second.id].sort()[0] })], coverage: { complete: false, nextCursor: expect.any(String) } });
        if (!page.ok || !page.coverage.nextCursor) return;
        expect(await inTx(tx => listProjectSourcesInTx(tx, member.id, { serverId, query: 'acme/repo', limit: 1, cursor: page.coverage.nextCursor }))).toMatchObject({ ok: true, sources: [expect.objectContaining({ id: [first.id, second.id].sort()[1] })], coverage: { complete: true, nextCursor: null } });
    });
    it('attaches independent exact documents under CAS without granting rights; detach and delete retain document bytes and grants', async () => {
        const [owner, recipient] = await Promise.all([account(), account()]);
        await makeShareEligibleForTest(owner.id, recipient.id);
        const row = await source(owner.id, [{ principal: { kind: 'account', accountId: recipient.id }, level: 'view' }]);
        async function artifact(kind = 'widget-area-layout.v1') {
            return db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, v: 1 })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'intact' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        }
        const [a, b, wrong] = await Promise.all([artifact(), artifact(), artifact('workflow-definition.v1')]);
        await db.artifactAccountGrant.create({ data: { artifactId: b.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const attach = (id: string, expectedRevision: number) => inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision, patch: { attachment: { kind: 'attach', attachment: { purpose: 'dashboard', ref: { kind: 'doc', artifactId: id } } } } }));
        const foreignAttachment = { purpose: 'dashboard', ref: { kind: 'doc', artifactId: wrong.id, serverId: 'foreign-home' } };
        const foreign = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: row.revision,
            patch: { attachment: { kind: 'attach', attachment: foreignAttachment } } }));
        expect(foreign).toMatchObject({ ok: true, source: { attachments: [foreignAttachment] } });
        if (!foreign.ok) return;
        // The foreign ref cannot substitute the local same-id workflow header; local admission still refuses it.
        expect(await attach(wrong.id, foreign.source.revision)).toEqual({ ok: false, error: 'artifact_wrong_kind' });
        const first = await attach(a.id, foreign.source.revision); expect(first.ok).toBe(true); if (!first.ok) return;
        expect(await attach(a.id, first.source.revision)).toEqual(first);
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: first.source.revision,
            patch: { attachment: { kind: 'attach', attachment: { purpose: 'dashboard', ref: { kind: 'doc', artifactId: a.id, serverId } } } } }))).toEqual(first);
        const foreignSameId = { purpose: 'dashboard', ref: { kind: 'doc', artifactId: a.id, serverId: 'foreign-home' } };
        const qualified = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: first.source.revision,
            patch: { attachment: { kind: 'attach', attachment: foreignSameId } } }));
        expect(qualified.ok).toBe(true); if (!qualified.ok) return;
        const second = await attach(b.id, qualified.source.revision); expect(second.ok).toBe(true); if (!second.ok) return;
        expect(await attach(a.id, row.revision)).toMatchObject({ ok: false, error: 'source_conflict', current: { revision: second.source.revision } });
        const detached = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: second.source.revision, patch: { attachment: { kind: 'detach', purpose: 'dashboard', ref: { kind: 'doc', artifactId: a.id } } } }));
        expect(detached.ok).toBe(true); if (!detached.ok) return;
        expect(detached.source.attachments).toEqual([foreignAttachment, foreignSameId, { purpose: 'dashboard', ref: { kind: 'doc', artifactId: b.id } }]);
        const foreignDetached = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: detached.source.revision,
            patch: { attachment: { kind: 'detach', purpose: 'dashboard', ref: foreignSameId.ref } } }));
        expect(foreignDetached).toMatchObject({ ok: true, source: { attachments: [foreignAttachment, { purpose: 'dashboard', ref: { kind: 'doc', artifactId: b.id } }] } });
        if (!foreignDetached.ok) return;
        expect(await db.artifactAccountGrant.count({ where: { artifactId: a.id } })).toBe(0);
        expect(await inTx(tx => deleteProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: foreignDetached.source.revision }))).toMatchObject({ ok: true });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: b.id } })).body).toEqual(b.body);
        expect(await db.artifactAccountGrant.count({ where: { artifactId: b.id } })).toBe(1);
    });
    it('reads stored nested extras canonically and drops them on write; malformed required fields refuse', async () => {
        const owner = await account(); const row = await source(owner.id);
        await db.projectSource.update({ where: { id: row.id }, data: { repository: { ...repository, repository: { ...repository.repository, future: true } } } });
        expect(await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id }))).toMatchObject({ ok: true, source: { repository } });
        const updated = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: row.revision, patch: { name: 'Canonical' } }));
        expect(updated.ok).toBe(true);
        expect((await db.projectSource.findUniqueOrThrow({ where: { id: row.id } })).repository).toEqual(repository);
        await db.projectSource.update({ where: { id: row.id }, data: { repository: { ...repository, repository: { ...repository.repository, nameWithOwner: null } } } });
        expect(await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id }))).toEqual({ ok: false, error: 'source_invalid' });
        expect(await inTx(tx => listProjectSourcesInTx(tx, owner.id, { serverId }))).toEqual({ ok: false, error: 'source_invalid' });
        const outsider = await account();
        expect(await inTx(tx => listProjectSourcesInTx(tx, outsider.id, { serverId }))).toMatchObject({ ok: true, sources: [], coverage: { complete: true } });
    });
    it('admits new context attachments only as system_append while retained placements remain editable', async () => {
        const owner = await account(); const row = await source(owner.id);
        const document = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', v: 2 })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'context' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        const entry = { id: 'context-one', ref: { kind: 'doc', artifactId: document.id }, enabled: true, placement: 'composer_insert' };
        const entryTwo = { ...entry, id: 'context-two', placement: 'system_append', required: true };
        const recipient = await account();
        const dashboardDocument = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'widget-area-layout.v1', v: 1 })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'dashboard' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        const dashboard = { purpose: 'dashboard', ref: { kind: 'doc', artifactId: dashboardDocument.id } };
        await db.artifactAccountGrant.create({ data: { artifactId: dashboardDocument.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: row.revision,
            patch: { attachment: { kind: 'attach', attachment: { purpose: 'context', entry } } } }))).toEqual({ ok: false, error: 'source_invalid' });
        await db.projectSource.update({ where: { id: row.id }, data: {
            audience: [{ principal: { kind: 'account', accountId: recipient.id }, level: 'view' }],
            attachments: [{ purpose: 'context', entry }, dashboard, { purpose: 'context', entry: entryTwo }],
        } });
        const budgeted = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: row.revision,
            patch: { attachment: { kind: 'budget', attachmentId: entry.id, maxChars: 200 } } }));
        expect(budgeted.ok).toBe(true); if (!budgeted.ok) return;
        expect(budgeted.source.attachments).toEqual([{ purpose: 'context', entry: { ...entry, maxChars: 200 } }, dashboard, { purpose: 'context', entry: entryTwo }]);
        const reordered = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: budgeted.source.revision,
            patch: { attachment: { kind: 'reorder', attachmentId: entryTwo.id, beforeId: entry.id } } }));
        expect(reordered.ok).toBe(true); if (!reordered.ok) return;
        expect(reordered.source.attachments).toEqual([{ purpose: 'context', entry: entryTwo }, { purpose: 'context', entry: { ...entry, maxChars: 200 } }, dashboard]);
        const cleared = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: reordered.source.revision,
            patch: { attachment: { kind: 'budget', attachmentId: entry.id, maxChars: null } } }));
        expect(cleared.ok).toBe(true); if (!cleared.ok) return;
        expect(cleared.source.attachments).toEqual([{ purpose: 'context', entry: entryTwo }, { purpose: 'context', entry }, dashboard]);
        const toggleInput = { serverId, sourceId: row.id, expectedRevision: cleared.source.revision,
            patch: { attachment: { kind: 'set_enabled', attachmentId: entry.id, enabled: false } } };
        expect(await inTx(tx => updateProjectSourceInTx(tx, recipient.id, toggleInput))).toEqual({ ok: false, error: 'source_access_denied' });
        const disabled = await inTx(tx => updateProjectSourceInTx(tx, owner.id, toggleInput));
        expect(disabled).toMatchObject({ ok: true, source: { attachments: [{ purpose: 'context', entry: entryTwo },
            { purpose: 'context', entry: { ...entry, enabled: false } }, dashboard] } });
        if (!disabled.ok) return;
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, toggleInput))).toMatchObject({ ok: false, error: 'source_conflict', current: { revision: disabled.source.revision } });
        const detached = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: disabled.source.revision,
            patch: { attachment: { kind: 'detach', purpose: 'context', attachmentId: entry.id } } }));
        expect(detached.ok).toBe(true); if (!detached.ok) return;
        expect(detached.source.attachments).toEqual([{ purpose: 'context', entry: entryTwo }, dashboard]);
        const added = await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: detached.source.revision,
            patch: { attachment: { kind: 'attach', attachment: { purpose: 'context', entry: { ...entryTwo, id: 'context-three' } } } } }));
        expect(added.ok).toBe(true); if (!added.ok) return;
        expect(added.source.attachments).toEqual([{ purpose: 'context', entry: entryTwo }, dashboard, { purpose: 'context', entry: { ...entryTwo, id: 'context-three' } }]);
        expect((await db.artifact.findUniqueOrThrow({ where: { id: document.id } })).body).toEqual(document.body);
        expect((await db.artifact.findUniqueOrThrow({ where: { id: dashboardDocument.id } })).body).toEqual(dashboardDocument.body);
        expect(await db.artifactAccountGrant.count({ where: { artifactId: dashboardDocument.id, accountId: recipient.id, accessLevel: 'view' } })).toBe(1);
        const unreadable = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: (await account()).id,
            header: document.header, body: document.body, dataEncryptionKey: document.dataEncryptionKey } });
        expect(await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: row.id, expectedRevision: added.source.revision,
            patch: { attachment: { kind: 'attach', attachment: { purpose: 'context', entry: { ...entry, id: 'new', placement: 'system_append', ref: { kind: 'doc', artifactId: unreadable.id } } } } } }))).toEqual({ ok: false, error: 'artifact_unavailable' });
    });
});
