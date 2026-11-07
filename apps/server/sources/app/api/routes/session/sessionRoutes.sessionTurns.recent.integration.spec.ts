import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionTurnMutationRoute } from './registerSessionTurnMutationRoute';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

describe('recent committed Session turns (HTTP storage contract)', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'recent-turns-', initAuth: false });
    });
    afterAll(async () => { await harness?.close(); });

    it('returns two recent committed rows, independent of history, retaining anchors and denial', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        try {
            await db.sessionTurn.createMany({ data: Array.from({ length: 300 }, (_, i) => ({
                sessionId: session.id, turnId: `turn-${i}`, status: i === 299 ? 'in_progress' : 'completed',
                initiator: 'workflow', startedAt: BigInt(i), updatedAt: BigInt(600 - i),
                transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: i + 1, endSeqInclusive: i + 1 }),
            })) });
            let turnReads = 0;
            let turnRows = 0;
            const stop = observePrismaRequests(db, { after: (request, result) => {
                if (request.model === 'SessionTurn' && request.action === 'findMany') {
                    turnReads++;
                    if (Array.isArray(result)) turnRows += result.length;
                }
            } });
            try {
            await withAuthenticatedTestApp(app => registerSessionTurnMutationRoute(app), async app => {
                const response = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns?recentCommittedTurns=2`,
                    headers: { 'x-test-user-id': account.id } });
                expect(response.statusCode).toBe(200);
                const projection = SessionTurnsProjectionV1Schema.parse(response.json());
                expect(projection.turns.map(turn => turn.turnId)).toEqual(['turn-297', 'turn-298']);
                expect(projection.turns[0]?.transcriptAnchors).toEqual({ startSeqInclusive: 298, endSeqInclusive: 298 });
                expect({ turnReads, turnRows }).toEqual({ turnReads: 1, turnRows: 2 });
                const denied = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns?recentCommittedTurns=2`,
                    headers: { 'x-test-user-id': outsider.id } });
                expect(denied.statusCode).toBe(404);
                const full = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns`, headers: { 'x-test-user-id': account.id } });
                expect(SessionTurnsProjectionV1Schema.parse(full.json()).turns).toHaveLength(300);
                await db.session.update({ where: { id: session.id }, data: { currentStorageState: 'materializing' } });
                turnReads = 0;
                turnRows = 0;
                const unpublished = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}/turns?recentCommittedTurns=2`,
                    headers: { 'x-test-user-id': account.id } });
                expect(SessionTurnsProjectionV1Schema.parse(unpublished.json()).turns).toEqual([]);
                expect({ turnReads, turnRows }).toEqual({ turnReads: 0, turnRows: 0 });
            });
            } finally { stop(); }
        } finally {
            await db.sessionTurn.deleteMany({ where: { sessionId: session.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.account.deleteMany({ where: { id: { in: [account.id, outsider.id] } } });
        }
    });
});
