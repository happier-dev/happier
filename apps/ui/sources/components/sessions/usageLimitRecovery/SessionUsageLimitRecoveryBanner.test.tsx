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
    it('renders the translated quota wait with live time inputs only while visible', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const appState = createReactNativeAppStateEmitter();
        restoreAppState = appState.install(AppState);
        const deadlineMs = Date.now() + 5_000;
        const quotaWait = { deadlineMs, renderBody: (duration: string) => `At 10:00 (${duration})\n1 credit` };
        const props = { testID: 'recovery', title: 'Quota exhausted', body: 'At 10:00\n1 credit', quotaWait };
        const screen = await renderScreen(<SessionUsageLimitRecoveryBanner {...props} surfaceFocused />);
        expect(screen.getTextContent()).toContain('At 10:00 (5');
        await act(async () => { vi.advanceTimersByTime(2_000); });
        expect(screen.getTextContent()).toContain('At 10:00 (3');
        expect(screen.getTextContent()).toContain('1 credit');
        await act(async () => { screen.tree.update(<SessionUsageLimitRecoveryBanner {...props} surfaceFocused={false} />); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { screen.tree.update(<SessionUsageLimitRecoveryBanner {...props} surfaceFocused />); });
        await act(async () => { vi.advanceTimersByTime(3_000); });
        expect(screen.getTextContent()).not.toContain('At 10:00 (');
        expect(vi.getTimerCount()).toBe(0);
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
