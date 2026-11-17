import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';
import { mentionMigrationId, mentionMigrationFixtures, migratedMentionParts } from './discussionMentionMigration.testkit';
import { createDbMaintenanceClient } from '../../sources/storage/prisma';

// The disposable fixture runner is the only database authority; no retained URL fallback.
const testDatabaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL?.trim();
describe('Plain Discussion Account mention forward migration on MySQL', () => {
    (testDatabaseUrl ? it : it.skip)('preserves ordered content, opaque neighbors and retry identity', async () => {
        const name = `discussion_mentions_${randomUUID().replaceAll('-', '')}`;
        const admin = await createDbMaintenanceClient('mysql', testDatabaseUrl);
        const target = new URL(testDatabaseUrl!);
        target.pathname = `/${name}`;
        const database = await createDbMaintenanceClient('mysql', target.toString());
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\``);
            created = true;
            await database.$executeRawUnsafe(`CREATE TABLE DiscussionMessage (id VARCHAR(191) PRIMARY KEY,
                localId VARCHAR(191) NOT NULL, seq INTEGER NOT NULL, authorAccountId VARCHAR(191),
                requestEqualityEvidenceV1 JSON NOT NULL, content JSON NOT NULL)`);
            for (const [index, fixture] of mentionMigrationFixtures.entries()) {
                await database.$executeRawUnsafe(`INSERT INTO DiscussionMessage VALUES (?, ?, ?, ?, ?, ?)`, fixture.id,
                    `retry-${fixture.id}`, index + 1, 'author', JSON.stringify({ tag: 'retained-equality' }), JSON.stringify(fixture.content));
            }
            const rows = () => database.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM DiscussionMessage ORDER BY id');
            const before = await rows();
            const statements = splitMigrationStatements(await readFile(resolve(process.cwd(), 'prisma/mysql/migrations', mentionMigrationId, 'migration.sql'), 'utf8'));
            for (const statement of statements) await database.$executeRawUnsafe(statement);
            const after = await rows();
            expect(after).toEqual(before.map(row => row.id === 'legacy'
                ? { ...row, content: { t: 'plain', v: { v: 1, parts: migratedMentionParts } } } : row));
            for (const statement of statements) await database.$executeRawUnsafe(statement);
            expect(await rows()).toEqual(after);
        } finally {
            await database.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${name}\``);
            await admin.$disconnect();
        }
    });
});
