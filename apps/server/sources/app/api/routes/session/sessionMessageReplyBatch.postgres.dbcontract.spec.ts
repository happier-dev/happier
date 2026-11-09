import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionMessageRoutes } from './registerSessionMessageRoutes';
import { PrismaClient } from '@prisma/client';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionMessageRepliesInTx, readSessionMessageReplyInTx,
    listSessionMessageRepliesPendingForMachineInTx, listSessionMessageRepliesPendingInTx } from '@/app/session/messages/sessionMessageReply';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/messages/sessionTranscriptPageLimits';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('exact reply demand on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        initDbPostgres(); await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });
    it.each(['session', 'machine'] as const)('%s recovery acquires a whole page once and preserves denial, revocation and exact cursors', async kind => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        const queries: string[] = [];
        reader.$on('query', event => { if (/^SELECT\b/.test(event.query)) queries.push(event.query); });
        try {
            const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
                installationId: crypto.randomUUID(), metadata: encodePlainMachineStoredContent({}),
                dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            const [source, target] = await Promise.all([0, 1].map(() => db.session.create({ data: {
                accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
            } })));
            const turnId = crypto.randomUUID();
            await db.sessionTurn.create({ data: { sessionId: source.id, turnId, status: 'completed',
                startedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
            const keys = Array.from({ length: SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 + 3 }, (_, index) => `original-${String(index).padStart(4, '0')}`);
            const progress = { v: 1, mode: 'return', disposition: 'return_pending', outcome: { kind: 'pass' },
                sourceSession: { sourceSessionId: source.id, sourceTurnId: turnId, via: 'action' } };
            const receipt = { v: 1, issuer: 'authenticatedMachine', admittedTarget: { homeId: 'test-home', accountId: account.id,
                sessionId: target.id, machineId: machine.id, installationId: machine.installationId } };
            await db.sessionMessage.createMany({ data: keys.map((localId, index) => ({ sessionId: target.id, localId, seq: index + 1,
                messageRole: 'user', content: { t: 'plain', v: {} }, replyProgress: index === 0 ? { malformed: true } : progress,
                inputAdmissionReceipt: index === 1 ? { ...receipt, admittedTarget: { ...receipt.admittedTarget, machineId: 'other-machine' } } : receipt,
                replyTargetMachineId: machine.id, replyDisposition: 'return_pending', replySourceSessionId: source.id,
            })) });
            // A materialized copy and Pending custody remain one UNION key.
            await db.sessionPendingMessage.create({ data: { sessionId: target.id, localId: keys[2]!, position: 0,
                content: { t: 'plain', v: {} }, requestedAction: { v: 1, kind: 'enqueue' }, inputAdmissionReceipt: receipt,
                replyProgress: progress, replyTargetMachineId: machine.id, replyDisposition: 'return_pending', replySourceSessionId: source.id } });
            const authentication = createPresentUserSessionAccessAuthentication();
            const boundaryLocalId = keys[SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 - 1]!;
            const recover = (accountId = account.id, after?: string) => reader.$transaction(async tx => kind === 'machine'
                ? listSessionMessageRepliesPendingForMachineInTx(tx, { accountId, machineId: machine.id, authentication,
                    ...(after ? { after: { sessionId: target.id, localId: after } } : {}) })
                : listSessionMessageRepliesPendingInTx(tx, { accountId, sessionId: target.id, authentication, afterLocalId: after }),
                // Match the DB-contract harness budget so N+1 fails on SQL count, not Prisma's shorter default.
                { timeout: 60_000 });
            const one = await recover(account.id, keys[keys.length - 2]);
            expect(one.entries.map(entry => entry.requestLocalId)).toEqual([keys.at(-1)]);
            const oneQueryCount = queries.length;
            queries.length = 0;
            const page = await recover();
            const pageQueries = [...queries];
            expect(page.entries.map(entry => entry.requestLocalId)).toEqual(keys.slice(kind === 'machine' ? 2 : 1, SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1));
            expect(page).toMatchObject(kind === 'machine' ? { nextAfter: { sessionId: target.id, localId: boundaryLocalId } }
                : { nextAfterLocalId: boundaryLocalId });
            const tail = await recover(account.id, boundaryLocalId);
            expect(tail.entries.map(entry => entry.requestLocalId)).toEqual(keys.slice(SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1));
            expect(tail).toMatchObject(kind === 'machine' ? { nextAfter: null } : { nextAfterLocalId: null });
            // These are actual SQL statements, including Prisma relation reads, not helper invocations.
            const originalReadChunks = portableQueryChunks({ values: keys.slice(0, SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1), bindingsPerValue: 2 }).length;
            expect(pageQueries.filter(sql => /FROM "public"\."Session(?:Pending)?Message"/.test(sql))).toHaveLength(2 * originalReadChunks);
            expect(pageQueries.filter(sql => /FROM "public"\."SessionTurn"/.test(sql))).toHaveLength(1);
            expect(pageQueries).toHaveLength(oneQueryCount + 2 * (originalReadChunks - 1));
            expect((await recover(outsider.id)).entries).toEqual([]);
            await db.sessionTurn.delete({ where: { sessionId_turnId: { sessionId: source.id, turnId } } });
            const revoked = await recover();
            expect(revoked.entries).toEqual([]);
            expect(revoked).toMatchObject(kind === 'machine' ? { nextAfter: { sessionId: target.id, localId: boundaryLocalId } }
                : { nextAfterLocalId: boundaryLocalId });
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            if (kind === 'machine') expect(await recover()).toEqual({ v: 1, entries: [], nextAfter: null });
        } finally {
            await reader.$disconnect();
            await db.sessionPendingMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, outsider.id] } } });
        }
    });
    it('reads only requested originals and leaves the durable reply unchanged', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const target = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            const progress = { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } };
            const original = await db.sessionMessage.create({ data: { sessionId: target.id, seq: 1, localId: 'original',
                messageRole: 'user', content: { t: 'plain', v: { text: 'Question' } }, replyProgress: progress } });
            await db.sessionMessage.create({ data: { sessionId: target.id, seq: 2, localId: 'unrelated', messageRole: 'user',
                content: { t: 'plain', v: { text: 'Unrelated' } }, replyProgress: { ...progress, outcome: { kind: 'failed' } } } });
            await withAuthenticatedTestApp(app => registerSessionMessageRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/messages/replies/read-batch',
                    headers: { 'x-test-user-id': account.id }, payload: { requests: [{ sessionId: target.id, localId: 'original' }] } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ results: [{ sessionId: target.id, localId: 'original', reply: { v: 1, status: 'available', progress } }] });
            });
            expect((await db.sessionMessage.findUniqueOrThrow({ where: { id: original.id } })).replyProgress).toEqual(progress);
        } finally {
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it('keeps original acquisition SQL proportional to bound chunks rather than a thousand keys', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        const originalReads: string[] = [];
        reader.$on('query', event => {
            if (/^SELECT\b/.test(event.query) && /FROM "public"\."Session(?:Pending)?Message"/.test(event.query)) originalReads.push(event.query);
        });
        try {
            const sessions = await Promise.all(Array.from({ length: 3 }, () => db.session.create({ data: {
                accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}',
            } })));
            const requests = Array.from({ length: 1000 }, (_, index) => ({ sessionId: sessions[index % sessions.length]!.id, localId: `original-${index}` }));
            const progress = { v: 1, mode: 'wait', disposition: 'inline', outcome: { kind: 'pass' } };
            await db.sessionMessage.createMany({ data: requests.map((key, index) => ({ ...key, seq: index + 1, messageRole: 'user',
                content: { t: 'plain', v: { text: 'Question' } }, replyProgress: progress,
            })) });
            const authentication = createPresentUserSessionAccessAuthentication();
            const result = await reader.$transaction(tx => readSessionMessageRepliesInTx(tx, { accountId: account.id, authentication,
                requests: [...requests, { sessionId: sessions[0]!.id, localId: 'unavailable' }] }));
            expect(result).toHaveLength(1001);
            expect(result.slice(0, 1000).every(row => row.reply.status === 'available')).toBe(true);
            expect(result[1000]!.reply.status).toBe('unavailable');
            expect(originalReads.length).toBeGreaterThan(0);
            expect(originalReads.length).toBeLessThanOrEqual(6);
            const singleton = await reader.$transaction(tx => readSessionMessageReplyInTx(tx, { accountId: account.id, authentication, ...requests[0]! }));
            expect(singleton).toEqual(result[0]!.reply);
        } finally {
            await reader.$disconnect();
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
