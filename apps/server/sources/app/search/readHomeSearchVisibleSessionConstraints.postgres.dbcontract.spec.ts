import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { MemorySearchScope } from '@happier-dev/protocol/memory/memorySearch';
import { perfFixtureId } from '../../../../../packages/tests/src/testkit/stress/scenarios/perfProfile';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { readHomeSearchVisibleSessionConstraints } from './readHomeSearchVisibleSessionConstraints';
import { readCanonicalSessionMessagesPage } from './homeSearchCanonicalSessionMessages';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Home search scoped visibility query (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); });

    it('pages canonical transcripts only inside demanded Sessions, including a shared Session', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const sessions = await Promise.all([owner, other, other].map((account) => db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        } })));
        await db.sessionMessage.createMany({ data: sessions.flatMap((session, sessionIndex) => [0, 1].map(seq => ({
            id: `demand-${owner.id}-${sessionIndex}-${seq}`, sessionId: session.id, seq, localId: `demand-${seq}`,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'scoped canonical projection' } } },
        }))) });
        const selectedIds = sessions.slice(0, 2).map(session => session.id);
        const originalFindMany = db.sessionMessage.findMany;
        const traced = client!;
        db.sessionMessage.findMany = new Proxy(originalFindMany, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.sessionMessage.findMany, traced.sessionMessage, args);
        } });
        try {
            statements.length = 0;
            const first = await readCanonicalSessionMessagesPage({ sessionIds: selectedIds, limit: 3 });
            const second = await readCanonicalSessionMessagesPage({ sessionIds: selectedIds, limit: 3, afterId: first.nextAfterId });
            expect(first.messages).toHaveLength(3);
            expect(second.messages).toHaveLength(1);
            expect(second.nextAfterId).toBeUndefined();
            expect(new Set([...first.messages, ...second.messages].map(message => message.sessionId))).toEqual(new Set(selectedIds));
            const reads = statements.filter(event => event.query.includes('FROM "public"."SessionMessage"'));
            expect(reads).toHaveLength(2);
            expect(reads.every(event => /"sessionId" IN/.test(event.query))).toBe(true);
            console.info('HOME_SEARCH_DEMAND_CANONICAL_POSTGRES', JSON.stringify({
                pages: reads.length, statements: statements.length, rows: first.messages.length + second.messages.length,
            }));
        } finally { db.sessionMessage.findMany = originalFindMany; }
    });

    it('reads only the selected Session while retaining global visibility, publication ceilings and revocation', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const selected = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 2,
            currentStorageState: 'snapshot_complete', acceptedThroughServerSeq: null,
            materializationPublicationId: randomUUID(), materializedThroughSourceAt: 1n, publishedThroughServerSeq: 1,
        } });
        await db.session.createMany({ data: Array.from({ length: 999 }, (_, index) => ({
            id: perfFixtureId(20261023, 'home-search-postgres', index), accountId: viewer.id,
            tag: `home-search-postgres-${index}`, metadata: '{}', encryptionMode: 'plain', currentStorageState: 'hosted',
        })) });
        const team = await db.team.create({ data: { name: 'Scoped search contract' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        await db.sessionTeamGrant.create({ data: { sessionId: selected.id, teamId: team.id,
            accessLevel: 'view', effectiveAt: new Date() } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const originalTransaction = db.$transaction;
        const traced = client!;
        // Observe engine SQL at the genuine database transport; domain admission
        // and the exact query owner wired into startApi remain unchanged.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            const observations: Array<{ name: string; rows: number; statements: number; sessionSelects: number }> = [];
            const read = async (name: string, accountId: string, scope: MemorySearchScope) => {
                statements.length = 0;
                const constraints = await readHomeSearchVisibleSessionConstraints({ accountId, authentication, scope });
                const sessionSelects = statements.filter(event => /^SELECT\b/.test(event.query)
                    && event.query.includes('FROM "public"."Session"'));
                observations.push({ name, rows: constraints.length, statements: statements.length, sessionSelects: sessionSelects.length });
                expect(sessionSelects).toHaveLength(1);
                return constraints;
            };
            const scope = { type: 'session' as const, sessionId: selected.id };
            expect(await read('selected', viewer.id, scope)).toEqual([{ sessionId: selected.id, maximumSeq: 1 }]);
            const global = await read('global', viewer.id, { type: 'global' });
            expect(global).toHaveLength(1000);
            expect(global.find(row => row.sessionId === selected.id)?.maximumSeq).toBe(1);
            expect(await read('outsider', outsider.id, scope)).toEqual([]);
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: viewer.id } });
            expect(await read('revoked', viewer.id, scope)).toEqual([]);
            const remaining = await read('global-after-revoke', viewer.id, { type: 'global' });
            expect(remaining).toHaveLength(999);
            expect(remaining.some(row => row.sessionId === selected.id)).toBe(false);
        } finally { db.$transaction = originalTransaction; }
    });
});
