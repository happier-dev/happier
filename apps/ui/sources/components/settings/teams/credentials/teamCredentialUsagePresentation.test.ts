import { describe, expect, it } from 'vitest';
import type { TeamCredentialUsageQueryResultV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

import { contiguousTeamCredentialUsageBuckets, teamCredentialUsageCaveat, teamCredentialUsageCost, teamCredentialUsageTokens } from './teamCredentialUsagePresentation';

type Coverage = TeamCredentialUsageQueryResultV1['coverage'];

function coverage(overrides: Partial<Coverage> = {}): Coverage {
    return {
        requestAdmissionCount: 4,
        agentObservationCount: 4,
        externalTerminalObservationCount: 0,
        directRecordedUseOnly: false,
        requestCountCoverage: 'complete',
        tokenCoverage: 'complete',
        costCoverage: 'complete',
        unobservedExternalRequestCount: 0,
        ...overrides,
    };
}

describe('teamCredentialUsageCost', () => {
    it('never shows a partial cost as a measured zero: it is unknown and says why', () => {
        const partial = teamCredentialUsageCost(0, coverage({ costCoverage: 'partial' }));
        expect(partial.amountUsd).toBeNull();
        expect(partial.caption).toBe(t('teams.credentials.usage.costPartialShort'));
        expect(teamCredentialUsageCost(12.5, coverage({ costCoverage: 'partial' })).amountUsd).toBeNull();
        expect(teamCredentialUsageCost(null, coverage({ costCoverage: 'unavailable' }))).toEqual({
            amountUsd: null,
            caption: t('teams.credentials.usage.costUnavailable'),
        });
    });

    it('keeps a period with nothing recorded a known zero', () => {
        expect(teamCredentialUsageCost(0, coverage({ costCoverage: 'unavailable', requestAdmissionCount: 0 }), true).amountUsd).toBe(0);
        expect(teamCredentialUsageTokens(0, coverage({ tokenCoverage: 'unavailable' }), true).tokens).toBe(0);
    });

    it('keeps a complete cost, a real zero included', () => {
        expect(teamCredentialUsageCost(0, coverage()).amountUsd).toBe(0);
        expect(teamCredentialUsageCost(3.25, coverage()).amountUsd).toBe(3.25);
    });
});

describe('teamCredentialUsageTokens', () => {
    it('keeps a partial token total as a floor that says so, and an unavailable one as unknown', () => {
        expect(teamCredentialUsageTokens(120, coverage({ tokenCoverage: 'partial' }))).toEqual({
            tokens: 120,
            caption: t('teams.credentials.usage.tokenPartialShort'),
        });
        expect(teamCredentialUsageTokens(null, coverage({ tokenCoverage: 'unavailable' })).tokens).toBeNull();
    });
});

describe('teamCredentialUsageCaveat', () => {
    it('says what the totals leave out in one line, and nothing for a complete Happier-recorded period', () => {
        const line = teamCredentialUsageCaveat(coverage({
            directRecordedUseOnly: true,
            requestCountCoverage: 'brokered_only',
            costCoverage: 'partial',
            tokenCoverage: 'partial',
        }));
        expect(line).not.toBeNull();
        expect(line).not.toContain('\n');
        // Token and cost gaps are said by their own figures, not repeated in the line.
        expect(line).not.toContain(t('teams.credentials.usage.costIncomplete'));
        expect(line).not.toContain(t('teams.credentials.usage.tokenIncomplete'));
        expect(teamCredentialUsageCaveat(coverage())).toBe(t('teams.credentials.usage.recordedByHappier'));
    });
});

describe('contiguousTeamCredentialUsageBuckets', () => {
    const DAY = 86_400_000;
    const day = (n: number) => Date.UTC(2026, 10, n);

    it('keeps one slot per day of the range, so a day with nothing recorded is an empty day rather than a skipped one', () => {
        const slots = contiguousTeamCredentialUsageBuckets(
            [day(3), day(5), day(6)],
            { startMs: day(2) + 5 * 3_600_000, endMs: day(7) + 3_600_000, granularity: 'day' },
        );
        expect(slots.map((slot) => slot.bucketStartMs)).toEqual([day(2), day(3), day(4), day(5), day(6), day(7)]);
        expect(slots.filter((slot) => slot.recorded).map((slot) => slot.bucketStartMs)).toEqual([day(3), day(5), day(6)]);
        expect(slots[1]!.bucketStartMs - slots[0]!.bucketStartMs).toBe(DAY);
    });

    it('starts an all-time range at its first recorded bucket instead of the epoch', () => {
        const slots = contiguousTeamCredentialUsageBuckets(
            [Date.UTC(2026, 8, 1), Date.UTC(2026, 10, 1)],
            { startMs: 0, endMs: Date.UTC(2026, 10, 15), granularity: 'month' },
        );
        expect(slots.map((slot) => slot.bucketStartMs)).toEqual([Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)]);
    });
});
