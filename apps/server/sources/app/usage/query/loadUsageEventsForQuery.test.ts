import { expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import type { ScopedUsageEventDbRow } from './scopedUsageEventRow';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { loadUsageEventsForQuery } from './loadUsageEventsForQuery';

const dayMs = 86_400_000;
const row = (id: string, at: number): ScopedUsageEventDbRow => ({
    id, observedAt: new Date(at), createdAt: new Date(at), sessionId: null,
    agentId: 'codex', backendMode: null, modelId: 'rig-model', projectKey: null, workspaceId: null, machineId: null,
    source: 'runtime', scope: 'turn_delta', isCumulative: false, turnId: null, requestCount: 1,
    teamCredentialResourceId: null, teamCredentialActorAccountId: null, teamCredentialExternalApiKeyId: null,
    teamCredentialSourceCredentialId: null, brokerMachineId: null, credentialDeliveryMode: null,
    inputTokens: 1, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1,
    reportedCostUsd: null, estimatedCostUsd: null, invoiceCostUsd: null, billingContext: null, costSource: null,
    currency: 'USD', costBreakdown: null, contextUsedTokens: null, contextWindowTokens: null,
});

for (const provider of ['postgres', 'sqlite'] as const) {
    it.each(['full', 'day-only'] as const)(`preserves a large ordered ${provider} %s population across storage reads`, async selection => {
        const previous = process.env.HAPPIER_DB_PROVIDER;
        process.env.HAPPIER_DB_PROVIDER = provider;
        // One admitted day alone exceeds V8's argument-spread capacity. Reverse
        // the day selection so concatenating partitions also needs global order.
        const expected = Array.from({ length: 150_000 }, (_, index) => row(`early-${index}`, 100 * dayMs + index));
        expected.push(row('late-first', 350 * dayMs), row('late-last', 351 * dayMs - 1));
        const select = (ranges?: readonly Readonly<{ start: number; end: number }>[]) => ranges
            ? expected.filter(value => ranges.some(range => value.observedAt.getTime() >= range.start && value.observedAt.getTime() < range.end))
            : expected;
        // Only the persistent storage boundary is substituted. The real loader
        // emits SQL/Prisma predicates and partitions; each response models ORDER BY.
        const tx = {
            $queryRaw: async (sql: Prisma.Sql) => {
                const operands = sql.values.slice(1, -TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.length);
                const ranges = Array.from({ length: operands.length / 2 }, (_, index) => ({
                    start: Date.parse(String(operands[index * 2])), end: Date.parse(String(operands[index * 2 + 1])),
                }));
                return select(ranges.length ? ranges : undefined);
            },
            usageEvent: { findMany: async (query: { where: { OR?: readonly { observedAt: { gte: Date; lt: Date } }[] } }) =>
                select(query.where.OR?.map(value => ({ start: value.observedAt.gte.getTime(), end: value.observedAt.lt.getTime() }))) },
        } as unknown as Tx;
        try {
            const days = selection === 'day-only' ? Array.from({ length: 500 }, (_, index) => (499 - index) * dayMs) : undefined;
            const actual = await loadUsageEventsForQuery(tx, 'owner', {}, undefined, days);
            expect(actual.map(value => value.id)).toEqual(expected.map(value => value.id));
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        }
    });
}
