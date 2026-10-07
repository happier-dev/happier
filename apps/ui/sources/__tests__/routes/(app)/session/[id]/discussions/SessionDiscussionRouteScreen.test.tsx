import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionRouteCommonModuleMocks } from '../sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.fn();
let routeFocused = true;
let routeParams: { id: string; discussionId: string; serverId?: string } = {
    id: 'session-1', discussionId: 'discussion-1',
};
let navigationBoundary: ReturnType<typeof import('@/dev/testkit/mocks/reactNavigation').createReactNavigationNativeMock>;

installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const boundary = createExpoRouterMock({ router: { replace: routerReplaceSpy } });
        return { ...boundary.module, useLocalSearchParams: () => routeParams };
    },
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        navigationBoundary = createReactNavigationNativeMock();
        return { ...navigationBoundary, useIsFocused: () => routeFocused };
    },
});

const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-1' });

beforeEach(() => {
    routeParams = { id: 'session-1', discussionId: 'discussion-1', serverId: runtime.serverId };
    routeFocused = true;
    routerReplaceSpy.mockClear();
});

async function renderDiscussionRoute() {
    // The SDK context establishes a standalone screen. Its focus measurement is
    // the native boundary; hydration, address qualification and the view are real.
    const { SessionDiscussionRouteScreen } = await import('@/components/sessions/conversations/SessionDiscussionRouteScreen');
    return renderScreen(<runtime.Wrapper>
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}>
            <SessionDiscussionRouteScreen kind="discussion" />
        </navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>);
}

describe('SessionDiscussionRouteScreen', () => {
    it('mounts persisted discussion details against the exact Home resolved by hydration', async () => {
        const { SessionDiscussionDetailsView } = await import('@/components/sessions/conversations/SessionDiscussionDetailsView');
        const screen = await renderDiscussionRoute();

        expect(screen.findByType(SessionDiscussionDetailsView).props).toMatchObject({
            active: true,
            standaloneSurface: true,
            target: {
                kind: 'discussion',
                address: { serverId: runtime.serverId, sessionId: 'session-1' },
                discussionId: 'discussion-1',
            },
        });
        expect(screen.findAllByTestId('session-discussion-route-loading')).toHaveLength(0);
    });

    it('keeps the Discussion mounted without declaring it visible when the native route loses focus', async () => {
        routeFocused = false;
        const { SessionDiscussionDetailsView } = await import('@/components/sessions/conversations/SessionDiscussionDetailsView');
        const screen = await renderDiscussionRoute();

        expect(screen.findByType(SessionDiscussionDetailsView).props).toMatchObject({
            active: false,
            standaloneSurface: true,
            target: { address: { serverId: runtime.serverId, sessionId: 'session-1' } },
        });
    });
});
