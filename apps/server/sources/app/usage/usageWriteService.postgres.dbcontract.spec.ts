import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { recordUsageEvent } from './usageWriteService';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Usage native-history write cost on PostgreSQL', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    let originalTransaction: typeof db.$transaction;
    let accountId: string;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(client.$transaction, client, args);
        } });
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        accountId = account.id;
    });

    afterAll(async () => {
        if (accountId) {
            await db.usageEvent.deleteMany({ where: { accountId } });
            await db.session.deleteMany({ where: { accountId } });
            await db.machine.deleteMany({ where: { accountId } });
        }
        if (accountId) await db.account.delete({ where: { id: accountId } });
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });

    it('filters the native link witness in SQL and reads only matching ids', async () => {
        const machineId = randomUUID();
        const session = await db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const subject = { kind: 'native' as const, machineId, agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
            sourceRootKey: `target-${randomUUID()}`, nativeSessionKey: `session-${randomUUID()}`, linkedSessionId: session.id };
        await db.machine.create({ data: { id: machineId, accountId, metadata: '{}' } });
        await db.usageEvent.create({ data: { accountId, sessionId: session.id, machineId, observedAt: new Date(100), agentId: 'codex',
            source: 'runtime', scope: 'turn_delta', metadata: { accountingSubject: subject, captureOrigin: 'runtime', diagnostic: 'x'.repeat(128 * 1024) } } });
        statements.length = 0;
        const request = UsageEventIngestRequestSchema.parse({ subject, observedAt: 200, agentId: 'codex', source: 'codex-native',
            scope: 'turn_delta', externalKey: randomUUID(), isCumulative: false,
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
            accounting: { status: 'partial', historyComplete: false } });
        await expect(recordUsageEvent(accountId, request)).resolves.toMatchObject({ ok: true });
        const usageSelect = statements.find(event => /^SELECT\b/i.test(event.query.trimStart()) && event.query.includes('"UsageEvent"'));
        expect(usageSelect, 'native witness must issue one bounded UsageEvent select').toBeDefined();
        expect(usageSelect?.query.match(/^SELECT ([\s\S]*?) FROM/)?.[1]).not.toContain('"metadata"');
        console.log(JSON.stringify({ boundary: 'postgresql-native-witness', statements: statements.length,
            usageSelectColumns: usageSelect?.query.match(/SELECT ([\s\S]*?) FROM/)?.[1] ?? null,
            candidateRows: 1, bodyBytesRead: 0 }));
    });
});
