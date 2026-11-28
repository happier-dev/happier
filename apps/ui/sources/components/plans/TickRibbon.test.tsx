import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 27);

function ticks(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        atMs: NOW - ((index * 89) / count) * DAY,
        messages: (index % 50) + 1,
        pinned: index % 17 === 0,
        leaving: index % 23 === 0,
    }));
}

describe('TickRibbon', () => {
    it('draws a thousand sessions as one path per tone plus one for pins, and the edge only inside the window', async () => {
        const { TickRibbon } = await import('./TickRibbon');
        const screen = await renderScreen(
            <TickRibbon ticks={ticks(1000)} nowMs={NOW} windowDays={90} retentionDays={60} width={600} />,
        );
        const paths = screen.root.findAll((node) => (node.type as unknown) === 'Path' || (node.type as { displayName?: string }).displayName === 'Path');
        expect(paths.length).toBeLessThanOrEqual(4);
        expect(screen.root.findAll((node) => node.props.testID === 'tick-ribbon-edge').length).toBeGreaterThan(0);

        const kept = await renderScreen(
            <TickRibbon ticks={ticks(1000)} nowMs={NOW} windowDays={90} retentionDays={365} width={600} />,
        );
        expect(kept.root.findAll((node) => node.props.testID === 'tick-ribbon-edge')).toHaveLength(0);
    });
});
