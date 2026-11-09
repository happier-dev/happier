import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { getUsageSessionFactKinds, getUsageSessionFactRecordAddress } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { deriveSessionSystemRecordAddressKeys } from '@/app/session/systemRecords/sessionSystemRecordAddressKeys';
import { readActorSessionSystemRecordsV1 } from '@/app/session/systemRecords/sessionSystemRecordService';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { readSessionTurnsBatch } from '@/app/api/routes/session/readSessionTurns';
import { readSessionMessagePages } from '@/app/api/routes/session/readSessionMessagePages';
import { SESSION_BATCH_MESSAGE_ROLES } from '@/app/api/routes/session/sessionMessagePageProjection';
import { readSessionDetails } from '@/app/api/routes/session/registerSessionListingRoutes';
import { readAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { TransactionDeadlineExceededError } from '@/storage/transactionErrors';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('scoped Usage fact reads on PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    });
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await shutdownDbClient(); });

    it('reads both addresses once per Session batch through indexed record keys', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const addresses = getUsageSessionFactKinds({ includeCoach: true }).map(getUsageSessionFactRecordAddress);
        const targets = addresses.map(address => ({ address, persisted: { ownerKind: address.owner,
            pluginId: null, namespace: address.namespace, localId: address.localId } }));
        // Shared-QA records average about 4 KiB per scoped address (read-only census).
        const ciphertext = (localId: string) => localId + 'x'.repeat(4_096);
        const sessions = Array.from({ length: 3_843 }, () => ({ id: randomUUID(), accountId: account.id,
            tag: randomUUID(), encryptionMode: 'e2ee', metadata: 'opaque' }));
        try {
            await db.session.createMany({ data: sessions });
            await db.sessionSystemRecord.createMany({ data: sessions.flatMap(session => targets.map(({ address, persisted }) => ({
                accountId: account.id, sessionId: session.id, ...persisted, kind: address.kind,
                ...deriveSessionSystemRecordAddressKeys(persisted), content: { t: 'encrypted', c: ciphertext(address.localId) }, version: 1,
            }))) });
            await db.sessionMessage.createMany({ data: sessions.map(session => ({ sessionId: session.id,
                seq: 1, messageRole: 'user', content: { t: 'encrypted', c: ciphertext('message') } })) });
            const requested = sessions;
            let recordReads = 0;
            let pageBodyReads = 0;
            let turnReads = 0;
            let failSession: string | undefined;
            const readFailure = new TransactionDeadlineExceededError(undefined);
            const transactionSubjects = new Map<string, Set<string>>();
            const transactionTimes = new Map<string, { start: number; end: number }>();
            const stop = observePrismaRequests(db, { before(request) {
                if (request.transactionId && !transactionTimes.has(request.transactionId)) transactionTimes.set(request.transactionId,
                    { start: performance.now(), end: performance.now() });
                if (request.model === 'SessionSystemRecord' && request.action.startsWith('find')) recordReads++;
                if (request.model === 'SessionMessage' && request.action === 'findMany') pageBodyReads++;
                if (request.model === 'SessionTurn' && request.action === 'findMany') turnReads++;
                if (request.model === 'Session' && request.action === 'findMany') {
                    // Prisma is the observed IO boundary, using its public query shape.
                    const args = request.args as Prisma.SessionFindManyArgs;
                    const ids = typeof args.where?.id === 'object' ? args.where.id.in : undefined;
                    if (Array.isArray(ids) && failSession && ids.includes(failSession)) throw readFailure;
                    if (Array.isArray(ids) && request.transactionId) transactionSubjects.set(request.transactionId,
                        new Set([...(transactionSubjects.get(request.transactionId) ?? []), ...ids]));
                }
            }, after(request) {
                const timing = request.transactionId && transactionTimes.get(request.transactionId);
                if (timing) timing.end = performance.now();
            } });
            try {
                const started = performance.now();
                const records = await readActorSessionSystemRecordsV1({ actorUserId: account.id,
                    authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                    sessionIds: requested.map(session => session.id), addresses });
                expect(records.size).toBe(requested.length);
                for (const session of requested) expect(records.get(session.id)).toMatchObject({ ok: true,
                    records: targets.map(({ address }) => ({ address, record: { content: { t: 'encrypted', c: ciphertext(address.localId) } } })) });
                expect(recordReads).toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(transactionSubjects.size, 'fact snapshots use the existing Session batches').toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(Math.max(...[...transactionSubjects.values()].map(ids => ids.size)), 'fact snapshots cover one existing Session batch').toBeLessThanOrEqual(SESSION_ACCESS_SESSION_BATCH_SIZE);
                console.info(JSON.stringify({ boundary: 'postgresql-scoped-work-facts', sessions: requested.length,
                    addresses: addresses.length, recordReads, snapshots: transactionSubjects.size,
                    maxSubjectsPerSnapshot: Math.max(...[...transactionSubjects.values()].map(ids => ids.size)),
                    maxObservedSnapshotIoMs: Math.max(...[...transactionTimes.values()].map(t => t.end - t.start)),
                    totalReadAndAssertionMs: performance.now() - started }));
                recordReads = 0;
                transactionSubjects.clear();
                const narrow = await readActorSessionSystemRecordsV1({ actorUserId: account.id,
                    authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                    sessionIds: [requested[0].id], addresses });
                expect(narrow.size).toBe(1);
                expect(recordReads).toBe(1);
                expect([...transactionSubjects.values()].map(ids => ids.size)).toEqual([1]);
                transactionSubjects.clear();
                const input = { userId: account.id,
                    authentication: { env: process.env, authority: 'present_user' as const, authenticationEvidence: undefined },
                    sessionIds: requested.map(session => session.id) };
                expect((await readSessionTurnsBatch(input)).size).toBe(requested.length);
                expect(turnReads).toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(transactionSubjects.size, 'turn snapshots use the existing Session batches').toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(Math.max(...[...transactionSubjects.values()].map(ids => ids.size)), 'turn snapshots cover one existing Session batch').toBeLessThanOrEqual(SESSION_ACCESS_SESSION_BATCH_SIZE);
                transactionSubjects.clear();
                const pages = await readSessionMessagePages({ ...input, includeAccountActors: false });
                expect(pages.size).toBe(requested.length);
                for (const result of pages.values()) expect(result).toMatchObject({ status: 'fulfilled', value: {
                    status: 200, body: { messages: [{ content: { t: 'encrypted', c: ciphertext('message') } }] } } });
                const expectedPageReads = Array.from({ length: Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE) }, (_, batch) =>
                    portableQueryChunks({ values: requested.slice(batch * SESSION_ACCESS_SESSION_BATCH_SIZE, (batch + 1) * SESSION_ACCESS_SESSION_BATCH_SIZE),
                        bindingsPerValue: SESSION_BATCH_MESSAGE_ROLES.length + 3 }).length).reduce((sum, count) => sum + count, 0);
                expect(pageBodyReads).toBe(expectedPageReads);
                expect.soft(transactionSubjects.size, 'transcript snapshots use the existing Session batches').toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(Math.max(...[...transactionSubjects.values()].map(ids => ids.size)), 'transcript snapshots cover one existing Session batch').toBeLessThanOrEqual(SESSION_ACCESS_SESSION_BATCH_SIZE);
                transactionSubjects.clear();
                const detailInput = { ...input, usageProjection: true, includePrivateRuleProjection: false,
                    storedContentCompatibility: readAccountStoredContentCompatibilityForHttpRequest({ headers: currentAccountStoredContentCompatibilityHeaders }) };
                const details = await readSessionDetails(detailInput);
                expect([...details.values()].every(result => result.status === 'fulfilled' && result.value.status === 200)).toBe(true);
                expect.soft(transactionSubjects.size, 'detail snapshots use the existing Session batches').toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
                expect.soft(Math.max(...[...transactionSubjects.values()].map(ids => ids.size)), 'detail snapshots cover one existing Session batch').toBeLessThanOrEqual(SESSION_ACCESS_SESSION_BATCH_SIZE);
                failSession = requested[SESSION_ACCESS_SESSION_BATCH_SIZE].id;
                const failedFacts = await readActorSessionSystemRecordsV1({ actorUserId: account.id,
                    authentication: input.authentication, sessionIds: input.sessionIds, addresses });
                expect.soft(failedFacts.get(failSession)).toMatchObject({ ok: false, cause: readFailure });
                expect([...failedFacts.values()].filter(result => !result.ok)).toHaveLength(SESSION_ACCESS_SESSION_BATCH_SIZE);
                expect(failedFacts.get(requested[0].id)?.ok).toBe(true);
                expect(failedFacts.get(requested.at(-1)!.id)?.ok).toBe(true);
                const failedTurns = await readSessionTurnsBatch(input);
                expect([...failedTurns.values()].filter(result => result.status === 'rejected')).toHaveLength(SESSION_ACCESS_SESSION_BATCH_SIZE);
                expect(failedTurns.get(requested[0].id)?.status).toBe('fulfilled');
                expect(failedTurns.get(requested.at(-1)!.id)?.status).toBe('fulfilled');
                const failedPages = await readSessionMessagePages({ ...input, includeAccountActors: false });
                expect([...failedPages.values()].filter(result => result.status === 'rejected')).toHaveLength(SESSION_ACCESS_SESSION_BATCH_SIZE);
                expect(failedPages.get(requested[0].id)?.status).toBe('fulfilled');
                expect(failedPages.get(requested.at(-1)!.id)?.status).toBe('fulfilled');
                const failedDetails = await readSessionDetails(detailInput);
                expect([...failedDetails.values()].filter(result => result.status === 'rejected')).toHaveLength(SESSION_ACCESS_SESSION_BATCH_SIZE);
                expect(failedDetails.get(requested[0].id)?.status).toBe('fulfilled');
                expect(failedDetails.get(requested.at(-1)!.id)?.status).toBe('fulfilled');
            } finally { stop(); }
            const keys = targets.map(({ persisted }) => deriveSessionSystemRecordAddressKeys(persisted).recordAddressKey);
            const plan = await db.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(prismaRuntime.sql`
                EXPLAIN (FORMAT JSON) SELECT id FROM "SessionSystemRecord"
                WHERE "accountId" = ${account.id} AND "sessionId" IN (${sessions[0].id})
                  AND "recordAddressKey" IN (${prismaRuntime.join(keys)})`);
            const nodes = JSON.stringify(plan);
            expect(nodes).toContain('Index');
            expect(nodes).not.toContain('Seq Scan');
        } finally {
            await db.sessionMessage.deleteMany({ where: { session: { accountId: account.id } } });
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
