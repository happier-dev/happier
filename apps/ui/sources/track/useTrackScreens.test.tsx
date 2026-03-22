import React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useSegmentsMock, recordActionMock, screenMock } = vi.hoisted(() => ({
    useSegmentsMock: vi.fn(() => ['(app)', 'settings']),
    recordActionMock: vi.fn(),
    screenMock: vi.fn(),
}));

const trackingState = vi.hoisted(() => ({
    value: null as null | { screen: (route: string) => void },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        segments: () => useSegmentsMock(),
    });
    return expoRouterMock.module;
});

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: (...args: unknown[]) => recordActionMock(...args),
}));

vi.mock('./tracking', () => ({
    get tracking() {
        return trackingState.value;
    },
}));

import { useTrackScreens } from './useTrackScreens';
import { renderScreen } from '@/dev/testkit';


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

    it('records screen navigation actions even when analytics tracking is unavailable', async () => {
        await renderScreen(<HookProbe />);

        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'settings' });
        expect(screenMock).not.toHaveBeenCalled();
    });

    it('tracks and records when analytics tracking is available', async () => {
        trackingState.value = { screen: screenMock };

        await renderScreen(<HookProbe />);

        expect(screenMock).toHaveBeenCalledWith('settings');
        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'settings' });
    });

    it('redacts dynamic id-like segments in recorded routes', async () => {
        useSegmentsMock.mockReturnValue(['(app)', 'session', '550e8400-e29b-41d4-a716-446655440000', 'file']);

        await renderScreen(<HookProbe />);

        expect(recordActionMock).toHaveBeenCalledWith('screen.navigate', { route: 'session/:id/file' });
    });
});
