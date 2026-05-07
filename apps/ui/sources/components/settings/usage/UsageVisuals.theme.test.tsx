import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: {
                    blue: 'usage-accent-blue',
                    orange: 'usage-accent-orange',
                },
                textSecondary: 'usage-text-secondary',
            },
        },
    });
});

function findColoredView(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    color: string,
) {
    return screen.findAllByType('View' as any).find((node) => flattenTestStyle(node.props?.style).backgroundColor === color) ?? null;
}

describe('Usage visuals theme tokens', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('uses the theme accent token for token bars in UsageChart', async () => {
        const { UsageChart } = await import('./UsageChart');
        const screen = await renderScreen(
            <UsageChart
                data={[
                    {
                        timestamp: Math.floor(new Date('2024-01-02T12:00:00Z').getTime() / 1000),
                        tokens: { codex: 1000 },
                        cost: { codex: 0.5 },
                        reportCount: 1,
                    },
                ]}
                metric="tokens"
            />,
        );

        expect(findColoredView(screen, 'usage-accent-blue')).toBeTruthy();
    });

    it('uses the theme accent token for cost bars in UsageChart', async () => {
        const { UsageChart } = await import('./UsageChart');
        const screen = await renderScreen(
            <UsageChart
                data={[
                    {
                        timestamp: Math.floor(new Date('2024-01-02T12:00:00Z').getTime() / 1000),
                        tokens: { codex: 1000 },
                        cost: { codex: 0.5 },
                        reportCount: 1,
                    },
                ]}
                metric="cost"
            />,
        );

        expect(findColoredView(screen, 'usage-accent-orange')).toBeTruthy();
    });

    it('uses the theme accent token for the default UsageBar fill color', async () => {
        const { UsageBar } = await import('./UsageBar');
        const screen = await renderScreen(
            <UsageBar
                label="Codex"
                value={50}
                maxValue={100}
            />,
        );

        expect(findColoredView(screen, 'usage-accent-blue')).toBeTruthy();
    });
});
