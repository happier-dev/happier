import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migrationName = '20261111180000_session_external_identity_tag';
const migration = async (provider: 'sqlite' | 'postgres' | 'mysql') => readFile(new URL(
    `../../../../prisma/${provider === 'postgres' ? '' : `${provider}/`}migrations/${migrationName}/migration.sql`, import.meta.url), 'utf8');

const DIRECT_A = `direct:v1:${'a'.repeat(64)}`;
const DIRECT_B = `direct:v1:${'b'.repeat(64)}`;
// Pre-migration Session shape reduced to the columns and unique key this migration reads.
const preMigrationRows = [
    ['direct-owner', 'owner', DIRECT_A],
    ['direct-other-account', 'other', DIRECT_A],
    ['direct-owner-second', 'owner', DIRECT_B],
    ['hosted-owner', 'owner', 'hosted-launch-tag'],
] as const;

it('backfills direct:v1 creation tags into the Account-unique external identity on SQLite', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "tag" TEXT NOT NULL);
            CREATE UNIQUE INDEX "Session_accountId_tag_key" ON "Session"("accountId", "tag");`);
        for (const row of preMigrationRows) db.prepare('INSERT INTO "Session" VALUES (?, ?, ?)').run(...row);

        db.exec(await migration('sqlite'));

        expect(db.prepare('SELECT "id", "externalIdentityTag" FROM "Session" ORDER BY "id"').all()).toEqual([
            { id: 'direct-other-account', externalIdentityTag: DIRECT_A },
            { id: 'direct-owner', externalIdentityTag: DIRECT_A },
            { id: 'direct-owner-second', externalIdentityTag: DIRECT_B },
            { id: 'hosted-owner', externalIdentityTag: null },
        ]);
        const index = db.prepare('PRAGMA index_list("Session")').all()
            .find((row) => row.name === 'Session_accountId_externalIdentityTag_key') as { unique: number } | undefined;
        expect(index?.unique).toBe(1);
        expect(() => db.exec(`UPDATE "Session" SET "externalIdentityTag" = '${DIRECT_A}' WHERE "id" = 'hosted-owner'`)).toThrow();
    } finally { db.close(); }
});

it('backfills identically on PostgreSQL and keeps MySQL on the same index name and column width', async () => {
    const db = new PGlite();
    try {
        await db.exec(`CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "tag" TEXT NOT NULL);
            CREATE UNIQUE INDEX "Session_accountId_tag_key" ON "Session"("accountId", "tag");`);
        for (const row of preMigrationRows) await db.query('INSERT INTO "Session" VALUES ($1, $2, $3)', [...row]);

        await db.exec(await migration('postgres'));

        expect((await db.query('SELECT "id", "externalIdentityTag" FROM "Session" ORDER BY "id"')).rows).toEqual([
            { id: 'direct-other-account', externalIdentityTag: DIRECT_A },
            { id: 'direct-owner', externalIdentityTag: DIRECT_A },
            { id: 'direct-owner-second', externalIdentityTag: DIRECT_B },
            { id: 'hosted-owner', externalIdentityTag: null },
        ]);
        await expect(db.exec(`UPDATE "Session" SET "externalIdentityTag" = '${DIRECT_A}' WHERE "id" = 'hosted-owner'`)).rejects.toThrow();
    } finally { await db.close(); }

    const mysql = await migration('mysql');
    expect(mysql).toContain('ADD COLUMN `externalIdentityTag` VARCHAR(191) NULL');
    expect(mysql).toContain("WHERE `tag` LIKE 'direct:v1:%'");
    expect(mysql).toContain('CREATE UNIQUE INDEX `Session_accountId_externalIdentityTag_key` ON `Session`(`accountId`, `externalIdentityTag`)');
});
