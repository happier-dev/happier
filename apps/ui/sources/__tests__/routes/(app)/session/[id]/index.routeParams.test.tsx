import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hydrateSessionSpy = vi.hoisted(() => vi.fn((sessionId: string, reason: string) => true));
const sessionViewSpy = vi.hoisted(() => vi.fn((props: { id: string }) => React.createElement('SessionView', props)));

const routerMock = createExpoRouterMock({
    params: {
        id: ['', 's1'],
        jumpSeq: '',
        right: '',
        bottom: '',
        details: '',
        path: '',
        sha: '',
        recoveryDataId: '',
    },
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

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: { id: string }) => sessionViewSpy(props),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string) => hydrateSessionSpy(sessionId, reason),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ generation: 1 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

describe('session index route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        sessionViewSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before hydrating and rendering the session view', async () => {
        const { default: SessionRoute } = await import('@/app/(app)/session/[id]/index');

        await renderScreen(<SessionRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith('s1', 'SessionRoute.ensureSessionVisible gen=1');
        expect(sessionViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 's1',
            }),
        );
    });
});
