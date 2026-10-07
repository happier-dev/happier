import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionScmReviewDetailsTab } from './details/sessionDetailsTabBuilders';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (scm review resource)', () => {
    it('renders the current review resource through the scoped Session', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' }));
        const views = screen.tree.findAllByType(SessionScmReviewDetailsView);
        expect(views).toHaveLength(1);
        expect(views[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId });
    });

    it('places the dedicated screen close action before the tab strip on native', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" presentation="screen" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' }));
        const root = screen.findHostByTestId('session-details-panel-root');
        expect(root).not.toBeNull();
        const close = screen.findHostByTestId('session-details-close');
        const tab = screen.findHostByTestId('session-details-tab-scmReview_working');
        expect(close).not.toBeNull();
        expect(tab).not.toBeNull();
        expect(root?.findAll((node) => typeof node.type === 'string'
            && ['session-details-close', 'session-details-tab-scmReview_working'].includes(node.props.testID))
            .map((node) => node.props.testID)).toEqual(['session-details-close', 'session-details-tab-scmReview_working']);
        await act(async () => close?.props.onPress());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
    });
});
