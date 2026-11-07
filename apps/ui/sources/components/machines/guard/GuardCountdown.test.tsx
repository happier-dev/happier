import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTimerCensus, reactNativeWebAppState, renderScreen, standardCleanup } from '@/dev/testkit';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';

import { GuardCountdown } from './GuardCountdown';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('GuardCountdown clock lifecycle', () => {
    afterEach(() => {
        standardCleanup();
        reactNativeWebAppState.emit('active');
        vi.useRealTimers();
    });

    it.each([false, true])('pauses a retained hidden clock with suspension %s, reveals current time and stops at expiry', async suspendWhenHidden => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
        const timers = installTimerCensus();
        const stopAt = Date.now() + 5 * 60_000;
        const content = <GuardCountdown stopAt={stopAt} format={remaining => remaining} testID="guard-countdown" />;
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden={suspendWhenHidden}>{content}</RetainedPanelSurface>;
        try {
            const screen = await renderScreen(panel(true));
            const text = () => screen.findHostByTestId('guard-countdown')?.props.children;
            expect(text()).toBe('5:00');
            await screen.update(panel(false));
            const hiddenStart = timers.readFires().interval;
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(timers.readFires().interval - hiddenStart).toBe(0);

            await screen.update(panel(true));
            expect(text()).toBe('4:00');
            await act(async () => { vi.advanceTimersByTime(1000); });
            expect(text()).toBe('3:59');
            expect(timers.readFires().interval - hiddenStart).toBe(1);
            await act(async () => { vi.advanceTimersByTime(239_000); });
            expect(text()).toBe('0:00');
            const expiredStart = timers.readFires().interval;
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(timers.readFires().interval - expiredStart).toBe(0);
            await screen.unmount();
        } finally {
            standardCleanup();
            timers.stop();
        }
    });

    it('pauses while the host is backgrounded and reveals an expired deadline without restarting its clock', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
        const timers = installTimerCensus();
        try {
            const screen = await renderScreen(<GuardCountdown stopAt={Date.now() + 5 * 60_000} format={remaining => remaining} testID="guard-countdown" />);
            expect(screen.findHostByTestId('guard-countdown')?.props.children).toBe('5:00');
            await act(async () => { reactNativeWebAppState.emit('background'); });
            const hiddenStart = timers.readFires().interval;
            await act(async () => { vi.advanceTimersByTime(6 * 60_000); });
            expect(timers.readFires().interval - hiddenStart).toBe(0);
            await act(async () => { reactNativeWebAppState.emit('active'); });
            expect(screen.findHostByTestId('guard-countdown')?.props.children).toBe('0:00');
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(timers.readFires().interval - hiddenStart).toBe(0);
            await screen.unmount();
        } finally {
            standardCleanup();
            timers.stop();
        }
    });
});
