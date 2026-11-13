import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { setSessionManagerInTx } from '@/app/session/follow/sessionManagerService';
import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';

describe('SessionManager Home fence', () => {
    let connected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the disposable DB-contract lane');
        const provider = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? 'postgres').toLowerCase();
        if (provider === 'mysql') await initDbMysql();
        else if (provider === 'postgres' || provider === 'postgresql') initDbPostgres();
        else throw new Error(`Unsupported manager fence contract provider: ${provider}`);
        await db.$connect();
        connected = true;
    });

    afterAll(async () => {
        if (connected) await db.$disconnect();
    });

    it('commits exactly one opposite reparent under three concurrent acting Accounts without a cycle', async () => {
        const accounts = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: `reports-to-fence-${randomUUID()}`, encryptionMode: 'plain' },
        })));
        const [first, second] = await Promise.all(accounts.slice(0, 2).map((account) => db.session.create({
            data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' },
        })));
        // Every actor has real input authority on both endpoints. The audience
        // is identical in both directions, so only cycle/CAS can refuse a move.
        await db.sessionGrant.createMany({
            data: ([first, second].flatMap((session) => accounts
                .filter((account) => account.id !== session.accountId)
                .map((account) => ({
                    sessionId: session.id,
                    createdByAccountId: session.accountId,
                    accountId: account.id,
                    accessLevel: 'edit',
                })))).map(data => ({ ...data, principalKind: 'account' })),
        });
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        let entered = 0;
        let release!: () => void;
        const allEntered = new Promise<void>((resolve) => { release = resolve; });
        const contenders = accounts.map((account, index) => inTx(async (tx) => {
            // Start all transactions before entering the real service. SELECT 1
            // creates no MySQL repeatable-read snapshot of relation state. The
            // barrier precedes the fence, so it cannot hold the winner's lock.
            await tx.$queryRaw`SELECT 1`;
            entered += 1;
            if (entered === accounts.length) release();
            await allEntered;
            return setSessionManagerInTx(tx, {
                accountId: account.id,
                sessionId: index === 1 ? second.id : first.id,
                managerSessionId: index === 1 ? first.id : second.id,
                expectedManagerSessionId: null,
                authentication,
            });
        }));
        const results = await Promise.all(contenders);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual(expect.arrayContaining([
            expect.objectContaining({ ok: false, error: 'manager_cycle' }),
        ]));
        for (const result of results) {
            if (!result.ok) expect(['manager_cycle', 'manager_cas_conflict']).toContain(result.error);
        }
        const edges = await db.sessionFollowEdge.findMany({
            where: { relation: 'manager', sourceSessionId: { in: [first.id, second.id] } },
            select: { sourceSessionId: true, destinationSessionId: true },
        });
        expect(edges).toHaveLength(1);
        const winner = results.find((result) => result.ok);
        expect(winner?.ok && edges[0]).toEqual(winner?.ok ? {
            sourceSessionId: winner.sessionId,
            destinationSessionId: winner.managerSessionId,
        } : undefined);
    });
});
