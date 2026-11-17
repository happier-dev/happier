import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { recordUsageEvent } from './usageWriteService';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createUsageSnapshot } from '@/app/api/routes/connect/providerAccountUsageTestkit';
import { writeProviderAccountUsageRecordWithPolicy } from '@/app/api/routes/connect/providerAccountUsage/routeWritePolicy';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Usage native-history write cost on PostgreSQL', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;
    let accountId: string;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Requires the disposable PostgreSQL DB-contract owner');
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
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

    it('lets an Account writer commit during a material usage write without serialization retries or a second parent update', async () => {
        const fetchedAt = Date.now() - 2_000;
        const initial = createUsageSnapshot({ fetchedAt, planLabel: 'before' });
        const write = (snapshot: typeof initial, beforeWrite?: () => Promise<void>) => writeProviderAccountUsageRecordWithPolicy({
            accountId, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1',
            status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot, beforeWrite,
        });
        expect(await write(initial)).toBe('written');
        const before = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true, settingsVersion: true } });
        statements.length = 0;
        let accountCommitted = false;
        const changed = createUsageSnapshot({ fetchedAt: fetchedAt + 1, planLabel: 'after' });
        await expect(write(changed, async () => {
            // The Usage transaction has already admitted Account content and read
            // the record. NOWAIT detects an early exclusive Account lock without
            // a timing threshold; both transactions overlap until this commits.
            await client.$transaction(async peer => {
                await peer.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${accountId} FOR NO KEY UPDATE NOWAIT`;
                await peer.account.update({ where: { id: accountId }, data: { settingsVersion: { increment: 1 } } });
            });
            accountCommitted = true;
        })).resolves.toBe('written');
        expect(accountCommitted).toBe(true);
        const after = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true, settingsVersion: true } });
        expect(after.settingsVersion).toBe(before.settingsVersion + 1);
        expect(after.seq).toBeGreaterThan(before.seq); // Usage publication survives the competing writer.
        expect(await db.providerAccountUsageHistory.count({ where: { accountId, recordId: initial.recordId } })).toBe(2);
        expect(statements.filter(event => /^UPDATE\b/i.test(event.query.trimStart())
            && event.query.includes('"ProviderAccountUsageRecord"'))).toHaveLength(1);
        expect(statements.filter(event => /^ROLLBACK\b/i.test(event.query.trimStart()))).toHaveLength(0);
    });
});
