import { describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { projectUsageAnalytics, type UsageAnalyticsSnapshot } from './usageQueryService';

type CapturedRow = UsageAnalyticsSnapshot['rows'][number];
const subject = { kind: 'native', machineId: 'machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
    sourceRootKey: 'root', nativeSessionKey: 'native', linkedSessionId: 'session' };

function row(id: string, total: number, metadata: CapturedRow['metadata'], options: Partial<Pick<CapturedRow, 'sessionId' | 'source'>> = {}): CapturedRow {
    return {
        id, sessionId: 'session', observedAt: new Date(100), createdAt: new Date(100), agentId: 'codex',
        backendMode: null, modelId: null, projectKey: null, workspaceId: null, machineId: 'machine',
        source: 'runtime', scope: 'turn_delta', isCumulative: false, turnId: id, externalKey: null, metadata,
        requestCount: 1, teamCredentialResourceId: null, teamCredentialActorAccountId: null,
        teamCredentialExternalApiKeyId: null, teamCredentialSourceCredentialId: null,
        brokerMachineId: null, credentialDeliveryMode: null, inputTokens: total, outputTokens: 0,
        reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total,
        reportedCostUsd: 0, estimatedCostUsd: 0, invoiceCostUsd: 0, billingContext: null, costSource: null,
        currency: 'USD', costBreakdown: null, contextUsedTokens: null, contextWindowTokens: null, ...options,
    };
}

describe('captured usage query projection', () => {
    it('keeps latest ACP context without billing it or overlapping replayed inference usage', () => {
        const inference = (id: string, time: number, total: number, inferenceId: string): CapturedRow => ({
            ...row(id, total, { usageAccounting: { path: 'runtime', inferenceId } }),
            agentId: 'kimi', source: 'acp-usage-update', observedAt: new Date(time), createdAt: new Date(time),
            externalKey: inferenceId, estimatedCostUsd: total / 1000,
        });
        const context = (id: string, time: number, used: number): CapturedRow => ({
            ...inference(id, time, 0, id), scope: 'session_cumulative', isCumulative: true,
            turnId: null, requestCount: 0, contextUsedTokens: used, contextWindowTokens: 1000,
        });
        const snapshot: UsageAnalyticsSnapshot = {
            rows: [
                inference('first', 100, 100, 'kimi-step:first'),
                context('first-context', 200, 140),
                inference('second', 300, 50, 'kimi-step:second'),
                context('compacted-context', 400, 25),
                inference('replayed-first', 500, 100, 'kimi-step:first'),
            ],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined,
        };
        const result = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({
            granularity: 'day', includeSeries: true, breakdowns: ['session'],
        }));
        expect(result.totals.tokens.total).toBe(150);
        expect(result.totals.cost.estimatedUsd).toBeCloseTo(0.15);
        expect(result.totals.context).toEqual({ usedTokens: 25, windowTokens: 1000 });
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(150);
        expect(result.breakdowns?.session?.[0]?.context).toEqual({ usedTokens: 25, windowTokens: 1000 });
        expect(result.coverage?.reasons).not.toContain('ambiguous_overlap');
        expect(result.coverage?.reasons).not.toContain('counter_discontinuity');
    });

    it('selects witnessed execution after native/runtime reconciliation and keeps mixed-Session message counts unqualified', () => {
        const snapshot: UsageAnalyticsSnapshot = {
            rows: [
                row('runtime', 10, { accountingSubject: subject, usageAccounting: { path: 'runtime', inferenceId: 'same' } }),
                row('duplicate', 10, { accountingSubject: subject, usageAccounting: { path: 'native', inferenceId: 'same' } }, { source: 'native' }),
                row('linked', 20, { accountingSubject: subject, usageAccounting: { path: 'native', inferenceId: 'linked' } }, { source: 'native' }),
                row('outside', 30, { accountingSubject: { kind: 'native', machineId: 'machine', agent: subject.agent,
                    sourceRootKey: 'root', nativeSessionKey: 'outside' },
                    usageAccounting: { path: 'native', inferenceId: 'outside' } }, { source: 'native', sessionId: null }),
                // Source ids alone do not witness execution, even in a Happier Session.
                row('unknown', 40, {}),
            ],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: new Map([['session', 99]]),
        };
        const query = { granularity: 'day', includeActivity: true, includeModelTimeline: true, includeInsights: true,
            includeMessageStats: true, breakdowns: ['source'] };
        const whole = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse(query));
        expect(whole.totals.tokens.total).toBe(100);
        expect(whole.messageStats?.messageCount).toBe(99);
        for (const [execution, total] of [['happier', 30], ['outside', 30], ['unknown', 40]] as const) {
            const result = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({ ...query, filters: { execution } }));
            expect(result.totals.tokens.total).toBe(total);
            expect(result.contributions?.every(row => row.sourceContext?.execution === execution)).toBe(true);
            expect(result.series?.reduce((sum, row) => sum + row.tokens.total, 0)).toBe(total);
            expect(result.engineTimeline?.[0]?.leaders[0]?.sources?.every(row => row.execution === execution)).toBe(true);
            expect(result.coverage?.sources.map(row => row.path).sort()).toEqual(
                execution === 'happier' ? ['native', 'runtime'] : [execution === 'outside' ? 'native' : 'unknown']);
            expect(result.messageStats).toBeUndefined();
            expect(result.insights).toBeUndefined();
        }
        const native = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({ ...query, filters: { sources: ['native'] } }));
        expect(native.totals.tokens.total).toBe(50);
        expect(native.contributions?.map(row => row.sourceContext?.execution).sort()).toEqual(['happier', 'outside']);
    });
});
