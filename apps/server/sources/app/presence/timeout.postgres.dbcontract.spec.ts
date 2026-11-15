import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createSessionPresenceDeadlineOwner, runPresenceTimeoutTick } from './timeout';

interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Actual Rows': number;
    'Actual Loops': number;
    'Rows Removed by Filter'?: number;
    'Rows Removed by Index Recheck'?: number;
    Plans?: PlanNode[];
}

const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];

/** Query events carry Dates as text; type them back for EXPLAIN. */
function inlineParams(sql: string, params: unknown[]): string {
    const literal = (value: unknown): string => value === null ? 'NULL'
        : typeof value === 'number' || typeof value === 'boolean' ? String(value)
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)
            ? `'${value}'::timestamptz::timestamp`
            : `'${String(value).replaceAll("'", "''")}'`;
    let result = sql;
    for (let index = params.length; index >= 1; index -= 1) result = result.replaceAll(`$${index}`, literal(params[index - 1]));
    return result;
}

/**
 * The Session presence deadline wakes once per timeout window on every server
 * with a live Session. Its next-due and expiry reads must read the live
 * Sessions only, never the server's whole Session history (every Account).
 */
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session presence deadline reads (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'> | undefined;
    let barrier: (() => void) | undefined;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => {
            if (event.query === 'SELECT 1 /* presence-deadline-barrier */') barrier?.();
            else statements.push(event);
        });
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); vi.unstubAllEnvs(); });

    const drain = async () => {
        const observed = new Promise<void>(resolve => { barrier = resolve; });
        try {
            await client!.$queryRawUnsafe('SELECT 1 /* presence-deadline-barrier */');
            await observed;
        } finally { barrier = undefined; }
    };

    it('finds the next due and the expired live Sessions without scanning inactive history', async () => {
        const historyAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
        const liveAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
        const now = Date.now();
        const inactive = 3_000;
        await db.session.createMany({ data: Array.from({ length: inactive }, (_, index) => ({
            accountId: historyAccount.id, tag: `history-${index}`, metadata: '{}', encryptionMode: 'plain', active: false,
            lastActiveAt: new Date(now - (index + 1) * 3_600_000),
        })) });
        const live = 3;
        await db.session.createMany({ data: Array.from({ length: live }, (_, index) => ({
            accountId: liveAccount.id, tag: `live-${index}`, metadata: '{}', encryptionMode: 'plain', active: true,
            lastActiveAt: new Date(now - index * 1_000),
        })) });
        await db.$executeRawUnsafe('ANALYZE "Session"');

        // The owner's own reads run unchanged; only their transport logs the SQL for EXPLAIN.
        const session = db.session;
        const original = { findFirst: session.findFirst, findMany: session.findMany };
        Object.defineProperty(session, 'findFirst', { configurable: true, writable: true, value: client!.session.findFirst.bind(client!.session) });
        Object.defineProperty(session, 'findMany', { configurable: true, writable: true, value: client!.session.findMany.bind(client!.session) });
        const config = { sessionTimeoutMs: 120_000, machineTimeoutMs: 120_000, tickMs: 5_000 };
        await drain();
        statements.length = 0;
        const owner = createSessionPresenceDeadlineOwner(config);
        try {
            await owner.start();
            await runPresenceTimeoutTick(config);
        } finally {
            await owner.stop();
            Object.defineProperty(session, 'findFirst', { configurable: true, writable: true, value: original.findFirst });
            Object.defineProperty(session, 'findMany', { configurable: true, writable: true, value: original.findMany });
        }
        await drain();

        const reads = statements.filter(({ query }) => /^\s*SELECT\b/i.test(query) && query.includes('FROM "public"."Session"'));
        expect(reads.length).toBe(2);
        const shapes = [];
        for (const { query, params } of reads) {
            const [explained] = await client!.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${inlineParams(query, JSON.parse(params))}`);
            const scans = planNodes(explained!['QUERY PLAN'][0]!.Plan).filter(node => node['Relation Name'] === 'Session');
            shapes.push({
                seqScan: scans.some(node => node['Node Type'].includes('Seq Scan')),
                sessionRowsRead: scans.reduce((total, node) => total + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
                    + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'], 0),
            });
        }
        // Each read touches at most the live Sessions, whatever the inactive history.
        expect(shapes.map(shape => ({ seqScan: shape.seqScan, readsOnlyLive: shape.sessionRowsRead <= live })), JSON.stringify(shapes))
            .toEqual(reads.map(() => ({ seqScan: false, readsOnlyLive: true })));
    });
});
