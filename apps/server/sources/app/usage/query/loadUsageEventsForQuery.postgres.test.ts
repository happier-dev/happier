import { expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { loadUsageEventsForQuery } from './loadUsageEventsForQuery';
import { UsageAnalyticsQueryRequestSchema, UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

it('keeps every PostgreSQL day operand below the portable transport boundary even without a history start', async () => {
    const priorProvider = process.env.HAPPIER_DB_PROVIDER;
    process.env.HAPPIER_DB_PROVIDER = 'postgres';
    const statements: Prisma.Sql[] = [];
    // Only storage is substituted: the real SQL owner builds every statement.
    const tx = { $queryRaw: async (query: Prisma.Sql) => { statements.push(query); return []; } } as unknown as Tx;
    const dayMs = 86_400_000;
    // Public ingest rejects pre-epoch clocks but accepts future clocks. The
    // same warm caller accepts an omitted or future end, without a history cap.
    const firstDay = 0;
    const days = Array.from({ length: 33_000 }, (_, index) => firstDay + index * dayMs);
    try {
        const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { endMs: days.length * dayMs } });
        expect(UsageEventIngestRequestSchema.safeParse({ sessionId: 'session', observedAt: days.at(-1)!,
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD' },
        }).success).toBe(true);
        expect(await loadUsageEventsForQuery(tx, 'owner', request, undefined, days)).toEqual([]);
        expect(statements.length).toBeGreaterThan(1);
        expect(statements.every(query => query.values.length <= 999)).toBe(true);
        const dayOperands = statements.flatMap(query => query.values.slice(2, -TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.length));
        expect(dayOperands).toEqual(days.flatMap(day => [new Date(day).toISOString(), new Date(day + dayMs).toISOString()]));
        expect(statements.every(query => query.sql.includes('ORDER BY "observedAt" ASC'))).toBe(true);
    } finally {
        if (priorProvider === undefined) delete process.env.HAPPIER_DB_PROVIDER;
        else process.env.HAPPIER_DB_PROVIDER = priorProvider;
    }
});
