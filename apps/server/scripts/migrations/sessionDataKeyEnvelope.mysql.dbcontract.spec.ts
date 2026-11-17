import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';
import { createDbMaintenanceClient } from '../../sources/storage/prisma';

// Only a dedicated test boundary may create this isolated database. Never fall
// back to DATABASE_URL, which can identify retained development/user data.
const testDatabaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL?.trim();
const mysqlTest = testDatabaseUrl ? it : it.skip;
// The canonical shipped MySQL migration is the subject: MySQL is the provider
// whose non-transactional DDL makes the ordered expand/verify/contract boundary
// load-bearing, so a drifted copy would prove the wrong bytes.
const mysqlMigrationsDir = join(import.meta.dirname, '..', '..', 'prisma', 'mysql', 'migrations');
const migrationSql = (phase: 'expand' | 'contract') => readFile(
    join(
        mysqlMigrationsDir,
        phase === 'expand'
            ? '20260906160000_expand_session_data_key_envelopes'
            : '20260906160100_contract_session_data_key_envelopes',
        'migration.sql',
    ),
    'utf8',
);

describe('canonical Session envelope MySQL migration', () => {
    mysqlTest('preserves binary legacy data and fails closed on conflicting owner/self-share bytes', async () => {
        const databaseName = `session_envelope_${randomUUID().replaceAll('-', '')}`;
        const admin = await createDbMaintenanceClient('mysql', testDatabaseUrl);
        const targetUrl = new URL(testDatabaseUrl!);
        targetUrl.pathname = `/${databaseName}`;
        const database = await createDbMaintenanceClient('mysql', targetUrl.toString());
        const execute = async (sql: string) => {
            for (const statement of splitMigrationStatements(sql)) {
                await database.$executeRawUnsafe(statement);
            }
        };
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${databaseName}\``);
            // Relevant physical byte/identifier types from immutable server-v0.2.11
            // 98ea8fb76733b1dd785d38c31360179cafa84824, after plaintext sharing expansion.
            await execute(`
                CREATE TABLE Account (id VARCHAR(191) PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE Session (id VARCHAR(191) PRIMARY KEY, accountId VARCHAR(191) NOT NULL, dataEncryptionKey LONGBLOB NULL, FOREIGN KEY(accountId) REFERENCES Account(id)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE SessionShare (sessionId VARCHAR(191) NOT NULL, sharedWithUserId VARCHAR(191) NOT NULL, encryptedDataKey LONGBLOB NULL, PRIMARY KEY(sessionId, sharedWithUserId), FOREIGN KEY(sessionId) REFERENCES Session(id) ON DELETE CASCADE, FOREIGN KEY(sharedWithUserId) REFERENCES Account(id)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE PublicSessionShare (encryptedDataKey LONGBLOB NULL);
                INSERT INTO Account VALUES ('owner'), ('recipient');
                INSERT INTO Session VALUES ('archived', 'owner', X'00ff0080'), ('legacy-null', 'owner', NULL), ('empty', 'owner', X'');
                INSERT INTO SessionShare VALUES ('archived', 'owner', X'00ff0080'), ('archived', 'recipient', X'ff00010280'), ('legacy-null', 'recipient', NULL);
                INSERT INTO PublicSessionShare VALUES (X'deadbeef');
            `);
            await execute(await migrationSql('expand'));
            expect(await database.$queryRawUnsafe(`SELECT sessionId, recipientAccountId, LOWER(HEX(encryptedDataKey)) AS bytes FROM SessionDataKeyEnvelope ORDER BY sessionId, recipientAccountId`)).toEqual([
                { sessionId: 'archived', recipientAccountId: 'owner', bytes: '00ff0080' },
                { sessionId: 'archived', recipientAccountId: 'recipient', bytes: 'ff00010280' },
                { sessionId: 'empty', recipientAccountId: 'owner', bytes: '' },
            ]);
            await execute(await migrationSql('contract'));
            expect(await database.$queryRawUnsafe(`SELECT LOWER(HEX(encryptedDataKey)) AS bytes FROM PublicSessionShare`)).toEqual([{ bytes: 'deadbeef' }]);
            await expect(database.$executeRawUnsafe(`INSERT INTO SessionDataKeyEnvelope VALUES ('archived', 'recipient', X'01')`)).rejects.toThrow();
            await database.$executeRawUnsafe(`DELETE FROM SessionShare WHERE sharedWithUserId = 'recipient'`);
            await database.$executeRawUnsafe(`DELETE FROM Account WHERE id = 'recipient'`);
            expect(await database.$queryRawUnsafe(`SELECT recipientAccountId FROM SessionDataKeyEnvelope WHERE sessionId = 'archived'`)).toEqual([{ recipientAccountId: 'owner' }]);
            await database.$executeRawUnsafe(`DELETE FROM Session WHERE id = 'archived'`);
            expect(await database.$queryRawUnsafe(`SELECT sessionId FROM SessionDataKeyEnvelope`)).toEqual([{ sessionId: 'empty' }]);
            await execute(`
                DROP TABLE SessionDataKeyEnvelope;
                ALTER TABLE Session ADD COLUMN dataEncryptionKey LONGBLOB NULL;
                ALTER TABLE SessionShare ADD COLUMN encryptedDataKey LONGBLOB NULL;
                INSERT INTO Session VALUES ('conflict', 'owner', X'00ff');
                INSERT INTO SessionShare VALUES ('conflict', 'owner', X'ff00');
            `);
            await expect(execute(await migrationSql('expand'))).rejects.toThrow(/session_envelope_conflicting_legacy_bytes/i);
            expect(await database.$queryRawUnsafe(`SELECT LOWER(HEX(dataEncryptionKey)) AS bytes FROM Session WHERE id = 'conflict'`)).toEqual([{ bytes: '00ff' }]);
        } finally {
            await database.$disconnect();
            await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${databaseName}\``);
            await admin.$disconnect();
        }
    }, 120_000);
});
