import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getUsageSessionFactKinds, getUsageSessionFactRecordAddress } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { deriveSessionSystemRecordAddressKeys } from '@/app/session/systemRecords/sessionSystemRecordAddressKeys';
import { readActorSessionSystemRecordsV1 } from '@/app/session/systemRecords/sessionSystemRecordService';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';

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
        const sessions = Array.from({ length: 3_368 }, () => ({ id: randomUUID(), accountId: account.id,
            tag: randomUUID(), encryptionMode: 'e2ee', metadata: 'opaque' }));
        try {
            await db.session.createMany({ data: sessions });
            await db.sessionSystemRecord.createMany({ data: sessions.flatMap(session => targets.map(({ address, persisted }) => ({
                accountId: account.id, sessionId: session.id, ...persisted, kind: address.kind,
                ...deriveSessionSystemRecordAddressKeys(persisted), content: { t: 'encrypted', c: address.localId }, version: 1,
            }))) });
            const requested = sessions.slice(0, SESSION_ACCESS_SESSION_BATCH_SIZE + 1);
            let recordReads = 0;
            const stop = observePrismaRequests(db, { before(request) {
                if (request.model === 'SessionSystemRecord' && request.action.startsWith('find')) recordReads++;
            } });
            try {
                const records = await readActorSessionSystemRecordsV1({ actorUserId: account.id,
                    authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                    sessionIds: requested.map(session => session.id), addresses });
                expect(records.size).toBe(requested.length);
                for (const session of requested) expect(records.get(session.id)).toMatchObject({ ok: true,
                    records: targets.map(({ address }) => ({ address, record: { content: { t: 'encrypted', c: address.localId } } })) });
                expect(recordReads).toBe(Math.ceil(requested.length / SESSION_ACCESS_SESSION_BATCH_SIZE));
            } finally { stop(); }
            const keys = targets.map(({ persisted }) => deriveSessionSystemRecordAddressKeys(persisted).recordAddressKey);
            const plan = await db.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(prismaRuntime.sql`
                EXPLAIN (FORMAT JSON) SELECT id FROM "SessionSystemRecord"
                WHERE "accountId" = ${account.id} AND "sessionId" IN (${sessions[0].id})
                  AND "recordAddressKey" IN (${prismaRuntime.join(keys)})`);
            const nodes = JSON.stringify(plan);
            expect(nodes).toContain('Index');
            expect(nodes).not.toContain('Seq Scan');
            console.info(JSON.stringify({ boundary: 'postgresql-scoped-work-facts', sessions: sessions.length,
                records: sessions.length * addresses.length, requestedSessions: requested.length, recordReads,
                narrowReadUsesIndex: true }));
        } finally {
            await db.session.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
