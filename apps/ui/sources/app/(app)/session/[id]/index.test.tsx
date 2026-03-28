import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const runAfterInteractionsSpy = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({
        id: 'session-1',
    }),
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => true,
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: runAfterInteractionsSpy,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ generation: 1 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

describe('session route index', () => {
    afterEach(() => {
        standardCleanup();
        runAfterInteractionsSpy.mockClear();
    });

    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        const Route = await import('./index');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(runAfterInteractionsSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
    });
});
