import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionMessagePage } from '@/app/api/routes/session/readSessionMessagePage';
import { readCanonicalSessionMessagesPage } from '@/app/search/homeSearchCanonicalSessionMessages';
import { readSessionMessageEvidenceRowsInTx } from '@/app/usage/query/readSessionMessageEvidenceRows';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { toPrismaSessionMessageStoredContent } from '@/storage/sessionMessageContent';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';

import { runSessionMessageContentByteUpgrade } from './sessionMessageContentByteUpgrade';

const isSqlite = (process.env.HAPPIER_DB_PROVIDER ?? 'sqlite') === 'sqlite';

/** Representative opaque ciphertext spellings; values never leave this suite. */
const CANONICAL = ['AAECAwQFBgcICQ==', 'CgsMDQ4P', 'AAEC', '/+/+AA=='];
/** Historical spellings the write path refuses to re-encode: they must stay byte-identical JSON. */
const RETAINED: PrismaJson.SessionMessageStoredContent[] = [
    { t: 'encrypted', c: 'AAECAwQFBgcICQ' },   // unpadded
    { t: 'encrypted', c: 'AB==' },             // non-zero padding bits
    { t: 'encrypted', c: 'AAEC\nAwQF' },       // embedded whitespace
    { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'q' } } },
];

async function createSession() {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'e2ee' } });
    const session = await db.session.create({ data: {
        accountId: owner.id, tag: randomUUID(), encryptionMode: 'e2ee', metadata: '{}',
    } });
    return { ownerId: owner.id, sessionId: session.id };
}

/** Exactly the 0.2 producer's write: the whole envelope in the Json column, no byte field. */
async function insert02Rows(sessionId: string, contents: readonly PrismaJson.SessionMessageStoredContent[], firstSeq = 1) {
    const ids: string[] = [];
    for (const [index, content] of contents.entries()) {
        const row = await db.sessionMessage.create({ data: {
            sessionId, seq: firstSeq + index, localId: randomUUID(), messageRole: 'agent',
            content: toPrismaSessionMessageStoredContent(content),
        }, select: { id: true } });
        ids.push(row.id);
    }
    return ids;
}

async function readThroughRealReaders(ownerId: string, sessionId: string) {
    const page = await readSessionMessagePage({ userId: ownerId, sessionId,
        authentication: createPresentUserSessionAccessAuthentication(), query: { limit: 150 } });
    if (page.status !== 200) throw new Error('page read failed');
    const indexed = await readCanonicalSessionMessagesPage({ sessionIds: [sessionId], limit: 150 });
    const evidence = await inTx(tx => readSessionMessageEvidenceRowsInTx(tx, [{ id: sessionId, maximumSeq: null }], []), { readOnly: true });
    const project = (rows: readonly { id: string; content: unknown }[]) =>
        [...rows].map(row => ({ id: row.id, content: row.content })).sort((a, b) => a.id.localeCompare(b.id));
    return {
        page: project(page.body.messages),
        indexed: project(indexed.messages),
        envelopes: evidence.map(row => ({ id: row.id, envelopeType: row.envelopeType })).sort((a, b) => a.id.localeCompare(b.id)),
    };
}

async function physicalRows(sessionId: string) {
    return await db.sessionMessage.findMany({
        where: { sessionId }, orderBy: { seq: 'asc' },
        select: { id: true, content: true, contentBytes: true, rowRevision: true, updatedAt: true },
    });
}

describe('SessionMessage 0.2 → 0.3 stored-content byte upgrade', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'message-byte-upgrade-', initAuth: false });
    });
    afterAll(async () => { if (harness) await harness.close(); });
    beforeEach(async () => {
        await db.simpleCache.deleteMany({ where: { key: { startsWith: 'server.session-message-content-bytes.' } } });
        await db.sessionMessage.deleteMany({});
    });

    it('converts only canonical encrypted 0.2 rows and every real reader returns identical envelopes', async () => {
        const { ownerId, sessionId } = await createSession();
        const canonicalIds = await insert02Rows(sessionId, CANONICAL.map(c => ({ t: 'encrypted' as const, c })));
        const retainedIds = await insert02Rows(sessionId, RETAINED, CANONICAL.length + 1);
        // A row already written by the 0.3 encoder.
        const fresh = await db.sessionMessage.create({ data: {
            sessionId, seq: 100, localId: randomUUID(), content: toPrismaSessionMessageStoredContent(null),
            contentBytes: new Uint8Array([9, 8, 7]),
        }, select: { id: true } });

        const before = await physicalRows(sessionId);
        const readsBefore = await readThroughRealReaders(ownerId, sessionId);

        const result = await runSessionMessageContentByteUpgrade({ pageSize: 3 });

        expect(result).toMatchObject({ status: 'complete', converted: CANONICAL.length, retained: RETAINED.length });
        const after = await physicalRows(sessionId);
        const byId = new Map(after.map(row => [row.id, row]));
        for (const [index, id] of canonicalIds.entries()) {
            const row = byId.get(id)!;
            expect(row.content).toBeNull();
            expect(Buffer.from(row.contentBytes!).toString('base64')).toBe(CANONICAL[index]);
        }
        for (const [index, id] of retainedIds.entries()) {
            expect(byId.get(id)).toMatchObject({ content: RETAINED[index], contentBytes: null });
        }
        expect(byId.get(fresh.id)!.contentBytes).toEqual(new Uint8Array([9, 8, 7]));
        // Encoding only: no currentness or timestamp change for any row.
        expect(after.map(row => ({ id: row.id, rowRevision: row.rowRevision, updatedAt: row.updatedAt })))
            .toEqual(before.map(row => ({ id: row.id, rowRevision: row.rowRevision, updatedAt: row.updatedAt })));
        expect(await readThroughRealReaders(ownerId, sessionId)).toEqual(readsBefore);
    });

    it('resumes from its committed cursor after a crash mid-page and finishes once', async () => {
        const { sessionId } = await createSession();
        const contents = Array.from({ length: 7 }, (_, index) => ({
            t: 'encrypted' as const, c: Buffer.from([index, index + 1, index + 2]).toString('base64'),
        }));
        const ids = await insert02Rows(sessionId, contents);
        const sortedIds = [...ids].sort();
        const stopAfterFirstPage = await runSessionMessageContentByteUpgrade({ pageSize: 3, shouldContinue: (pages) => pages < 1 });
        expect(stopAfterFirstPage).toMatchObject({ status: 'paused', converted: 3, pages: 1 });

        let convertedBeforeResume = 3;
        if (isSqlite) {
            // A real database failure on the 2nd row of the next page, after its 1st row committed.
            await db.$executeRawUnsafe(`CREATE TRIGGER upgrade_crash BEFORE UPDATE OF "contentBytes" ON "SessionMessage"
                WHEN NEW."id" = '${sortedIds[4]}' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
            await expect(runSessionMessageContentByteUpgrade({ pageSize: 3 })).rejects.toThrow();
            await db.$executeRawUnsafe('DROP TRIGGER upgrade_crash');
            const midway = await physicalRows(sessionId);
            expect(midway.filter(row => row.contentBytes !== null).map(row => row.id).sort()).toEqual(sortedIds.slice(0, 4));
            convertedBeforeResume = 4;
        }

        const resumed = await runSessionMessageContentByteUpgrade({ pageSize: 3 });
        // Only unconverted rows after the committed cursor are scanned; finished rows are never re-read or re-counted.
        expect(resumed).toMatchObject({ status: 'complete', converted: 7 - convertedBeforeResume, scannedThisRun: 7 - convertedBeforeResume });
        expect((await physicalRows(sessionId)).every(row => row.contentBytes !== null && row.content === null)).toBe(true);

        const again = await runSessionMessageContentByteUpgrade({ pageSize: 3 });
        expect(again).toMatchObject({ status: 'complete', converted: 0, pages: 0, scannedThisRun: 0 });
    });
});
