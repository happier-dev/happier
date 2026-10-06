import { describe, expect, it } from 'vitest';

import { groupUsageByProvider, type UsageAccountInput } from './usageByProvider';

const claudeA: UsageAccountInput = {
    key: 'claude:a',
    serviceGroupKey: 'plugin.anthropic/claude',
    serviceLabel: 'Anthropic Claude',
    legacyServiceId: 'claude',
    accountLabel: null,
    accountEmail: 'kevin@gmail.com',
    accountId: 'a',
    planLabel: 'Max',
    state: 'ready',
    meters: [
        { meterId: 'five_hour', label: '5-hour limit', remainingPct: 73, resetsAt: 1_000 },
        { meterId: 'weekly', label: 'Weekly limit', remainingPct: 53, resetsAt: 2_000 },
    ],
};
const claudeB: UsageAccountInput = {
    key: 'claude:b',
    serviceGroupKey: 'plugin.anthropic/claude',
    serviceLabel: 'Anthropic Claude',
    legacyServiceId: 'claude',
    accountLabel: null,
    accountEmail: 'park@kakao.kr',
    accountId: 'b',
    planLabel: null,
    state: 'unavailable',
    meters: [],
};
const codex: UsageAccountInput = {
    key: 'codex:a',
    serviceGroupKey: 'plugin.openai/codex',
    serviceLabel: 'Codex',
    legacyServiceId: 'codex',
    accountLabel: 'Work',
    accountEmail: null,
    accountId: 'a',
    planLabel: 'Pro 20x',
    state: 'loading',
    meters: [],
};

describe('groupUsageByProvider', () => {
    it('presents readable labels from raw device-cached usage windows while retaining explicit labels', () => {
        const ids = ['five_hour', 'seven_day', 'seven_day_all', 'seven_day_fable', 'spend', 'future_api_window'];
        const meters = ids.map((meterId) => ({ meterId, label: meterId, remainingPct: 80, resetsAt: null }));
        const [group] = groupUsageByProvider([{ ...claudeA, meters }]);
        expect(group?.accounts[0]?.windows.map((window) => window.label))
            .toEqual(['5-hour', 'Weekly', 'Weekly (all models)', 'Weekly (Fable)', 'Spend', 'Future API Window']);
        expect(groupUsageByProvider([claudeA])[0]?.accounts[0]?.windows[0]?.label).toBe('5-hour limit');
        expect(meters.map((meter) => meter.label)).toEqual(ids);
    });

    it('colours each window by what is left, from the one quota tone owner, and ticks an account only when every window is healthy', () => {
        const windows = (remaining: ReadonlyArray<number | null>) => remaining.map((remainingPct, index) => ({
            meterId: `m${index}`, label: `M${index}`, remainingPct, resetsAt: null,
        }));
        const [claude] = groupUsageByProvider([
            { ...claudeA, key: 'healthy', meters: windows([73, 26]) },
            { ...claudeA, key: 'low', meters: windows([73, 25]) },
            { ...claudeA, key: 'critical', meters: windows([10, 90]) },
            { ...claudeA, key: 'unknown', meters: windows([90, null]) },
            claudeB,
        ]);
        const byKey = new Map(claude!.accounts.map((account) => [account.key, account]));
        expect(byKey.get('healthy')!.windows.map((window) => window.tone)).toEqual(['success', 'success']);
        expect(byKey.get('low')!.windows.map((window) => window.tone)).toEqual(['success', 'warning']);
        expect(byKey.get('critical')!.windows.map((window) => window.tone)).toEqual(['danger', 'success']);
        expect(byKey.get('unknown')!.windows.map((window) => window.tone)).toEqual(['success', 'neutral']);
        expect([...byKey.values()].filter((account) => account.healthy).map((account) => account.key)).toEqual(['healthy']);
    });

    it('groups accounts under their provider, keeps each account\'s own state, and shows used and remaining per window', () => {
        const groups = groupUsageByProvider([codex, claudeA, claudeB]);

        expect(groups.map((group) => group.serviceLabel)).toEqual(['Anthropic Claude', 'Codex']);
        const claude = groups[0]!;
        expect(claude.legacyServiceId).toBe('claude');
        // Each account keeps its raw identity for the one presenter to format.
        expect(claude.accounts.map((account) => [account.email, account.accountId, account.state])).toEqual([
            ['kevin@gmail.com', 'a', 'ready'],
            ['park@kakao.kr', 'b', 'unavailable'],
        ]);
        expect(claude.accounts[0]!.windows).toEqual([
            { meterId: 'five_hour', label: '5-hour limit', usedPct: 27, remainingPct: 73, resetsAt: 1_000, tone: 'success' },
            { meterId: 'weekly', label: 'Weekly limit', usedPct: 47, remainingPct: 53, resetsAt: 2_000, tone: 'success' },
        ]);
        expect(groups[1]!.accounts[0]).toMatchObject({ label: 'Work', state: 'loading', windows: [] });
    });

    it('names the provider\'s plan once when all its accounts share it, never guessing one', () => {
        const [claude] = groupUsageByProvider([claudeA, { ...claudeB, planLabel: 'Max', state: 'ready' }]);
        expect(claude!.planLabel).toBe('Max');
        const [mixed] = groupUsageByProvider([claudeA, { ...claudeB, planLabel: 'Pro', state: 'ready' }]);
        expect(mixed!.planLabel).toBeNull();
        // An account whose usage could not be read says nothing about its plan, so it neither
        // breaks nor makes the shared plan.
        const [withUnread] = groupUsageByProvider([claudeA, claudeB]);
        expect(withUnread!.planLabel).toBe('Max');
        const [onlyUnread] = groupUsageByProvider([claudeB]);
        expect(onlyUnread!.planLabel).toBeNull();
    });

    it('keeps a window whose remaining value is unknown without inventing a used value', () => {
        const [claude] = groupUsageByProvider([{
            ...claudeA,
            meters: [{ meterId: 'opus', label: 'Opus', remainingPct: null, resetsAt: null }],
        }]);
        expect(claude!.accounts[0]!.windows[0]).toEqual({
            meterId: 'opus', label: 'Opus', usedPct: null, remainingPct: null, resetsAt: null, tone: 'neutral',
        });
    });
});
