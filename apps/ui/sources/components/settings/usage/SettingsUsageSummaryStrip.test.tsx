import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (key === 'usage.summary.currentStreakSubtitle' && typeof params?.count === 'number') {
            return `Active on ${params.count} days`;
        }
        return key;
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroupColumns', () => ({
    ItemGroupColumns: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroupColumns', null, children),
    ItemGroupColumn: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroupColumn', null, children),
}));

describe('SettingsUsageSummaryStrip', () => {
    it('shows a loading state instead of an empty state while the summary is still loading', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(
            <SettingsUsageSummaryStrip
                summary={null}
                isLoading
            />,
        );

        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('usage.noData');
    });

    it('uses the canonical ItemGroupColumns layout for the Variant A summary row', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(
            <SettingsUsageSummaryStrip
                summary={{
                    activeDays: 8,
                    currentStreakDays: 18,
                    totalTokens: 2_400_000,
                    totalCost: 1500,
                    currency: 'USD',
                    weekTokens: 800_000,
                    weekCost: 320,
                    topModel: {
                        dimension: 'model',
                        key: 'gpt-5',
                        label: 'GPT-5',
                        totalTokens: 1_300_000,
                        totalCost: 800,
                        reportCount: 9,
                        firstSeenAt: 0,
                        lastSeenAt: 0,
                        contextWindowTokens: null,
                        contextUsedTokens: null,
                    },
                    topEngine: {
                        dimension: 'backendMode',
                        key: 'opencode',
                        label: 'OpenCode',
                        totalTokens: 1_200_000,
                        totalCost: 700,
                        reportCount: 7,
                        firstSeenAt: 0,
                        lastSeenAt: 0,
                        contextWindowTokens: null,
                        contextUsedTokens: null,
                    },
                    busiestWindowLabel: 'Fri · 2 PM',
                    recentActivity: [
                        { timestamp: 1, active: true, tokens: 10, cost: 1 },
                        { timestamp: 2, active: true, tokens: 20, cost: 2 },
                        { timestamp: 3, active: false, tokens: 0, cost: 0 },
                        { timestamp: 4, active: true, tokens: 40, cost: 4 },
                        { timestamp: 5, active: true, tokens: 80, cost: 8 },
                        { timestamp: 6, active: true, tokens: 160, cost: 16 },
                        { timestamp: 7, active: true, tokens: 320, cost: 32 },
                        { timestamp: 8, active: true, tokens: 640, cost: 64 },
                        { timestamp: 9, active: true, tokens: 1280, cost: 128 },
                        { timestamp: 10, active: true, tokens: 2560, cost: 256 },
                        { timestamp: 11, active: true, tokens: 5120, cost: 512 },
                        { timestamp: 12, active: true, tokens: 10240, cost: 1024 },
                        { timestamp: 13, active: true, tokens: 20480, cost: 2048 },
                        { timestamp: 14, active: true, tokens: 40960, cost: 4096 },
                    ],
                    hasData: true,
                }}
            />,
        );

        expect(screen.findAllByType('ItemGroupColumns' as never)).toHaveLength(1);
        expect(screen.findAllByType('ItemGroupColumn' as never)).toHaveLength(4);
    });

    it('formats weekly cost with the summary currency instead of hardcoding USD', async () => {
        const { SettingsUsageSummaryStrip } = await import('./SettingsUsageSummaryStrip');
        const screen = await renderScreen(
            <SettingsUsageSummaryStrip
                summary={{
                    activeDays: 8,
                    currentStreakDays: 18,
                    totalTokens: 2_400_000,
                    totalCost: 1500,
                    currency: 'EUR',
                    weekTokens: 800_000,
                    weekCost: 320,
                    topModel: null,
                    topEngine: null,
                    busiestWindowLabel: null,
                    recentActivity: [
                        { timestamp: 1, active: true, tokens: 10, cost: 1 },
                    ],
                    hasData: true,
                }}
            />,
        );

        expect(screen.getTextContent()).toContain('€');
    });
});
