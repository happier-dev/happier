import { TeamCredentialUsageQueryResultV1Schema } from '@happier-dev/protocol/teams';

import { DEMO_NOW_MS } from './constants';

/** Aggregate display facts only: no credential record or material is created. */
export function buildDemoTeamCredentialUsage() {
    const days = [
        { requests: 84, tokens: 284000, cost: 1.42 },
        { requests: 112, tokens: 396000, cost: 1.98 },
        { requests: 96, tokens: 342000, cost: 1.71 },
        { requests: 136, tokens: 468000, cost: 2.34 },
        { requests: 124, tokens: 430000, cost: 2.15 },
        { requests: 158, tokens: 572000, cost: 2.86 },
        { requests: 132, tokens: 488000, cost: 2.44 },
    ];
    const totals = (requests: number, tokens: number, cost: number) => ({
        eventCount: requests, requestCount: requests,
        tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
        cost: { reportedUsd: cost, estimatedUsd: 0, currency: 'USD' },
    });
    const sum = days.reduce((value, day) => ({ requests: value.requests + day.requests,
        tokens: value.tokens + day.tokens, cost: value.cost + day.cost }), { requests: 0, tokens: 0, cost: 0 });
    return TeamCredentialUsageQueryResultV1Schema.parse({
        v: 1, totals: totals(sum.requests, sum.tokens, sum.cost),
        coverage: { requestAdmissionCount: sum.requests, agentObservationCount: sum.requests,
            externalTerminalObservationCount: 0, directRecordedUseOnly: false,
            requestCountCoverage: 'complete', tokenCoverage: 'complete', costCoverage: 'complete',
            unobservedExternalRequestCount: 0 },
        series: days.map((day, index) => ({
            bucketStartMs: DEMO_NOW_MS - (7 - index) * 86400000,
            bucketEndMs: DEMO_NOW_MS - (6 - index) * 86400000,
            totals: totals(day.requests, day.tokens, day.cost),
        })),
        nextCursor: null, limits: [],
    });
}
