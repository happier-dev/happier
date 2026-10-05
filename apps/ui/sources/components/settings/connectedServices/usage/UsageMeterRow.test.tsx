import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

import { UsageMeterRow } from './UsageMeterRow';

const NOW = Date.UTC(2026, 8, 30, 10, 40);
const MIN = 60_000;

function texts(screen: Awaited<ReturnType<typeof renderScreen>>): string {
    return screen.getTextContent();
}

describe('UsageMeterRow (lab csvc MT, the one meter)', () => {
    it('drops the redundant clock time when a wide meter is measured in a narrow pane', async () => {
        const screen = await renderScreen(<UsageMeterRow testID="meter" label="5-hour" remainingPct={42} resetsAt={NOW + 135 * MIN} tone="neutral" now={NOW} size="wide" />);
        const at = new Date(NOW + 135 * MIN).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        act(() => screen.findHostByTestId('meter')?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 20, x: 0, y: 0 } } }));
        expect(texts(screen)).toContain('in 2h 15m');
        expect(texts(screen)).not.toContain(`· ${at}`);
    });
    it('says when the window comes back as a countdown, and adds the clock time only on wide surfaces', async () => {
        const row = await renderScreen(
            <UsageMeterRow testID="default-meter" label="5-hour" remainingPct={42} resetsAt={NOW + 135 * MIN} tone="neutral" now={NOW} />,
        );
        act(() => row.findHostByTestId('default-meter')?.props.onLayout?.({ nativeEvent: { layout: { width: 320, height: 20, x: 0, y: 0 } } }));
        expect(texts(row)).toContain('5-hour');
        expect(texts(row)).toContain('42% left');
        expect(texts(row)).toContain('in 2h 15m');

        const card = await renderScreen(
            <UsageMeterRow testID="card-meter" label="Weekly · Sonnet" remainingPct={42} resetsAt={NOW + 135 * MIN} tone="neutral" now={NOW} size="card" />,
        );
        act(() => card.findHostByTestId('card-meter')?.props.onLayout?.({ nativeEvent: { layout: { width: 280, height: 20, x: 0, y: 0 } } }));
        expect(texts(card)).toContain('Weekly · Sonnet');
        expect(texts(card)).toContain('42% left');

        const wide = await renderScreen(
            <UsageMeterRow label="5-hour" remainingPct={42} resetsAt={NOW + 135 * MIN} tone="neutral" now={NOW} size="wide" />,
        );
        const at = new Date(NOW + 135 * MIN).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        expect(texts(wide)).toContain(`in 2h 15m · ${at}`);
    });

    it('reads a pool aggregate as the next reset, and lets a window without a countdown name its period', async () => {
        const pool = await renderScreen(
            <UsageMeterRow label="5-hour" remainingPct={48} resetsAt={NOW + 23 * MIN} tone="neutral" now={NOW} resetPrefix="next" />,
        );
        expect(texts(pool)).toContain('next in 23m');

        const monthly = await renderScreen(
            <UsageMeterRow label="Extra usage" remainingPct={76} resetsAt={null} tone="neutral" now={NOW} resetText="monthly" />,
        );
        expect(texts(monthly)).toContain('monthly');
    });

    it('preserves a useful reset when the percentage is unavailable', async () => {
        const row = await renderScreen(
            <UsageMeterRow testID="reset-only" label="Weekly" remainingPct={null} resetsAt={NOW + MIN} tone="neutral" now={NOW} />,
        );
        expect(texts(row)).toContain('Unavailable');
        expect(texts(row)).toContain('in 1m');
        expect(row.findHostByTestId('reset-only')?.props.accessibilityLabel).toContain('in 1m');
    });

    it('keeps the row for a window the provider did not report, and marks an estimate', async () => {
        const unknown = await renderScreen(
            <UsageMeterRow label="Weekly · Sonnet" remainingPct={null} resetsAt={null} tone="neutral" now={NOW} />,
        );
        expect(texts(unknown)).toContain('Unavailable');

        const estimated = await renderScreen(
            <UsageMeterRow label="5-hour" remainingPct={58} resetsAt={NOW + 70 * MIN} tone="neutral" now={NOW} estimated />,
        );
        expect(texts(estimated)).toContain('~58% left');
    });
});
