import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useSegmentsMock, recordActionMock, screenMock } = vi.hoisted(() => ({
    useSegmentsMock: vi.fn(() => ['(app)', 'settings']),
    recordActionMock: vi.fn(),
    screenMock: vi.fn(),
}));

const trackingState = vi.hoisted(() => ({
    value: null as null | { screen: (route: string) => void },
}));

vi.mock('expo-router', () => ({
    useSegments: () => useSegmentsMock(),
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: (...args: unknown[]) => recordActionMock(...args),
}));

vi.mock('./tracking', () => ({
    get tracking() {
        return trackingState.value;
    },
}));

import { useTrackScreens } from './useTrackScreens';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function HookProbe() {
    useTrackScreens();
    return null;
}

describe('useTrackScreens', () => {
    beforeEach(() => {
        useSegmentsMock.mockClear();
        recordActionMock.mockClear();
        screenMock.mockClear();
        trackingState.value = null;
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('records screen navigation actions even when analytics tracking is unavailable', () => {
        act(() => {
            renderer.create(<HookProbe />);
        });

        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'settings' });
        expect(screenMock).not.toHaveBeenCalled();
    });

    it('tracks and records when analytics tracking is available', () => {
        trackingState.value = { screen: screenMock };

        act(() => {
            renderer.create(<HookProbe />);
        });

        expect(screenMock).toHaveBeenCalledWith('settings');
        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'settings' });
    });

    it('redacts dynamic id-like segments in recorded routes', () => {
        useSegmentsMock.mockReturnValue(['(app)', 'session', '550e8400-e29b-41d4-a716-446655440000', 'file']);

        act(() => {
            renderer.create(<HookProbe />);
        });

        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'session/:id/file' });
    });
});
