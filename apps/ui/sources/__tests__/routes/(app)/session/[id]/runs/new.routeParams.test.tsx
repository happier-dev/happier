import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hydrateSessionSpy = vi.hoisted(() => vi.fn((sessionId: string, reason: string) => ({
    kind: 'available' as const,
    sessionId,
})));
const launcherViewSpy = vi.hoisted(() => vi.fn<(props: any, ref?: any) => React.ReactElement>((props) => React.createElement('SessionExecutionRunLauncherView', props)));

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'], intent: 'review' },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: (...args: [any, any?]) => launcherViewSpy(...args),
}));

describe('session new run route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        launcherViewSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and launching runs', async () => {
        const { default: NewRunRoute } = await import('@/app/(app)/session/[id]/runs/new');

        await renderScreen(<NewRunRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionNewRunScreen.hydrate');
        expect(launcherViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                initialIntent: 'review',
                presentation: 'screen',
            }),
            undefined,
        );
    });
});
