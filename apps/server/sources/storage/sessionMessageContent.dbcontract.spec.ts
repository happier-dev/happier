import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { writeSessionTranscriptMessageInTx } from '@/app/session/sessionTranscriptWrite';
import { updateSessionMessageAtCurrentRevisionInTx } from '@/app/session/sessionMessageRevisionWrite';
import { readSessionMessagePage } from '@/app/api/routes/session/readSessionMessagePage';
import { readSessionMessagePages } from '@/app/api/routes/session/readSessionMessagePages';
import { readSessionMessageEvidenceRowsInTx } from '@/app/usage/query/readSessionMessageEvidenceRows';
import { readCanonicalSessionMessagesPage } from '@/app/search/homeSearchCanonicalSessionMessages';
import { db, prismaRuntime } from './db';
import { inTx } from './inTx';
import { decodeSessionMessageContentFromStorage } from './sessionMessageContent';

// This suite never falls back to a retained database or a caller-supplied URL.
const disposablePostgres = process.env.HAPPIER_DB_PROVIDER === 'postgres'
    && /^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '');

describe.skipIf(!disposablePostgres)('SessionMessage raw-byte PostgreSQL storage', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'message-byte-contract-', initAuth: false });
    });
    afterAll(async () => { if (harness) await harness.close(); });

    it('keeps the required JSON column as JSON null while storing PostgreSQL bytea', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: '{}',
        } });
        const message = await db.sessionMessage.create({ data: {
            sessionId: session.id, seq: 1, content: prismaRuntime.JsonNull,
            contentBytes: new Uint8Array([0, 1, 2, 3]),
        } });
        expect(message.content).toBeNull();
        expect(message.contentBytes).toEqual(new Uint8Array([0, 1, 2, 3]));
        const physical = await db.$queryRaw<Array<{ sqlNull: boolean; jsonNull: boolean; bytes: number }>>
            `SELECT "content" IS NULL AS "sqlNull", "content" = 'null'::jsonb AS "jsonNull",
                    octet_length("contentBytes") AS bytes FROM "SessionMessage" WHERE "id" = ${message.id}`;
        expect(physical).toEqual([{ sqlNull: false, jsonNull: true, bytes: 4 }]);
    });

    it('inserts and corrects raw ciphertext through the real persistence owners, pages, search and Usage', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: '{}',
        } });
        const content = { t: 'encrypted' as const, c: 'AAECAwQFBgcICQ==' };
        const written = await inTx(tx => writeSessionTranscriptMessageInTx(tx, {
            sessionId: session.id, writeAuthority: 'hosted', sessionEncryptionMode: 'e2ee', storagePolicy: 'optional',
            content, localId: randomUUID(), sidechainId: null, messageRole: 'agent',
        }));
        expect(written.ok).toBe(true);
        if (!written.ok) throw new Error('Transcript write did not succeed');
        expect(written.message.content).toEqual(content);
        const stored = await db.sessionMessage.findUniqueOrThrow({ where: { id: written.message.id },
            select: { content: true, contentBytes: true, rowRevision: true } });
        expect(stored.content).toBeNull();
        expect(stored.contentBytes).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
        const physical = await db.$queryRaw<Array<{ type: string; bytes: number }>>            `SELECT pg_typeof("contentBytes")::text AS type, octet_length("contentBytes") AS bytes
              FROM "SessionMessage" WHERE "id" = ${written.message.id}`;
        expect(physical).toEqual([{ type: 'bytea', bytes: 10 }]);
        const correctedContent = { t: 'encrypted' as const, c: 'CgsMDQ4P' };
        const corrected = await inTx(tx => updateSessionMessageAtCurrentRevisionInTx({ tx,
            id: written.message.id, rowRevision: stored.rowRevision,
            data: { content: correctedContent, rowRevision: { increment: BigInt(1) } },
        }));
        expect(corrected.content).toEqual(correctedContent);
        const authentication = createPresentUserSessionAccessAuthentication();
        const page = await readSessionMessagePage({ userId: owner.id, sessionId: session.id, authentication });
        expect(page).toMatchObject({ status: 200, body: { messages: [{ id: written.message.id, content: correctedContent }] } });
        const pages = await readSessionMessagePages({ userId: owner.id, sessionIds: [session.id], authentication });
        expect(pages.get(session.id)).toMatchObject({ status: 'fulfilled', value: { status: 200,
            body: { messages: [{ content: correctedContent }] } } });
        const indexed = await readCanonicalSessionMessagesPage({ sessionIds: [session.id], limit: 100 });
        expect(indexed.messages).toMatchObject([{ content: correctedContent }]);
        const evidence = await inTx(tx => readSessionMessageEvidenceRowsInTx(tx, [{ id: session.id, maximumSeq: null }], []), { readOnly: true });
        expect(evidence).toMatchObject([{ envelopeType: 'encrypted' }]);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });

    it('retains 0.2 JSON/plain and JSON/base64 values beside fresh byte rows', async () => {
        for (const encryptionMode of ['plain', 'e2ee'] as const) {
            const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode } });
            const session = await db.session.create({ data: {
                accountId: owner.id, tag: randomUUID(), encryptionMode, metadata: '{}',
            } });
            const content: PrismaJson.SessionMessageContent = encryptionMode === 'plain'
                ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Question' } } }
                : { t: 'encrypted', c: 'AAECAwQFBgcICQ==' };
            // The inspected 0.2 producer writes the whole envelope to Json; no byte field.
            const legacy = await db.sessionMessage.create({ data: {
                sessionId: session.id, seq: 1, localId: randomUUID(), messageRole: 'user', content,
            } });
            expect(legacy.contentBytes).toBeNull();
            expect(decodeSessionMessageContentFromStorage(legacy)).toEqual(content);
            const page = await readSessionMessagePage({ userId: owner.id, sessionId: session.id,
                authentication: createPresentUserSessionAccessAuthentication() });
            expect(page).toMatchObject({ status: 200, body: { messages: [{ content }] } });
        }
    });
});
