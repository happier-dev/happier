import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const navigationState = vi.hoisted(() => ({ pathname: '/session/s1', focused: true }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => navigationState.pathname }).module;
});
vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => navigationState.focused,
}));

afterEach(() => {
    standardCleanup();
    navigationState.pathname = '/session/s1';
    navigationState.focused = true;
});

async function countMountsUnderGate(sessionId: string): Promise<number> {
    const { SessionRouteEntryGate } = await import('./sessionRouteEntryPresentation');
    let mounts = 0;
    function SessionContent() {
        React.useEffect(() => {
            mounts += 1;
        }, []);
        return null;
    }
    await renderScreen(
        <SessionRouteEntryGate sessionId={sessionId}>
            <SessionContent />
        </SessionRouteEntryGate>,
    );
    return mounts;
}

describe('SessionRouteEntryGate (web)', () => {
    it('mounts the focused session entry', async () => {
        navigationState.pathname = '/session/s1';
        navigationState.focused = true;

        expect(await countMountsUnderGate('s1')).toBe(1);
    });

    it('mounts nothing for an earlier visit kept only as Back/Forward history', async () => {
        // Visited s1, then opened s2: the s1 entry stays in the stack, unfocused.
        navigationState.pathname = '/session/s2';
        navigationState.focused = false;

        expect(await countMountsUnderGate('s1')).toBe(0);
    });

    it('keeps the entry mounted under its own sub-route, where it is still the visible anchor', async () => {
        navigationState.pathname = '/session/s1/message/m1';
        navigationState.focused = false;

        expect(await countMountsUnderGate('s1')).toBe(1);
    });
});
