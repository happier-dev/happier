import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let searchParams: { id: string; serverId?: string; sha?: string } = {
    id: 'session-1',
    serverId: 'server-1',
    sha: 'abc123',
};
let routeHydrationState: 'available' | 'loading' | 'missing' = 'available';
const routerBack = vi.fn();
const commitDetailsProps = vi.fn();

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: Record<string, unknown>) => value?.web ?? value?.default ?? null },
            View: 'View',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            params: () => searchParams,
            router: {
                back: routerBack,
                push: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('@/components/sessions/panes/open/useSessionOpenLayout', () => ({
    useCanDockSessionPane: () => false,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({ openDetailsTab: vi.fn() }),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, _tag: string, options?: { serverId?: string }) => {
        if (routeHydrationState === 'available') return { kind: 'available', sessionId, serverId: options?.serverId };
        if (routeHydrationState === 'missing') {
            return { kind: 'missing', sessionId, serverId: options?.serverId, cause: 'not_found' };
        }
        return { kind: 'loading', sessionId, serverId: options?.serverId, reason: 'cold' };
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: (props: Record<string, unknown>) => {
        commitDetailsProps(props);
        return React.createElement('SessionCommitDetailsView', props);
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: () => React.createElement('ActivitySpinner', { accessibilityRole: 'progressbar' }),
}));

describe('CommitScreen route boundary', () => {
    beforeEach(() => {
        searchParams = { id: 'session-1', serverId: 'server-1', sha: 'abc123' };
        routeHydrationState = 'available';
        routerBack.mockClear();
        commitDetailsProps.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderCommitRoute() {
        const { default: CommitScreen } = await import('@/app/(app)/session/[id]/commit');
        return renderScreen(<CommitScreen />);
    }

    it('normalizes accidental encoded oneline suffixes before rendering commit details', async () => {
        searchParams.sha = '0338a0f%20chore%3A%20stage%20b.txt';

        await renderCommitRoute();

        expect(commitDetailsProps).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            sha: '0338a0f',
        }));
    });

    it('routes the commit-details back action through the current router', async () => {
        await renderCommitRoute();

        const props = commitDetailsProps.mock.calls.at(-1)?.[0] as { onBack?: () => void };
        props.onBack?.();

        expect(routerBack).toHaveBeenCalledTimes(1);
    });

    it('shows loading until route hydration becomes available', async () => {
        routeHydrationState = 'loading';

        const screen = await renderCommitRoute();

        expect(screen.findAll((node) => node.props?.accessibilityRole === 'progressbar')).toHaveLength(1);
        expect(commitDetailsProps).not.toHaveBeenCalled();
    });

    it('shows the invalid-link fallback when route hydration proves the session is missing', async () => {
        routeHydrationState = 'missing';

        const screen = await renderCommitRoute();

        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
        expect(commitDetailsProps).not.toHaveBeenCalled();
    });
});
