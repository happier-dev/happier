import { describe, expect, it } from 'vitest';

import type { AccountLimitsV1, PlanDefinitionV1 } from '@happier-dev/protocol';

import {
    buildPlanLadder,
    cheapestPackPlan,
    formatMinorAmount,
    formatStorageBytes,
    monthlyPrice,
    nextPlanUp,
} from './planSurfaceCopy';

const limits = (overrides: Partial<AccountLimitsV1>): AccountLimitsV1 => ({
    sessionRetentionDays: null,
    subagentRetentionDays: null,
    toolOutputRetentionDays: null,
    pinnedSessions: null,
    artifactStorageBytes: null,
    ...overrides,
});

const plan = (id: string, amountMinor: number, pins: number): PlanDefinitionV1 => ({
    id,
    name: id === 'lite' ? 'Lite' : 'Plus',
    limits: limits({ pinnedSessions: pins }),
    prices: [{ interval: 'month', amountMinor, currency: 'usd' }],
});

describe('planSurfaceCopy', () => {
    it('draws exactly the offered plans, with Free only when the server publishes base limits', () => {
        const lite = plan('lite', 299, 100);
        const plus = plan('plus', 699, 500);

        const three = buildPlanLadder({ baseLimits: limits({ pinnedSessions: 50 }), plans: [lite, plus], currentPlanId: null });
        expect(three.map((column) => column.id)).toEqual(['free', 'lite', 'plus']);
        expect(three.map((column) => column.current)).toEqual([true, false, false]);
        expect(three.map((column) => column.includesPack)).toEqual([false, true, true]);
        expect(three[0]?.limits.pinnedSessions).toBe(50);

        const two = buildPlanLadder({ baseLimits: null, plans: [plus], currentPlanId: 'plus' });
        expect(two.map((column) => [column.id, column.current])).toEqual([['plus', true]]);
    });

    it('offers the next plan up from the current one and none above the top', () => {
        const ladder = buildPlanLadder({
            baseLimits: limits({}),
            plans: [plan('lite', 299, 100), plan('plus', 699, 500)],
            currentPlanId: 'lite',
        });
        expect(nextPlanUp(ladder)?.id).toBe('plus');
        expect(nextPlanUp(buildPlanLadder({ baseLimits: limits({}), plans: [plan('plus', 699, 500)], currentPlanId: 'plus' }))).toBeNull();
    });

    it('names the cheapest paid plan that carries the Supporter pack, for the Cloud-only line', () => {
        expect(cheapestPackPlan([plan('plus', 699, 500), plan('lite', 299, 100)])?.id).toBe('lite');
        expect(cheapestPackPlan([])).toBeNull();
    });

    it('formats money from minor units and storage in binary units', () => {
        expect(formatMinorAmount(299, 'usd', 'en-US')).toBe('$2.99');
        expect(formatMinorAmount(300, 'usd', 'en-US')).toBe('$3');
        expect(formatMinorAmount(0, 'usd', 'en-US')).toBe('$0');
        expect(formatStorageBytes(524_288_000, 'en-US')).toBe('500 MB');
        expect(formatStorageBytes(1_073_741_824, 'en-US')).toBe('1 GB');
        expect(formatStorageBytes(5_368_709_120, 'en-US')).toBe('5 GB');
        expect(monthlyPrice(plan('plus', 699, 500))?.amountMinor).toBe(699);
    });
});
