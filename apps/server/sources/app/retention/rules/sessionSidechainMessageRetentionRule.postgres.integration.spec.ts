import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { SidechainRetentionCursor } from './sessionSidechainMessageRetentionRule';

// Replace only the persistence boundary with a real, isolated PostgreSQL client.
const boundary = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock('@/storage/db', () => ({ db: new Proxy({}, {
    get: (_target, key) => {
        const client = boundary.client!;
        const value = Reflect.get(client, key);
        return typeof value === 'function' ? value.bind(client) : value;
    },
}) }));

const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
describe.skipIf(!databaseUrl)('sidechain retention PostgreSQL walk cost', () => {
    const schema = `sidechain_cost_${randomUUID().replaceAll('-', '')}`;
    const queries: Array<{ query: string; params: string }> = [];
    const url = new URL(databaseUrl ?? 'postgresql://localhost/unused');
    url.searchParams.set('schema', schema);
    const client = new PrismaClient({
        datasources: { db: { url: url.toString() } },
        log: [{ emit: 'event', level: 'query' }],
    });
    client.$on('query', event => queries.push(event));

    beforeAll(async () => {
        boundary.client = client;
        await client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await client.$executeRawUnsafe(`CREATE TABLE "${schema}"."Session" (id text PRIMARY KEY)`);
        await client.$executeRawUnsafe(`CREATE TABLE "${schema}"."SessionMessage" (
            id text PRIMARY KEY, "sessionId" text NOT NULL, "sidechainId" text,
            seq integer NOT NULL, "createdAt" timestamp NOT NULL)`);
        await client.$executeRawUnsafe(`CREATE INDEX ON "${schema}"."SessionMessage" ("sessionId", seq)`);
        await client.$executeRawUnsafe(`CREATE INDEX ON "${schema}"."SessionMessage" ("sessionId", "sidechainId", seq)`);
        await client.$executeRawUnsafe(`INSERT INTO "${schema}"."Session"
            SELECT 's' || lpad(s::text, 3, '0') FROM generate_series(1, 40) s`);
    });
    afterAll(async () => {
        await client.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        await client.$disconnect();
    });

    it('keeps buffers per candidate independent of main-chain length, including resume', async () => {
        const { runSessionSidechainMessageRetentionRule } = await import('./sessionSidechainMessageRetentionRule');
        async function measure(mainRows: number) {
            await client.$executeRawUnsafe(`TRUNCATE "${schema}"."SessionMessage"`);
            await client.$executeRawUnsafe(`INSERT INTO "${schema}"."SessionMessage"
                SELECT s.id || ':' || n, s.id, NULL, n, '2027-01-01'::timestamp
                FROM "${schema}"."Session" s CROSS JOIN generate_series(1, ${mainRows}) n`);
            await client.$executeRawUnsafe(`INSERT INTO "${schema}"."SessionMessage"
                SELECT s || ':' || c, s, c, ${mainRows} + row_number() OVER ()::int, '2027-01-01'::timestamp
                FROM (VALUES ('s020'), ('s040')) sessions(s) CROSS JOIN (VALUES ('a'), ('b')) chains(c)`);
            await client.$executeRawUnsafe(`VACUUM ANALYZE "${schema}"."SessionMessage"`);
            await client.$executeRawUnsafe(`ANALYZE "${schema}"."Session"`);
            queries.length = 0;
            const results = [];
            let startCursor: SidechainRetentionCursor | null = null;
            for (let i = 0; i < 4; i++) {
                const result = await runSessionSidechainMessageRetentionRule({
                    cutoff: new Date('2026-01-01'), batchSize: 1, dryRun: true,
                    maxDeletesPerRulePerRun: 1, maxCandidatesPerRulePerRun: 1,
                    startCursor, persistCursor: false,
                });
                results.push(result.nextCursor);
                startCursor = result.nextCursor;
            }
            expect(results).toEqual([
                { sessionId: 's020', sidechainId: 'a' }, { sessionId: 's020', sidechainId: 'b' },
                { sessionId: 's040', sidechainId: 'a' }, { sessionId: 's040', sidechainId: 'b' },
            ]);
            const reads = queries.filter(q => q.query.startsWith('SELECT'));
            let buffers = 0;
            for (const read of reads) {
                const [plan] = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, number> }> }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${read.query}`, ...JSON.parse(read.params),
                );
                buffers += (plan['QUERY PLAN'][0].Plan['Shared Hit Blocks'] ?? 0)
                    + (plan['QUERY PLAN'][0].Plan['Shared Read Blocks'] ?? 0);
            }
            return { mainRows, buffersPerCandidate: buffers / 4, queries: reads.length };
        }
        const small = await measure(200);
        const large = await measure(4000);
        console.info('sidechain-walk-cost', JSON.stringify({ small, large }));
        // 20x more main-chain rows may deepen an index, but must not produce a linear scan.
        expect(large.buffersPerCandidate).toBeLessThan(small.buffersPerCandidate * 2);
    });
});
