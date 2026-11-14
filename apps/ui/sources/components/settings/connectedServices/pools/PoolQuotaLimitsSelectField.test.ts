import { describe, expect, it } from 'vitest';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';

import { buildPoolQuotaLimitCandidates } from './PoolQuotaLimitsSelectField';

describe('buildPoolQuotaLimitCandidates', () => {
    it('describes a multi-window allowance using provider durations instead of a window count', () => {
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [
                {
                    meterId: 'spark:primary',
                    providerLimitId: 'spark',
                    label: 'Spark · Primary',
                    windowDurationMs: 5 * 60 * 60_000,
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: 25,
                    resetsAt: null,
                    status: 'ok',
                },
                {
                    meterId: 'spark:secondary',
                    providerLimitId: 'spark',
                    label: 'Spark · Secondary',
                    windowDurationMs: 7 * 24 * 60 * 60_000,
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: 40,
                    resetsAt: null,
                    status: 'ok',
                },
            ],
        });

        const spark = buildPoolQuotaLimitCandidates({ snapshots: [snapshot] })
            .find((candidate) => candidate.id === 'spark');

        expect(spark?.subtitle).toContain('5h');
        expect(spark?.subtitle).toContain('7d');
        expect(spark?.subtitle).not.toContain('2 windows');
    });

    it('omits the redundant window count for a single-window allowance', () => {
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: 1,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [{
                meterId: 'session',
                label: 'Session',
                used: null,
                limit: null,
                unit: 'unknown',
                utilizationPct: 25,
                resetsAt: null,
                status: 'ok',
            }],
        });

        const session = buildPoolQuotaLimitCandidates({ snapshots: [snapshot] })[0];
        expect(session?.subtitle).not.toContain('1 window');
        expect(session?.subtitle).toContain('1 of 1 enabled account');
    });

    it('does not offer provider credits as a selectable allowance', () => {
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1, staleAfterMs: 60_000,
            planLabel: null, accountLabel: null,
            meters: [
                { meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown', utilizationPct: 100, resetsAt: null, status: 'ok' },
                { meterId: 'credits', label: 'Credits', used: null, limit: null, remaining: 10, unit: 'credits', utilizationPct: null, resetsAt: null, status: 'ok' },
            ],
        });

        expect(buildPoolQuotaLimitCandidates({ snapshots: [snapshot] }).map((candidate) => candidate.id)).toEqual(['weekly']);
    });
});
