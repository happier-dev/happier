import * as React from 'react';
import { ScrollView } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { UsageActivityPoster } from './UsageActivityPoster';

let windowWidth = 1280;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: windowWidth,
            height: 900,
            scale: 1,
            fontScale: 1,
        }),
    });
});

afterEach(() => {
    windowWidth = 1280;
});

describe('UsageActivityPoster', () => {
    it('renders separate rows for months, weekdays, and hours', async () => {
        const screen = await renderScreen(
            <UsageActivityPoster
                activity={{
                    calendarDays: [
                        { date: '2026-04-01', eventCount: 4 },
                        { date: '2026-04-02', eventCount: 8 },
                        { date: '2026-04-03', eventCount: 12 },
                    ],
                    weekdayHourBuckets: [
                        { weekday: 1, hour: 8, eventCount: 10 },
                        { weekday: 2, hour: 10, eventCount: 20 },
                        { weekday: 6, hour: 7, eventCount: 50 },
                    ],
                }}
                period="year"
            />,
        );

        expect(screen.findByTestId('usage-activity-track-months')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-track-weekdays')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-track-hours')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-track-row-months')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-track-row-weekdays')).toBeTruthy();
        expect(screen.findByTestId('usage-activity-track-row-hours')).toBeTruthy();
        expect(screen.getTextContent()).toContain('April');
        expect(screen.getTextContent()).toContain('Saturday');
        expect(screen.getTextContent()).toContain('7 AM');
        expect(screen.getTextContent()).not.toContain('2026-04');
        expect(screen.getTextContent()).not.toContain('2026-04-11');
    });

    it('keeps wide layouts expanded instead of forcing horizontal scrollers', async () => {
        windowWidth = 1280;

        const screen = await renderScreen(
            <UsageActivityPoster
                activity={{
                    calendarDays: [
                        { date: '2026-04-01', eventCount: 4 },
                        { date: '2026-04-02', eventCount: 8 },
                        { date: '2026-04-03', eventCount: 12 },
                    ],
                    weekdayHourBuckets: [
                        { weekday: 1, hour: 8, eventCount: 10 },
                        { weekday: 2, hour: 10, eventCount: 20 },
                        { weekday: 6, hour: 7, eventCount: 50 },
                    ],
                }}
                period="year"
            />,
        );

        expect(screen.root.findAllByType(ScrollView)).toHaveLength(0);
    });
});
