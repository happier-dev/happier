import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

describe('Automation Environment provenance migration', () => {
    it.each(['sqlite', 'postgres'] as const)('adds closed preview roles and live child identity without changing retained jobs on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        try {
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            await execute(`CREATE TABLE "ProjectSource" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "DeploymentTargetLink" ("id" TEXT PRIMARY KEY);
                INSERT INTO "ProjectSource" VALUES ('source');
                INSERT INTO "DeploymentTargetLink" VALUES ('link');
                CREATE TABLE "DeploymentEnvironment" ("id" TEXT PRIMARY KEY, "purpose" TEXT NOT NULL, "deletedAt" TIMESTAMP);
                CREATE TABLE "Automation" ("id" TEXT PRIMARY KEY, "deploymentEnvironmentId" TEXT, "templateCiphertext" TEXT NOT NULL);
                INSERT INTO "DeploymentEnvironment" VALUES ('template', 'standard', NULL);
                INSERT INTO "Automation" VALUES ('retained', NULL, 'opaque-private-content');`);
            const migration = fileURLToPath(new URL(`../../../prisma/${provider === 'postgres' ? '' : 'sqlite/'}migrations/20261029054500_add_deployment_preview_relations/migration.sql`, import.meta.url));
            await execute(await readFile(migration, 'utf8'));
            expect(await query('SELECT * FROM "Automation"')).toEqual([{ id: 'retained', deploymentEnvironmentId: null,
                templateCiphertext: 'opaque-private-content', deploymentPreviewRole: null }]);
            for (const role of ['preview_admission', 'preview_cleanup']) {
                await execute(`UPDATE "Automation" SET "deploymentEnvironmentId"='template', "deploymentPreviewRole"='${role}'`);
                expect(await query('SELECT "deploymentPreviewRole" FROM "Automation"')).toEqual([{ deploymentPreviewRole: role }]);
            }
            await expect(execute(`UPDATE "Automation" SET "deploymentPreviewRole"='other'`)).rejects.toThrow();
            await expect(execute(`UPDATE "DeploymentEnvironment" SET "previewRepositoryId"='source' WHERE "id"='template'`)).rejects.toThrow();
            await expect(execute(`INSERT INTO "DeploymentEnvironment" ("id", "purpose") VALUES ('incomplete', 'preview')`)).rejects.toThrow();
            const insertChild = (id: string) => execute(`INSERT INTO "DeploymentEnvironment" ("id", "purpose", "previewTemplateEnvironmentId",
                "previewRepositoryId", "previewPullRequestId", "previewTargetLinkId") VALUES ('${id}', 'preview', 'template', 'source', 'pr', 'link')`);
            await insertChild('child');
            await expect(insertChild('duplicate')).rejects.toThrow();
            await expect(execute(`UPDATE "DeploymentEnvironment" SET "previewTemplateEnvironmentId"='missing' WHERE "id"='child'`)).rejects.toThrow();
            await expect(execute(`UPDATE "DeploymentEnvironment" SET "previewRepositoryId"='missing' WHERE "id"='child'`)).rejects.toThrow();
            await expect(execute(`UPDATE "DeploymentEnvironment" SET "previewTargetLinkId"='missing' WHERE "id"='child'`)).rejects.toThrow();
            await expect(execute(`DELETE FROM "DeploymentEnvironment" WHERE "id"='template'`)).rejects.toThrow();
            await execute(`UPDATE "DeploymentEnvironment" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "id"='child'`);
            await insertChild('replacement');
            expect(await query('SELECT "id" FROM "DeploymentEnvironment" WHERE "purpose"=\'preview\' AND "deletedAt" IS NULL'))
                .toEqual([{ id: 'replacement' }]);
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);
    it.each(['sqlite', 'postgres'] as const)('retains existing private recipes and enforces the Environment FK on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const query = async (sql: string) => sqlite ? sqlite.prepare(sql).all() : (await postgres!.query(sql)).rows;
        try {
            // Only the exact structural columns touched by this additive migration cross this boundary.
            await execute(`CREATE TABLE "DeploymentEnvironment" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Automation" ("id" TEXT PRIMARY KEY, "templateCiphertext" TEXT NOT NULL,
                    "templateVersion" INTEGER NOT NULL, "deletedAt" TIMESTAMP);
                INSERT INTO "DeploymentEnvironment" VALUES ('environment');
                INSERT INTO "Automation" VALUES ('retained', 'opaque-existing-private-recipe', 17, NULL);`);
            if (sqlite) sqlite.exec('PRAGMA foreign_keys=ON');
            const before = await query('SELECT "id","templateCiphertext","templateVersion","deletedAt" FROM "Automation"');
            const migration = fileURLToPath(new URL(`../../../prisma/${provider === 'postgres' ? '' : 'sqlite/'}migrations/20261028183000_add_automation_deployment_environment/migration.sql`, import.meta.url));
            const sql = await readFile(migration, 'utf8').catch((error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return '';
                throw error;
            });
            if (sql) await execute(sql);
            expect(await query('SELECT "deploymentEnvironmentId" FROM "Automation"')).toEqual([{ deploymentEnvironmentId: null }]);
            expect(await query('SELECT "id","templateCiphertext","templateVersion","deletedAt" FROM "Automation"')).toEqual(before);
            await execute(`UPDATE "Automation" SET "deploymentEnvironmentId"='environment' WHERE "id"='retained'`);
            await expect(execute(`UPDATE "Automation" SET "deploymentEnvironmentId"='missing' WHERE "id"='retained'`)).rejects.toThrow();
            await expect(execute(`DELETE FROM "DeploymentEnvironment" WHERE "id"='environment'`)).rejects.toThrow();
            await execute(`UPDATE "DeploymentEnvironment" SET "id"='renamed' WHERE "id"='environment'`);
            expect(await query('SELECT "deploymentEnvironmentId" FROM "Automation"')).toEqual([{ deploymentEnvironmentId: 'renamed' }]);
            if (sqlite) {
                expect(await query('PRAGMA foreign_key_check')).toEqual([]);
                expect(await query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            }
        } finally { sqlite?.close(); await postgres?.close(); }
    }, 60_000);
});
