import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { AppState } from 'react-native';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@hugeicons/react-native', () => ({
    HugeiconsIcon: (props: Record<string, unknown>) => React.createElement('HugeiconsIcon', props),
}));

import { SessionUsageLimitRecoveryBanner } from './SessionUsageLimitRecoveryBanner';

describe('overload recovery countdown', () => {
    let restoreAppState: (() => void) | null = null;
    afterEach(() => { restoreAppState?.(); vi.useRealTimers(); });
    it('shows the live limit countdown immediately after the reset time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const appState = createReactNativeAppStateEmitter();
        restoreAppState = appState.install(AppState);
        const deadline = Date.now() + 12_000;
        const screen = await renderScreen(<SessionUsageLimitRecoveryBanner
            testID="recovery" title="Usage limit reached"
            body="Wait until 17:17:06 before continuing. 1 reset available."
            resetCountdown={{ deadlineMs: deadline, timeLabel: '17:17:06' }} surfaceFocused
        />);
        expect(screen.getTextContent()).toContain('17:17:06 (0h 0m 12s) before continuing. 1 reset available.');
        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(screen.getTextContent()).toContain('17:17:06 (0h 0m 11s) before continuing.');
        await act(async () => { vi.advanceTimersByTime(11_000); });
        expect(screen.getTextContent()).not.toContain('(0h 0m');
        await act(async () => { screen.tree.update(<SessionUsageLimitRecoveryBanner
            testID="recovery" body="Wait until tomorrow before continuing."
            resetCountdown={{ deadlineMs: Date.now() + 25 * 3_600_000, timeLabel: 'tomorrow' }} surfaceFocused
        />); });
        expect(screen.getTextContent()).toContain('tomorrow (25h 0m 0s)');
        await act(async () => { vi.advanceTimersByTime(1_000); });
        expect(screen.getTextContent()).toContain('tomorrow (24h 59m 59s)');
    });
    it('updates only the banner leaf and removes its timer when no scheduled retry remains', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const appState = createReactNativeAppStateEmitter();
        restoreAppState = appState.install(AppState);
        let parentRenders = 0;
        function Parent({ deadline, focused = true }: { deadline: number | null; focused?: boolean }) {
            parentRenders += 1;
            return <SessionUsageLimitRecoveryBanner testID="recovery" title="Model overloaded" body="Waiting"
                surfaceFocused={focused} temporaryThrottle={{ nextCheckAtMs: deadline, attemptCount: 2 }} />;
        }
        const screen = await renderScreen(<Parent deadline={Date.now() + 12_000} />);
        expect(screen.getTextContent()).toContain('12 seconds');
        expect(screen.getTextContent()).toContain('attempt 3');
        const parentBeforeTick = parentRenders;
        await act(async () => { vi.advanceTimersByTime(3_000); });
        expect(screen.getTextContent()).toContain('9 seconds');
        expect(parentRenders).toBe(parentBeforeTick);
        await act(async () => { appState.emit('background'); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { appState.emit('active'); });
        await act(async () => { screen.tree.update(<Parent deadline={null} />); });
        expect(screen.getTextContent()).not.toContain('seconds');
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { screen.tree.update(<Parent deadline={Date.now() + 12_000} focused={false} />); });
        expect(vi.getTimerCount()).toBe(0);
    });
});
