import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PGlite } from '@electric-sql/pglite';

import { describe, expect, it } from 'vitest';

const migrationRoot = resolve(process.cwd(), 'prisma/sqlite/migrations');

async function legacyDatabase(mode = 'plain') {
    const database = new DatabaseSync(':memory:');
    database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE Account (id TEXT PRIMARY KEY, encryptionMode TEXT NOT NULL);
        CREATE TABLE Session (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, encryptionMode TEXT NOT NULL);
        CREATE TABLE Team (id TEXT PRIMARY KEY);
        CREATE TABLE TeamGroup (id TEXT PRIMARY KEY);
        CREATE TABLE SessionShare (sessionId TEXT, sharedByUserId TEXT, sharedWithUserId TEXT, accessLevel TEXT, createdAt DATETIME);
        CREATE TABLE SessionTeamGrant (sessionId TEXT, teamId TEXT, effectiveAt DATETIME NOT NULL DEFAULT '2026-10-18');
        CREATE TABLE SessionGroupGrant (sessionId TEXT, teamGroupId TEXT, effectiveAt DATETIME NOT NULL DEFAULT '2026-10-18');
        INSERT INTO Account VALUES ('owner', 'plain'), ('author', 'plain'), ('invitee', 'plain');
        INSERT INTO Session VALUES ('source', 'owner', '${mode}');
    `);
    database.exec(await readFile(resolve(migrationRoot, '20260905220000_add_session_discussions/migration.sql'), 'utf8'));
    database.exec(`
        INSERT INTO SessionDiscussion VALUES (
            'discussion', 'source', 'create-retry', '{"kind":"plainDigest","digest":"preserve"}',
            'author', '{"t":"plain","v":{"v":1,"title":"Keep title"}}', 1,
            '2026-10-18', NULL, '2026-10-18', '2026-10-18'
        );
        INSERT INTO SessionDiscussionMessage VALUES (
            'message', 'source', 'discussion', 'post-retry', '{"kind":"plainDigest","digest":"preserve"}',
            1, 'author', NULL, '{"t":"plain","v":{"v":1,"parts":[{"t":"text","text":"Keep message"}]}}', '2026-10-18'
        );
        INSERT INTO SessionDiscussionMessageMention VALUES ('message', 'invitee', '2026-10-18');
        INSERT INTO SessionDiscussionReadState VALUES ('discussion', 'owner', 1, '2026-10-18');
        INSERT INTO SessionShare VALUES ('source', 'owner', 'invitee', 'edit', '2026-10-18');
    `);
    return database;
}

const transition = () => readFile(resolve(migrationRoot, '20261018120000_first_class_discussions/migration.sql'), 'utf8');

const dispositionMigrationId = '20261019020000_discussion_doc_edit_proposal_disposition';
const serverRoot = join(import.meta.dirname, '../..');

describe('Discussion list summary migration', () => {
    const summaryMigration = '20261025073000_discussion_list_summaries';
    const docAnchor = { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
        revision: { headerVersion: 1, bodyVersion: 1 } } };
    const rootTarget = { kind: 'doc_passage', doc: docAnchor.doc };

    it('backfills SQLite passage roots without counting replies or opening retained ciphertext', async () => {
        const database = await legacyDatabase();
        try {
            database.exec(await transition());
            database.prepare('UPDATE Discussion SET anchorV1 = ?').run(JSON.stringify(docAnchor));
            database.prepare('UPDATE DiscussionMessage SET replyTargetV1 = ?').run(JSON.stringify(rootTarget));
            const insert = database.prepare(`INSERT INTO DiscussionMessage
                (id, discussionId, localId, requestEqualityEvidenceV1, seq, replyTargetV1, content)
                VALUES (?, 'discussion', ?, '{}', ?, ?, '{"t":"encrypted","c":"retained-opaque"}')`);
            insert.run('root-2', 'root-2', 2, JSON.stringify(rootTarget));
            insert.run('reply', 'reply', 3, JSON.stringify({ kind: 'message', messageId: 'message' }));
            insert.run('other-doc', 'other-doc', 4, JSON.stringify({ ...rootTarget,
                doc: { ...docAnchor.doc, ref: { ...docAnchor.doc.ref, artifactId: 'other' } } }));
            const before = database.prepare('SELECT * FROM DiscussionMessage ORDER BY seq').all();
            database.exec(await readFile(join(migrationRoot, summaryMigration, 'migration.sql'), 'utf8'));
            expect(database.prepare('SELECT roundOutcomeV1, openCommentCount FROM Discussion').get())
                .toEqual({ roundOutcomeV1: null, openCommentCount: 2 });
            expect(database.prepare('SELECT * FROM DiscussionMessage ORDER BY seq').all()).toEqual(before);
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(database.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
        } finally { database.close(); }
    });

    it('backfills PostgreSQL metadata roots and leaves non-Doc Discussions and authored content unchanged', async () => {
        const database = new PGlite();
        try {
            await database.exec(`CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "anchorV1" JSONB);
                CREATE TABLE "DiscussionMessage" ("discussionId" TEXT, "replyTargetV1" JSONB, "content" JSONB);`);
            await database.query('INSERT INTO "Discussion" VALUES ($1, $2), ($3, NULL)', ['doc-thread', docAnchor, 'ordinary']);
            for (const discussionId of ['doc-thread', 'ordinary']) {
                for (const target of [rootTarget, rootTarget, { kind: 'message', messageId: 'root' }]) {
                    await database.query('INSERT INTO "DiscussionMessage" VALUES ($1, $2, $3)',
                        [discussionId, target, { t: 'encrypted', c: 'retained-opaque' }]);
                }
            }
            await database.exec(await readFile(join(serverRoot, 'prisma/migrations', summaryMigration, 'migration.sql'), 'utf8'));
            expect((await database.query('SELECT * FROM "Discussion" ORDER BY "id"')).rows).toEqual([
                { id: 'doc-thread', anchorV1: docAnchor, roundOutcomeV1: null, openCommentCount: 2 },
                { id: 'ordinary', anchorV1: null, roundOutcomeV1: null, openCommentCount: 0 },
            ]);
            expect((await database.query('SELECT DISTINCT "content" FROM "DiscussionMessage"')).rows)
                .toEqual([{ content: { t: 'encrypted', c: 'retained-opaque' } }]);
        } finally { await database.close(); }
    });
});

describe('Discussion proposal disposition migration', () => {
    it.each(['prisma', 'prisma/sqlite', 'prisma/mysql'])('projects nullable JSON from the canonical schema to %s', async providerPath => {
        const schema = await readFile(join(serverRoot, providerPath, 'schema.prisma'), 'utf8');
        const message = schema.match(/model DiscussionMessage \{[\s\S]*?\n\}/)?.[0];
        expect(message).toMatch(/^\s*docEditProposalDispositionV1\s+Json\?\s*$/m);
    });

    it('upgrades existing SQLite messages without treating NULL as an open proposal', async () => {
        const database = await legacyDatabase();
        try {
            database.exec(await transition());
            const original = database.prepare('SELECT * FROM DiscussionMessage').get();
            database.exec(await readFile(join(migrationRoot, dispositionMigrationId, 'migration.sql'), 'utf8'));
            const { docEditProposalDispositionV1, ...retained } = database.prepare('SELECT * FROM DiscussionMessage').get()!;
            expect(docEditProposalDispositionV1).toBeNull();
            expect(retained).toEqual(original);
            expect(database.prepare('PRAGMA table_info("DiscussionMessage")').all()
                .find(column => column.name === 'docEditProposalDispositionV1'))
                .toMatchObject({ type: 'JSONB', notnull: 0, dflt_value: null });
            const disposition = { state: 'declined', decidedBy: { accountId: 'author', atMs: 1792350000000 } };
            database.prepare('UPDATE DiscussionMessage SET docEditProposalDispositionV1 = ? WHERE id = ?')
                .run(JSON.stringify(disposition), 'message');
            const stored = database.prepare('SELECT * FROM DiscussionMessage').get()!;
            expect(JSON.parse(String(stored.docEditProposalDispositionV1))).toEqual(disposition);
            const { docEditProposalDispositionV1: _disposition, ...unchanged } = stored;
            expect(unchanged).toEqual(original);
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(database.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
        } finally { database.close(); }
    });

    it('stores nullable PostgreSQL JSONB independently of immutable message content', async () => {
        const database = new PGlite();
        try {
            // This migration adds a column only; the real legacy-to-resource
            // SQLite upgrade above covers existing resource FKs and indexes.
            await database.exec(`CREATE TABLE "DiscussionMessage" ("id" TEXT PRIMARY KEY, "content" JSONB NOT NULL);
                INSERT INTO "DiscussionMessage" VALUES ('message', '{"t":"encrypted","c":"opaque-message-bytes"}');`);
            await database.exec(await readFile(join(serverRoot, 'prisma/migrations', dispositionMigrationId, 'migration.sql'), 'utf8'));
            expect((await database.query(`SELECT "content", "docEditProposalDispositionV1" FROM "DiscussionMessage"`)).rows)
                .toEqual([{ content: { t: 'encrypted', c: 'opaque-message-bytes' }, docEditProposalDispositionV1: null }]);
            expect((await database.query(`SELECT data_type,is_nullable,column_default FROM information_schema.columns
                WHERE table_name='DiscussionMessage' AND column_name='docEditProposalDispositionV1'`)).rows)
                .toEqual([{ data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
            await database.exec(`UPDATE "DiscussionMessage" SET "docEditProposalDispositionV1" = '{"state":"open"}';`);
            expect((await database.query(`SELECT "docEditProposalDispositionV1" FROM "DiscussionMessage"`)).rows)
                .toEqual([{ docEditProposalDispositionV1: { state: 'open' } }]);
        } finally { await database.close(); }
    });

    it('keeps the MySQL migration additive with nullable native JSON', async () => {
        const sql = await readFile(join(serverRoot, 'prisma/mysql/migrations', dispositionMigrationId, 'migration.sql'), 'utf8');
        expect(sql).toMatch(/ALTER TABLE\s+`DiscussionMessage`\s+ADD COLUMN\s+`docEditProposalDispositionV1`\s+JSON\s+NULL\s*;/i);
        expect(sql).not.toMatch(/\b(?:DROP|DELETE|UPDATE|INSERT|DEFAULT|NOT\s+NULL)\b/i);
    });
});

describe('Discussion storage migration', () => {
    it('preserves authored history and cursors while detaching the source Session', async () => {
        const database = await legacyDatabase();
        try {
            database.exec(await transition());
            const discussion = database.prepare('SELECT * FROM Discussion').get();
            expect(discussion).toMatchObject({
                id: 'discussion', ownerAccountId: 'author', encryptionMode: 'plain',
                creationLocalId: 'create-retry', createdByAccountId: 'author', messageSeq: 1,
                anchorSessionId: 'source',
                titleContent: '{"t":"plain","v":{"v":1,"title":"Keep title"}}',
            });
            expect(JSON.parse(String(discussion?.anchorV1))).toEqual({ kind: 'session', sessionId: 'source' });
            expect(database.prepare('SELECT accountId, accessLevel, createdByAccountId FROM DiscussionAccountGrant ORDER BY accountId').all())
                .toEqual([{ accountId: 'invitee', accessLevel: 'edit', createdByAccountId: 'owner' },
                    { accountId: 'owner', accessLevel: 'admin', createdByAccountId: 'author' }]);
            database.exec(`INSERT INTO DiscussionParticipant (discussionId, participantSlotId, sessionId, updatedAt)
                VALUES ('discussion', 'participant-slot', 'source', CURRENT_TIMESTAMP)`);
            database.exec("DELETE FROM Session WHERE id = 'source'");
            expect(database.prepare('SELECT localId, seq, authorAccountId, replyTargetV1, content FROM DiscussionMessage').get())
                .toMatchObject({ localId: 'post-retry', seq: 1, authorAccountId: 'author',
                    replyTargetV1: null,
                    content: '{"t":"plain","v":{"v":1,"parts":[{"t":"text","text":"Keep message"}]}}' });
            expect(database.prepare('SELECT sessionId FROM DiscussionParticipant').all()).toEqual([]);
            expect(database.prepare('SELECT * FROM DiscussionMessageMention').get()).toMatchObject({ messageId: 'message', accountId: 'invitee' });
            expect(database.prepare('SELECT * FROM DiscussionReadState').get()).toMatchObject({ discussionId: 'discussion', accountId: 'owner', lastReadSeq: 1 });
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'SessionDiscussion%'").all()).toEqual([]);
            database.exec(`
                INSERT INTO Discussion (id, ownerAccountId, encryptionMode, dataEncryptionKey, creationLocalId,
                    creationEqualityEvidenceV1, createdByAccountId, titleContent, lastMessageAt, updatedAt)
                VALUES ('standalone', 'author', 'plain', CAST('{"t":"plain","v":null}' AS BLOB), 'new-create',
                    '{"kind":"plainDigest","digest":"new"}', 'author', '{"t":"plain","v":{"v":1,"title":"New"}}',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            `);
            expect(database.prepare("SELECT anchorV1, anchorSessionId FROM Discussion WHERE id = 'standalone'").get())
                .toEqual({ anchorV1: null, anchorSessionId: null });
        } finally {
            database.close();
        }
    });

    it('retains encrypted Session-key content without inventing a Discussion key', async () => {
        const database = await legacyDatabase('e2ee');
        try {
            database.exec(`
                UPDATE Account SET encryptionMode = 'e2ee';
                UPDATE SessionDiscussion SET titleContent = '{"t":"encrypted","c":"opaque-session-key-title"}',
                    creationEqualityEvidenceV1 = '{"kind":"e2eeTag","tag":"opaque-create-tag"}';
                UPDATE SessionDiscussionMessage SET content = '{"t":"encrypted","c":"opaque-session-key-message"}',
                    requestEqualityEvidenceV1 = '{"kind":"e2eeTag","tag":"opaque-message-tag"}';
            `);
            database.exec(await transition());
            expect(database.prepare('SELECT id, encryptionMode, titleContent, creationEqualityEvidenceV1 FROM Discussion').get())
                .toEqual({ id: 'discussion', encryptionMode: 'e2ee',
                    titleContent: '{"t":"encrypted","c":"opaque-session-key-title"}',
                    creationEqualityEvidenceV1: '{"kind":"e2eeTag","tag":"opaque-create-tag"}' });
            expect(database.prepare('SELECT id, content, requestEqualityEvidenceV1 FROM DiscussionMessage').get())
                .toEqual({ id: 'message', content: '{"t":"encrypted","c":"opaque-session-key-message"}',
                    requestEqualityEvidenceV1: '{"kind":"e2eeTag","tag":"opaque-message-tag"}' });
            expect(database.prepare('SELECT length(dataEncryptionKey) AS length FROM Discussion').get()).toEqual({ length: 0 });
            expect(database.prepare('SELECT * FROM DiscussionKeyEnvelope').all()).toEqual([]);
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            database.close();
        }
    });

    it('retains an erased creator using the surviving source owner', async () => {
        const database = await legacyDatabase();
        try {
            database.exec("UPDATE SessionDiscussion SET createdByAccountId = NULL");
            database.exec(await transition());
            expect(database.prepare('SELECT ownerAccountId, createdByAccountId FROM Discussion').get())
                .toEqual({ ownerAccountId: 'owner', createdByAccountId: null });
        } finally {
            database.close();
        }
    });

    it('normalizes only the transitive collision set and retains authored data', async () => {
        const database = await legacyDatabase();
        try {
            database.exec(`
                INSERT INTO Session VALUES ('other-source', 'owner', 'plain'), ('chain-source', 'owner', 'plain'),
                    ('chain-two-source', 'owner', 'plain'), ('unaffected-source', 'owner', 'plain');
                INSERT INTO SessionDiscussion SELECT 'other-discussion', 'other-source', creationLocalId,
                    creationEqualityEvidenceV1, createdByAccountId, titleContent, 0, lastMessageAt, archivedAt,
                    createdAt, updatedAt FROM SessionDiscussion;
                INSERT INTO SessionDiscussion SELECT 'chain-one', 'chain-source', 'discussion',
                    creationEqualityEvidenceV1, createdByAccountId, titleContent, 0, lastMessageAt, archivedAt,
                    createdAt, updatedAt FROM SessionDiscussion WHERE id = 'discussion';
                INSERT INTO SessionDiscussion SELECT 'chain-two', 'chain-two-source', 'chain-one',
                    creationEqualityEvidenceV1, createdByAccountId, titleContent, 0, lastMessageAt, archivedAt,
                    createdAt, updatedAt FROM SessionDiscussion WHERE id = 'discussion';
                INSERT INTO SessionDiscussion SELECT 'unaffected', 'unaffected-source', 'keep-retry',
                    creationEqualityEvidenceV1, createdByAccountId, titleContent, 0, lastMessageAt, archivedAt,
                    createdAt, updatedAt FROM SessionDiscussion WHERE id = 'discussion';
            `);
            database.exec(await transition());
            expect(database.prepare('SELECT id, creationLocalId FROM Discussion ORDER BY id').all())
                .toEqual([{ id: 'chain-one', creationLocalId: 'chain-one' }, { id: 'chain-two', creationLocalId: 'chain-two' },
                    { id: 'discussion', creationLocalId: 'discussion' }, { id: 'other-discussion', creationLocalId: 'other-discussion' },
                    { id: 'unaffected', creationLocalId: 'keep-retry' }]);
            expect(database.prepare('SELECT DISTINCT createdByAccountId, creationEqualityEvidenceV1, titleContent FROM Discussion').all())
                .toEqual([{ createdByAccountId: 'author', creationEqualityEvidenceV1: '{"kind":"plainDigest","digest":"preserve"}',
                    titleContent: '{"t":"plain","v":{"v":1,"title":"Keep title"}}' }]);
            expect(database.prepare('SELECT id, localId, authorAccountId FROM DiscussionMessage').all())
                .toEqual([{ id: 'message', localId: 'post-retry', authorAccountId: 'author' }]);
            expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        } finally {
            database.close();
        }
    });

    it('preserves content and source grants without broadening collective history', async () => {
        const database = await legacyDatabase();
        try {
            database.exec("INSERT INTO SessionTeamGrant (sessionId, teamId) VALUES ('source', 'team'); INSERT INTO SessionGroupGrant (sessionId, teamGroupId) VALUES ('source', 'group')");
            const teamGrants = database.prepare('SELECT * FROM SessionTeamGrant').all();
            const groupGrants = database.prepare('SELECT * FROM SessionGroupGrant').all();
            database.exec(await transition());
            expect(database.prepare('SELECT id, ownerAccountId FROM Discussion').all()).toEqual([{ id: 'discussion', ownerAccountId: 'author' }]);
            expect(database.prepare('SELECT id FROM DiscussionMessage').all()).toEqual([{ id: 'message' }]);
            expect(database.prepare('SELECT * FROM DiscussionTeamGrant').all()).toEqual([]);
            expect(database.prepare('SELECT * FROM DiscussionGroupGrant').all()).toEqual([]);
            expect(database.prepare('SELECT * FROM SessionTeamGrant').all()).toEqual(teamGrants);
            expect(database.prepare('SELECT * FROM SessionGroupGrant').all()).toEqual(groupGrants);
        } finally {
            database.close();
        }
    });
});

describe('Discussion PostgreSQL migration', () => {
    it('preserves history and access on real PostgreSQL storage without a source lifetime dependency', async () => {
        const database = new PGlite();
        const root = resolve(process.cwd(), 'prisma/migrations');
        try {
            await database.exec(`
                CREATE TYPE "ShareAccessLevel" AS ENUM ('view', 'edit', 'admin');
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "encryptionMode" TEXT NOT NULL);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "encryptionMode" TEXT NOT NULL);
                CREATE TABLE "Team" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "TeamGroup" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "SessionShare" ("sessionId" TEXT, "sharedByUserId" TEXT, "sharedWithUserId" TEXT, "accessLevel" "ShareAccessLevel", "createdAt" TIMESTAMP(3));
                CREATE TABLE "SessionTeamGrant" ("sessionId" TEXT, "teamId" TEXT, "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-18');
                CREATE TABLE "SessionGroupGrant" ("sessionId" TEXT, "teamGroupId" TEXT, "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-18');
                INSERT INTO "Account" VALUES ('owner', 'plain'), ('author', 'plain'), ('invitee', 'plain');
                INSERT INTO "Session" VALUES ('source', 'owner', 'plain');
            `);
            await database.exec(await readFile(resolve(root, '20260905220000_add_session_discussions/migration.sql'), 'utf8'));
            await database.exec(`
                INSERT INTO "SessionDiscussion" VALUES (
                    'discussion', 'source', 'create-retry', '{"kind":"plainDigest","digest":"preserve"}',
                    'author', '{"t":"plain","v":{"v":1,"title":"Keep title"}}', 1,
                    '2026-10-18', NULL, '2026-10-18', '2026-10-18'
                );
                INSERT INTO "SessionDiscussionMessage" VALUES (
                    'message', 'source', 'discussion', 'post-retry', '{"kind":"plainDigest","digest":"preserve"}',
                    1, 'author', NULL, '{"t":"plain","v":{"v":1,"parts":[{"t":"text","text":"Keep message"}]}}', '2026-10-18'
                );
                INSERT INTO "SessionDiscussionMessageMention" VALUES ('message', 'invitee', '2026-10-18');
                INSERT INTO "SessionDiscussionReadState" VALUES ('discussion', 'owner', 1, '2026-10-18');
                INSERT INTO "SessionShare" VALUES ('source', 'owner', 'invitee', 'edit', '2026-10-18');
            `);
            const sql = await readFile(resolve(root, '20261018120000_first_class_discussions/migration.sql'), 'utf8');
            await database.exec(`
                INSERT INTO "Account" VALUES ('encrypted-owner', 'e2ee');
                INSERT INTO "Session" VALUES ('encrypted-source', 'encrypted-owner', 'e2ee');
                INSERT INTO "SessionDiscussion" SELECT 'encrypted-discussion', 'encrypted-source', 'encrypted-retry',
                    '{"kind":"e2eeTag","tag":"opaque-create-tag"}', 'encrypted-owner',
                    '{"t":"encrypted","c":"opaque-session-key-title"}', 1, "lastMessageAt", "archivedAt",
                    "createdAt", "updatedAt" FROM "SessionDiscussion";
                INSERT INTO "SessionDiscussionMessage" SELECT 'encrypted-message', 'encrypted-source', 'encrypted-discussion', 'encrypted-post',
                    '{"kind":"e2eeTag","tag":"opaque-message-tag"}', 1, 'encrypted-owner', NULL,
                    '{"t":"encrypted","c":"opaque-session-key-message"}', "createdAt" FROM "SessionDiscussionMessage";
                INSERT INTO "Session" VALUES ('collision-source', 'owner', 'plain');
                INSERT INTO "SessionDiscussion" SELECT fixture.id, 'collision-source', fixture.retry,
                    d."creationEqualityEvidenceV1", d."createdByAccountId", d."titleContent", 0, d."lastMessageAt", d."archivedAt",
                    d."createdAt", d."updatedAt" FROM "SessionDiscussion" d
                    CROSS JOIN (VALUES ('other-discussion', 'create-retry'), ('chain-one', 'discussion'),
                        ('chain-two', 'chain-one'), ('unaffected', 'keep-retry')) AS fixture(id, retry)
                    WHERE d."id" = 'discussion';
                INSERT INTO "SessionTeamGrant" ("sessionId", "teamId") VALUES ('source', 'team');
                INSERT INTO "SessionGroupGrant" ("sessionId", "teamGroupId") VALUES ('source', 'group');
            `);
            const teamGrants = (await database.query(`SELECT * FROM "SessionTeamGrant"`)).rows;
            const groupGrants = (await database.query(`SELECT * FROM "SessionGroupGrant"`)).rows;
            await database.exec(sql);
            expect((await database.query(`SELECT "id", "creationLocalId" FROM "Discussion" WHERE "createdByAccountId" = 'author' ORDER BY "id"`)).rows)
                .toEqual([{ id: 'chain-one', creationLocalId: 'chain-one' }, { id: 'chain-two', creationLocalId: 'chain-two' },
                    { id: 'discussion', creationLocalId: 'discussion' }, { id: 'other-discussion', creationLocalId: 'other-discussion' },
                    { id: 'unaffected', creationLocalId: 'keep-retry' }]);
            expect((await database.query(`SELECT DISTINCT "createdByAccountId", "creationEqualityEvidenceV1", "titleContent" FROM "Discussion" WHERE "createdByAccountId" = 'author'`)).rows)
                .toEqual([{ createdByAccountId: 'author', creationEqualityEvidenceV1: { kind: 'plainDigest', digest: 'preserve' },
                    titleContent: { t: 'plain', v: { v: 1, title: 'Keep title' } } }]);
            expect((await database.query(`SELECT * FROM "DiscussionTeamGrant"`)).rows).toEqual([]);
            expect((await database.query(`SELECT * FROM "DiscussionGroupGrant"`)).rows).toEqual([]);
            expect((await database.query(`SELECT * FROM "SessionTeamGrant"`)).rows).toEqual(teamGrants);
            expect((await database.query(`SELECT * FROM "SessionGroupGrant"`)).rows).toEqual(groupGrants);
            expect((await database.query(`SELECT "id", "encryptionMode", octet_length("dataEncryptionKey") AS "keyLength", "titleContent", "creationEqualityEvidenceV1" FROM "Discussion" WHERE "id" = 'encrypted-discussion'`)).rows)
                .toEqual([{ id: 'encrypted-discussion', encryptionMode: 'e2ee', keyLength: 0,
                    titleContent: { t: 'encrypted', c: 'opaque-session-key-title' },
                    creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'opaque-create-tag' } }]);
            expect((await database.query(`SELECT "id", "content", "requestEqualityEvidenceV1" FROM "DiscussionMessage" WHERE "id" = 'encrypted-message'`)).rows)
                .toEqual([{ id: 'encrypted-message', content: { t: 'encrypted', c: 'opaque-session-key-message' },
                    requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'opaque-message-tag' } }]);
            expect((await database.query(`SELECT * FROM "DiscussionKeyEnvelope"`)).rows).toEqual([]);
            await database.exec(`DELETE FROM "Session" WHERE "id" = 'source'`);
            expect((await database.query(`SELECT "ownerAccountId", "anchorV1", "messageSeq" FROM "Discussion" WHERE "id" = 'discussion'`)).rows)
                .toEqual([{ ownerAccountId: 'author', anchorV1: { kind: 'session', sessionId: 'source' }, messageSeq: 1 }]);
            expect((await database.query(`SELECT "localId", "content" FROM "DiscussionMessage" WHERE "id" = 'message'`)).rows)
                .toEqual([{ localId: 'post-retry', content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Keep message' }] } } }]);
            expect((await database.query(`SELECT "accountId", "accessLevel", "createdByAccountId" FROM "DiscussionAccountGrant" WHERE "discussionId" = 'discussion' ORDER BY "accountId"`)).rows)
                .toEqual([{ accountId: 'invitee', accessLevel: 'edit', createdByAccountId: 'owner' },
                    { accountId: 'owner', accessLevel: 'admin', createdByAccountId: 'author' }]);
            expect((await database.query(`SELECT "accountId", "lastReadSeq" FROM "DiscussionReadState"`)).rows)
                .toEqual([{ accountId: 'owner', lastReadSeq: 1 }]);
        } finally {
            await database.close();
        }
    });
});
