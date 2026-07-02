import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hydrateSessionSpy = vi.hoisted(() => vi.fn((sessionId: string, reason: string) => ({
    kind: 'available' as const,
    sessionId,
})));
const detailsViewSpy = vi.hoisted(() => vi.fn<(props: any, ref?: any) => React.ReactElement>((props) => React.createElement('SessionExecutionRunDetailsView', props)));

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'], runId: ['run-42', 'ignored'] },
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
        Pressable: 'Pressable',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/components/sessions/runs/details/SessionExecutionRunDetailsView', () => ({
    SessionExecutionRunDetailsView: (...args: [any, any?]) => detailsViewSpy(...args),
}));

describe('session run details route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        detailsViewSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and showing run details', async () => {
        const { default: RunDetailsRoute } = await import('@/app/(app)/session/[id]/runs/[runId]');

        await renderScreen(<RunDetailsRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionRunDetailsScreen.hydrate');
        expect(detailsViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                runId: 'run-42',
                presentation: 'screen',
            }),
            undefined,
        );
    });
});
