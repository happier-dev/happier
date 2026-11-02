import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { deploymentParentIdentitySql, deploymentS0Migrations, deploymentTargetLinkIdentityMigration,
    seedDeploymentS0Rows, readDeploymentS0Custody, assertDeploymentTargetIdentityArms } from './deploymentTargetLinkMigration.testkit';
import { assertDeploymentPendingContent, deploymentPendingContentMigration } from './deploymentPendingMigration.testkit';
import { assertDeploymentAcceptedExecutionUpgrade, deploymentAcceptedExecutionMigration } from './deploymentAcceptedExecutionMigration.testkit';
import { assertDeploymentDomainStorage, deploymentDomainMigration } from './deploymentDomainMigration.testkit';

const serverRoot = join(import.meta.dirname, '../..');

describe('deployment migration relational custody', () => {
    it.each(['sqlite', 'postgres'] as const)('retains Domain custody without exposing route content on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const database = {
            execute: async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); },
            query: async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const migrations = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            await database.execute(deploymentParentIdentitySql(provider));
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const name of deploymentS0Migrations) await database.execute(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
            await seedDeploymentS0Rows(provider, database);
            const retained = await readDeploymentS0Custody(provider, database);
            const sql = await readFile(join(migrations, deploymentDomainMigration, 'migration.sql'), 'utf8')
                .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
            if (sql) await database.execute(sql);
            expect(await assertDeploymentDomainStorage(provider, database)).toHaveLength(6);
            expect(await readDeploymentS0Custody(provider, database)).toEqual(retained);
            if (sqlite) {
                expect(await database.query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await database.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);

    it.each(['sqlite', 'postgres'] as const)('adds nullable accepted identities without fabricating historical capture on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const db = {
            execute: async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); },
            query: async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const migrations = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            await db.execute(deploymentParentIdentitySql(provider));
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const name of deploymentS0Migrations) await db.execute(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
            await seedDeploymentS0Rows(provider, db);
            const retained = await readDeploymentS0Custody(provider, db);
            await db.execute(await readFile(join(migrations, deploymentAcceptedExecutionMigration, 'migration.sql'), 'utf8'));
            await assertDeploymentAcceptedExecutionUpgrade(provider, db);
            expect(await readDeploymentS0Custody(provider, db)).toEqual(retained);
            if (sqlite) {
                expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);
    it.each(['sqlite', 'postgres'] as const)('adds exact chosen deployer references without changing retained custody on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const db = {
            execute: async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); },
            query: async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const migrations = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            await db.execute(deploymentParentIdentitySql(provider));
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const name of deploymentS0Migrations) await db.execute(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
            await seedDeploymentS0Rows(provider, db);
            const retained = await readDeploymentS0Custody(provider, db);
            const sql = await readFile(join(migrations, '20261028184500_add_deployment_environment_deployer', 'migration.sql'), 'utf8')
                .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
            if (sql) await db.execute(sql);
            // Missing storage fails on inserting the valid approved relation, not on a missing migration filename.
            const insert = (kind: string, principalId: string, environmentId = 'environment', creator = 'owner') => db.execute(
                `INSERT INTO "DeploymentEnvironmentDeployer" ("environmentId","principalKind","principalId","createdByAccountId")
                    VALUES ('${environmentId}','${kind}','${principalId}','${creator}')`);
            await insert('account', 'same-id');
            await insert('teamGroup', 'same-id');
            expect(await db.query('SELECT "principalKind","principalId","createdByAccountId" FROM "DeploymentEnvironmentDeployer" ORDER BY "principalKind"'))
                .toEqual([{ principalKind: 'account', principalId: 'same-id', createdByAccountId: 'owner' },
                    { principalKind: 'teamGroup', principalId: 'same-id', createdByAccountId: 'owner' }]);
            await expect(insert('account', 'same-id')).rejects.toThrow();
            await expect(insert('team', 'not-a-chosen-principal')).rejects.toThrow();
            await expect(insert('account', 'foreign-environment', 'missing')).rejects.toThrow();
            await expect(insert('account', 'foreign-creator', 'environment', 'missing')).rejects.toThrow();
            expect(await readDeploymentS0Custody(provider, db)).toEqual(retained);
            if (sqlite) {
                expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);

    it.each(['sqlite', 'postgres'] as const)('adds nullable private pending envelopes without changing retained S0 custody on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const db = {
            execute: async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); },
            query: async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const migrations = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            await db.execute(deploymentParentIdentitySql(provider));
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const name of deploymentS0Migrations) await db.execute(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
            await seedDeploymentS0Rows(provider, db);
            const original = await readDeploymentS0Custody(provider, db);
            const sql = await readFile(join(migrations, deploymentPendingContentMigration, 'migration.sql'), 'utf8')
                .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
            if (sql) await db.execute(sql);
            // A missing migration must fail at the real missing-column contract.
            await assertDeploymentPendingContent(provider, db);
            expect(await readDeploymentS0Custody(provider, db)).toEqual(original);
            if (sqlite) {
                expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);
    it.each(['sqlite', 'postgres'] as const)('widens host/plugin identities while retaining S0 rows and cyclic custody on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const db = {
            execute: async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); },
            query: async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query<Record<string, unknown>>(sql)).rows,
        };
        const migrations = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            await db.execute(deploymentParentIdentitySql(provider));
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const name of deploymentS0Migrations) await db.execute(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
            await seedDeploymentS0Rows(provider, db);
            const retained = await readDeploymentS0Custody(provider, db);
            // Missing widening intentionally leaves the real S0 database contract
            // active: RED must be refusal of a valid plugin arm, not a missing file.
            const widening = await readFile(join(migrations, deploymentTargetLinkIdentityMigration, 'migration.sql'), 'utf8')
                .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
            if (widening) await db.execute(widening);
            expect(await readDeploymentS0Custody(provider, db)).toEqual(retained);
            await assertDeploymentTargetIdentityArms(provider, db);
            if (sqlite) {
                expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);
    it.each(['sqlite', 'postgres'] as const)('preserves ordered membership, private receipt references and restrictive custody on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        const migrationRoot = join(serverRoot, provider === 'sqlite' ? 'prisma/sqlite/migrations' : 'prisma/migrations');
        try {
            // Only parent identities cross this migration boundary. Their other
            // columns and admission semantics belong to the Source/Artifact tests.
            await execute(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "ProjectSource" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Artifact" ("id" TEXT PRIMARY KEY);`);
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            for (const migration of ['20261024140000_add_deployment_model', '20261027072000_add_deployment_machine_references']) {
                await execute(await readFile(join(migrationRoot, migration, 'migration.sql'), 'utf8'));
            }
            await execute(`INSERT INTO "Account" VALUES ('owner');
                INSERT INTO "ProjectSource" VALUES ('source');
                INSERT INTO "Machine" VALUES ('runtime-a'),('runtime-b'),('builder'),('edge');
                INSERT INTO "Artifact" VALUES ('private-environment'),('private-link'),('private-receipt');
                INSERT INTO "DeploymentEnvironment" ("id","projectSourceId","createdByAccountId","protection","purpose","deployerMode",
                    "controllerMachineId","buildMachineId","edgeMachineId","contentArtifactId","contentHeaderVersion","contentBodyVersion","updatedAt")
                    VALUES ('environment','source','owner','production','standard','managers','runtime-a','builder','edge','private-environment',1,1,CURRENT_TIMESTAMP);
                INSERT INTO "DeploymentTargetLink" ("id","environmentId","role","sourceKind","hostTargetId","targetKind","state",
                    "contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt")
                    VALUES ('runtime','environment','runtime','host','own-server','ownServer','configured','private-link',1,1,'owner',CURRENT_TIMESTAMP);
                INSERT INTO "DeploymentTargetLinkMachine" ("targetLinkId","machineId","position","installationId","state")
                    VALUES ('runtime','runtime-b',0,'installation-b','joining'),('runtime','runtime-a',1,'installation-a','active');
                UPDATE "DeploymentEnvironment" SET "runtimeTargetLinkId"='runtime' WHERE "id"='environment';
                INSERT INTO "Deployment" ("id","environmentId","targetLinkId","operation","state","requestKey","requestedByAccountId",
                    "actionOperationId","contentArtifactId","contentHeaderVersion","contentBodyVersion")
                    VALUES ('receipt','environment','runtime','deploy','queued','request','owner','operation','private-receipt',1,1);`);
            expect(await query('SELECT "machineId","position","state" FROM "DeploymentTargetLinkMachine" ORDER BY "position"')).toEqual([
                { machineId: 'runtime-b', position: 0, state: 'joining' }, { machineId: 'runtime-a', position: 1, state: 'active' },
            ]);
            await expect(execute(`INSERT INTO "DeploymentTargetLinkMachine" VALUES ('runtime','runtime-a',2,'other','joining')`)).rejects.toThrow();
            await expect(execute(`INSERT INTO "DeploymentTargetLinkMachine" VALUES ('runtime','builder',0,'other','joining')`)).rejects.toThrow();
            await expect(execute(`INSERT INTO "DeploymentTargetLinkMachine" VALUES ('runtime','missing',2,'other','joining')`)).rejects.toThrow();
            await expect(execute(`UPDATE "DeploymentEnvironment" SET "edgeMachineId"='missing' WHERE "id"='environment'`)).rejects.toThrow();
            await expect(execute(`INSERT INTO "Deployment" ("id","environmentId","targetLinkId","operation","state","requestKey","requestedByAccountId",
                "actionOperationId","contentArtifactId","contentHeaderVersion","contentBodyVersion")
                VALUES ('duplicate','environment','runtime','rollback','queued','request','owner','another-operation','private-receipt',1,1)`)).rejects.toThrow();
            for (const [table, id] of [['Machine', 'runtime-a'], ['Machine', 'runtime-b'], ['Machine', 'builder'], ['Machine', 'edge'],
                ['ProjectSource', 'source'], ['Artifact', 'private-receipt'], ['DeploymentTargetLink', 'runtime']] as const) {
                await expect(execute(`DELETE FROM "${table}" WHERE "id"='${id}'`)).rejects.toThrow();
            }
            await execute(`UPDATE "DeploymentTargetLink" SET "detachedAt"=CURRENT_TIMESTAMP WHERE "id"='runtime'`);
            expect(await query('SELECT "machineId" FROM "DeploymentTargetLinkMachine" ORDER BY "position"'))
                .toEqual([{ machineId: 'runtime-b' }, { machineId: 'runtime-a' }]);
            const columns = sqlite ? sqlite.prepare('PRAGMA table_info("Deployment")').all().map(row => row.name)
                : (await postgres!.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='Deployment'`)).rows.map(row => row.column_name);
            expect(columns).toContain('contentArtifactId');
            for (const privateColumn of ['sha', 'imageDigest', 'machineResults', 'providerAccountId', 'providerResourceId', 'providerComparisonKey', 'teamId']) {
                expect(columns).not.toContain(privateColumn);
            }
            if (sqlite) {
                expect(await query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    }, 60_000);
});
