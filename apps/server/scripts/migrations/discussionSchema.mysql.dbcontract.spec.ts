import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PrismaClient } from '../../generated/mysql-client/index.js';
import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';

// A dedicated contract runner owns this boundary; never select retained data
// from the ordinary DATABASE_URL as a fallback.
const testDatabaseUrl = process.env.HAPPIER_TEST_MYSQL_DATABASE_URL?.trim();

describe('Discussion MySQL migration', () => {
    (testDatabaseUrl ? it : it.skip)('preserves plain and encrypted history without inventing legacy keys', async () => {
        const name = `discussion_${randomUUID().replaceAll('-', '')}`;
        const admin = new PrismaClient({ datasourceUrl: testDatabaseUrl });
        const target = new URL(testDatabaseUrl!);
        target.pathname = `/${name}`;
        // Match the migration executor's single connection at this real boundary.
        target.searchParams.set('connection_limit', '1');
        const database = new PrismaClient({ datasourceUrl: target.toString() });
        const execute = async (sql: string) => {
            for (const statement of splitMigrationStatements(sql)) await database.$executeRawUnsafe(statement);
        };
        const migrationRoot = resolve(process.cwd(), 'prisma/mysql/migrations');
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            created = true;
            await execute(`
                CREATE TABLE Account (id VARCHAR(191) PRIMARY KEY, encryptionMode VARCHAR(191) NOT NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE Session (id VARCHAR(191) PRIMARY KEY, accountId VARCHAR(191) NOT NULL, encryptionMode VARCHAR(191) NOT NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE Team (id VARCHAR(191) PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE TeamGroup (id VARCHAR(191) PRIMARY KEY) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                CREATE TABLE SessionShare (sessionId VARCHAR(191), sharedByUserId VARCHAR(191), sharedWithUserId VARCHAR(191), accessLevel ENUM('view', 'edit', 'admin'), createdAt DATETIME(3));
                CREATE TABLE SessionTeamGrant (sessionId VARCHAR(191), teamId VARCHAR(191), effectiveAt DATETIME(3) NOT NULL DEFAULT '2026-10-18');
                CREATE TABLE SessionGroupGrant (sessionId VARCHAR(191), teamGroupId VARCHAR(191), effectiveAt DATETIME(3) NOT NULL DEFAULT '2026-10-18');
                INSERT INTO Account VALUES ('owner', 'plain'), ('author', 'plain'), ('invitee', 'plain');
                INSERT INTO Session VALUES ('source', 'owner', 'plain');
            `);
            await execute(await readFile(resolve(migrationRoot, '20260905220000_add_session_discussions/migration.sql'), 'utf8'));
            await execute(`
                INSERT INTO SessionDiscussion (id, sessionId, creationLocalId, creationEqualityEvidenceV1, createdByAccountId, titleContent, messageSeq, lastMessageAt, createdAt, updatedAt)
                VALUES ('discussion', 'source', 'create-retry', '{"kind":"plainDigest","digest":"preserve"}', 'author', '{"t":"plain","v":{"v":1,"title":"Keep title"}}', 1, '2026-10-18', '2026-10-18', '2026-10-18');
                INSERT INTO SessionDiscussionMessage VALUES ('message', 'source', 'discussion', 'post-retry', '{"kind":"plainDigest","digest":"preserve"}', 1, 'author', NULL, '{"t":"plain","v":{"v":1,"parts":[{"t":"text","text":"Keep message"}]}}', '2026-10-18');
                INSERT INTO SessionDiscussionMessageMention VALUES ('message', 'invitee', '2026-10-18');
                INSERT INTO SessionDiscussionReadState VALUES ('discussion', 'owner', 1, '2026-10-18');
                INSERT INTO SessionShare VALUES ('source', 'owner', 'invitee', 'edit', '2026-10-18');
                INSERT INTO Account VALUES ('encrypted-owner', 'e2ee');
                INSERT INTO Session VALUES ('encrypted-source', 'encrypted-owner', 'e2ee');
                INSERT INTO SessionDiscussion (id, sessionId, creationLocalId, creationEqualityEvidenceV1, createdByAccountId, titleContent, messageSeq, lastMessageAt, createdAt, updatedAt)
                VALUES ('encrypted-discussion', 'encrypted-source', 'encrypted-retry', '{"kind":"e2eeTag","tag":"opaque-create-tag"}', 'encrypted-owner', '{"t":"encrypted","c":"opaque-session-key-title"}', 1, '2026-10-18', '2026-10-18', '2026-10-18');
                INSERT INTO SessionDiscussionMessage VALUES ('encrypted-message', 'encrypted-source', 'encrypted-discussion', 'encrypted-post', '{"kind":"e2eeTag","tag":"opaque-message-tag"}', 1, 'encrypted-owner', NULL, '{"t":"encrypted","c":"opaque-session-key-message"}', '2026-10-18');
                INSERT INTO Session VALUES ('collision-source', 'owner', 'plain');
                INSERT INTO SessionDiscussion SELECT fixture.id, 'collision-source', fixture.retry,
                    d.creationEqualityEvidenceV1, d.createdByAccountId, d.titleContent, 0, d.lastMessageAt, d.archivedAt,
                    d.createdAt, d.updatedAt FROM SessionDiscussion d CROSS JOIN (
                        SELECT 'other-discussion' AS id, 'create-retry' AS retry UNION ALL SELECT 'chain-one', 'discussion'
                        UNION ALL SELECT 'chain-two', 'chain-one' UNION ALL SELECT 'unaffected', 'keep-retry'
                    ) fixture WHERE d.id = 'discussion';
                INSERT INTO SessionTeamGrant (sessionId, teamId) VALUES ('source', 'team');
                INSERT INTO SessionGroupGrant (sessionId, teamGroupId) VALUES ('source', 'group');
                SET SESSION cte_max_recursion_depth = 1;
            `);
            const sql = await readFile(resolve(migrationRoot, '20261018120000_first_class_discussions/migration.sql'), 'utf8');
            const teamGrants = await database.$queryRawUnsafe('SELECT * FROM SessionTeamGrant');
            const groupGrants = await database.$queryRawUnsafe('SELECT * FROM SessionGroupGrant');
            await execute(sql);
            expect(await database.$queryRawUnsafe('SELECT CAST(@@SESSION.cte_max_recursion_depth AS CHAR) AS depth')).toEqual([{ depth: '1' }]);
            expect(await database.$queryRawUnsafe("SELECT id, creationLocalId FROM Discussion WHERE createdByAccountId='author' ORDER BY id"))
                .toEqual([{ id: 'chain-one', creationLocalId: 'chain-one' }, { id: 'chain-two', creationLocalId: 'chain-two' },
                    { id: 'discussion', creationLocalId: 'discussion' }, { id: 'other-discussion', creationLocalId: 'other-discussion' },
                    { id: 'unaffected', creationLocalId: 'keep-retry' }]);
            expect(await database.$queryRawUnsafe("SELECT DISTINCT createdByAccountId, creationEqualityEvidenceV1, titleContent FROM Discussion WHERE createdByAccountId='author'"))
                .toEqual([{ createdByAccountId: 'author', creationEqualityEvidenceV1: { kind: 'plainDigest', digest: 'preserve' },
                    titleContent: { t: 'plain', v: { v: 1, title: 'Keep title' } } }]);
            expect(await database.$queryRawUnsafe('SELECT * FROM DiscussionTeamGrant')).toEqual([]);
            expect(await database.$queryRawUnsafe('SELECT * FROM DiscussionGroupGrant')).toEqual([]);
            expect(await database.$queryRawUnsafe('SELECT * FROM SessionTeamGrant')).toEqual(teamGrants);
            expect(await database.$queryRawUnsafe('SELECT * FROM SessionGroupGrant')).toEqual(groupGrants);
            expect(await database.$queryRawUnsafe("SELECT id, encryptionMode, OCTET_LENGTH(dataEncryptionKey) AS keyLength, titleContent, creationEqualityEvidenceV1 FROM Discussion WHERE id='encrypted-discussion'"))
                .toEqual([{ id: 'encrypted-discussion', encryptionMode: 'e2ee', keyLength: 0n,
                    titleContent: { t: 'encrypted', c: 'opaque-session-key-title' },
                    creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'opaque-create-tag' } }]);
            expect(await database.$queryRawUnsafe("SELECT id, content, requestEqualityEvidenceV1 FROM DiscussionMessage WHERE id='encrypted-message'"))
                .toEqual([{ id: 'encrypted-message', content: { t: 'encrypted', c: 'opaque-session-key-message' },
                    requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'opaque-message-tag' } }]);
            expect(await database.$queryRawUnsafe('SELECT * FROM DiscussionKeyEnvelope')).toEqual([]);
            await database.$executeRawUnsafe("DELETE FROM Session WHERE id = 'source'");
            const rows = await database.$queryRawUnsafe<Array<{ ownerAccountId: string; anchorV1: unknown; messageSeq: number }>>(
                "SELECT ownerAccountId, anchorV1, messageSeq FROM Discussion WHERE id='discussion'",
            );
            expect(rows).toEqual([{ ownerAccountId: 'author', anchorV1: { kind: 'session', sessionId: 'source' }, messageSeq: 1 }]);
            expect(await database.$queryRawUnsafe("SELECT localId, replyTargetV1, content FROM DiscussionMessage WHERE id='message'"))
                .toEqual([{ localId: 'post-retry', replyTargetV1: null, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Keep message' }] } } }]);
            expect(await database.$queryRawUnsafe("SELECT accountId, accessLevel, createdByAccountId FROM DiscussionAccountGrant WHERE discussionId='discussion' ORDER BY accountId"))
                .toEqual([{ accountId: 'invitee', accessLevel: 'edit', createdByAccountId: 'owner' },
                    { accountId: 'owner', accessLevel: 'admin', createdByAccountId: 'author' }]);
            expect(await database.$queryRawUnsafe('SELECT accountId, lastReadSeq FROM DiscussionReadState'))
                .toEqual([{ accountId: 'owner', lastReadSeq: 1 }]);
            const messages = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
                'SELECT * FROM DiscussionMessage ORDER BY id',
            );
            // A new projection avoids reusing MySQL's prepared SELECT * metadata
            // from before the external schema change.
            const messageColumns = Object.keys(messages[0]!).map(column => `\`${column}\``).join(', ');
            await execute(await readFile(resolve(migrationRoot,
                '20261019020000_discussion_doc_edit_proposal_disposition/migration.sql'), 'utf8'));
            const upgraded = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT ${messageColumns}, docEditProposalDispositionV1 FROM DiscussionMessage ORDER BY id`,
            );
            expect(upgraded.map(({ docEditProposalDispositionV1, ...message }) => {
                expect(docEditProposalDispositionV1).toBeNull();
                return message;
            })).toEqual(messages);
            expect(await database.$queryRawUnsafe(`SELECT DATA_TYPE AS dataType, IS_NULLABLE AS isNullable,
                COLUMN_DEFAULT AS columnDefault FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME='DiscussionMessage' AND COLUMN_NAME='docEditProposalDispositionV1'`))
                .toEqual([{ dataType: 'json', isNullable: 'YES', columnDefault: null }]);
            await database.$executeRawUnsafe(`UPDATE DiscussionMessage SET docEditProposalDispositionV1=JSON_OBJECT('state','open') WHERE id='message'`);
            expect(await database.$queryRawUnsafe("SELECT docEditProposalDispositionV1 FROM DiscussionMessage WHERE id='message'"))
                .toEqual([{ docEditProposalDispositionV1: { state: 'open' } }]);
        } finally {
            await database.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP DATABASE \`${name}\``);
            await admin.$disconnect();
        }
    });
});
