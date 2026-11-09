import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionExternalShareableMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { registerSessionMessageRoutes } from '@/app/api/routes/session/registerSessionMessageRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { backfillSessionTurnTranscriptAnchorProjectionPage } from './sessionTurnTranscriptAnchorProjectionBackfill';

describe('demand-scoped turn anchor projection (PostgreSQL)', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || process.env.HAPPIER_DB_PROVIDER !== 'postgres') {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        harness = await createDatabaseIntegrationHarness({
            tempDirPrefix: 'turn-anchor-demand-',
            initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' },
        });
    });
    afterAll(async () => { await harness?.close(); });

    it('prepares only the admitted Session on its first projected read', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const otherAccount = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const accountIds = [account.id, otherAccount.id];
        const sessionIds: string[] = [];
        try {
            const createSession = (accountId: string) => db.session.create({ data: {
                accountId, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 2,
            } });
            const requested = await createSession(account.id);
            const unrelated = await createSession(otherAccount.id);
            sessionIds.push(requested.id, unrelated.id);
            for (const session of [requested, unrelated]) {
                await db.sessionTurn.create({ data: {
                    sessionId: session.id, turnId: 'lazy-turn', status: 'completed', startedAt: 1n, updatedAt: 2n,
                    transcriptAnchorsJson: JSON.stringify({
                        startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1,
                        endSeqInclusive: 2, finalAssistantMessageSeq: 2,
                    }),
                } });
                await db.sessionMessage.createMany({ data: [1, 2].map(seq => ({
                    sessionId: session.id, seq, messageRole: seq === 1 ? 'user' : 'agent',
                    content: { t: 'plain', v: {
                        role: seq === 1 ? 'user' : 'agent', content: { type: 'text', text: 'message' },
                    } },
                    ...(seq === 1 ? { inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } } : {}),
                })) });
            }
            await withAuthenticatedTestApp(registerSessionMessageRoutes, async app => {
                const url = `/v1/sessions/${requested.id}/messages?afterSeq=0&projection=externalShareableV1`;
                const denied = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': otherAccount.id } });
                expect(denied.statusCode).toBe(404);
                expect(await db.sessionTurn.count({ where: {
                    sessionId: { in: [requested.id, unrelated.id] }, transcriptAnchorProjectionVersion: 1,
                } })).toBe(0);
                const read = await app.inject({ method: 'GET', url, headers: {
                    'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4',
                } });
                expect(read.statusCode).toBe(200);
                expect(SessionExternalShareableMessagesPageV1Schema.parse(read.json())).toMatchObject({
                    hasMore: false,
                    externalShareableSnapshot: { turns: [expect.objectContaining({ turnId: 'lazy-turn' })] },
                });
                expect(await db.sessionTurn.count({ where: {
                    sessionId: requested.id, transcriptAnchorProjectionVersion: 1,
                } })).toBe(1);
                expect(await db.sessionTurn.count({ where: {
                    sessionId: unrelated.id, transcriptAnchorProjectionVersion: 1,
                } })).toBe(0);
            });
        } finally {
            await db.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
            await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
    });

    it('reads only stale turns in the demanded Session even beside a thousand unrelated turns', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        try {
            const requested = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
            const unrelated = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}' } });
            await db.sessionTurn.createMany({ data: Array.from({ length: 1_001 }, (_, index) => ({
                sessionId: index === 1_000 ? requested.id : unrelated.id, turnId: `fixture-${index}`,
                status: 'completed', startedAt: 1n, updatedAt: 2n,
                transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 2 }),
            })) });
            const startedAt = performance.now();
            const measured = await inTx(async tx => {
                const observation = observePrismaReads(tx, ['sessionTurn']);
                const page = await backfillSessionTurnTranscriptAnchorProjectionPage({
                    db: observation.tx, ...{ sessionId: requested.id },
                });
                return { page, reads: observation.reads, rows: observation.rows, updates: observation.updates };
            });
            console.log(JSON.stringify({ measurement: 'turn-anchor-demand', fixtureRows: 1_001,
                transferredRows: measured.rows.reduce((sum, row) => sum + row.count, 0), durationMs: performance.now() - startedAt }));
            expect(measured.page).toEqual({ processed: 1, updated: 1, nextAfterId: null });
            expect(measured.reads).toEqual(['sessionTurn.findMany']);
            expect(measured.rows.map(row => row.count)).toEqual([1]);
            expect(await db.sessionTurn.count({ where: { sessionId: unrelated.id, transcriptAnchorProjectionVersion: 1 } })).toBe(0);
            const warm = await inTx(async tx => {
                const observation = observePrismaReads(tx, ['sessionTurn']);
                const page = await backfillSessionTurnTranscriptAnchorProjectionPage({
                    db: observation.tx, ...{ sessionId: requested.id },
                });
                return { page, rows: observation.rows, updates: observation.updates };
            });
            expect(warm.page).toEqual({ processed: 0, updated: 0, nextAfterId: null });
            expect(warm.rows.map(row => row.count)).toEqual([0]);
            expect(warm.updates).toEqual([]);
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
