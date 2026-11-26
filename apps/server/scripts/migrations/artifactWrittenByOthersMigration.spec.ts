import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrationName = '20261126100100_artifact_written_by_others';

describe('Artifact written-by-others upgrade', () => {
    it.each(['sqlite', 'postgres'] as const)('keeps existing rows unmarked and lets the writer set the mark on %s', async provider => {
        const sqlite = provider === 'sqlite' ? new DatabaseSync(':memory:') : null;
        const postgres = provider === 'postgres' ? new PGlite() : null;
        const execute = async (sql: string) => { if (sqlite) sqlite.exec(sql); else await postgres!.exec(sql); };
        const rows = async (sql: string) => sqlite ? sqlite.prepare(sql).all()
            : (await postgres!.query<Record<string, unknown>>(sql)).rows;
        try {
            // The server has no earlier record of who wrote existing content, so the upgrade marks nothing.
            await execute(`CREATE TABLE "Artifact" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);
                INSERT INTO "Artifact" VALUES ('existing', 'owner');`);
            await execute(await readFile(join(import.meta.dirname, '../../prisma',
                provider === 'sqlite' ? 'sqlite/migrations' : 'migrations', migrationName, 'migration.sql'), 'utf8'));
            await execute(`INSERT INTO "Artifact" ("id", "accountId") VALUES ('created', 'owner');
                UPDATE "Artifact" SET "writtenByOthers" = true WHERE "id" = 'created';`);
            const marks = await rows('SELECT "id", "writtenByOthers" FROM "Artifact" ORDER BY "id"');
            expect(marks.map(row => ({ id: row.id, writtenByOthers: Boolean(row.writtenByOthers) }))).toEqual([
                { id: 'created', writtenByOthers: true }, { id: 'existing', writtenByOthers: false },
            ]);
        } finally {
            sqlite?.close();
            await postgres?.close();
        }
    });
});
