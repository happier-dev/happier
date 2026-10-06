import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
});
// Metro's platform module selection, not the detail view implementation, is the boundary.
vi.mock('./SessionDetailsPanelDetailViews', async () => await import('./SessionDetailsPanelDetailViews.native'));
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (native details loading)', () => {
    it('renders native file details in the first committed tree without waiting on a lazy import', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'file:src/app.ts', kind: 'file', title: 'app.ts',
            resource: { kind: 'file', path: 'src/app.ts' },
        }, { intent: 'pinned' }));
        // Deliberately synchronous: a lazy import would still show its fallback at this commit.
        act(() => screen.tree.update(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>));
        expect(screen.tree.findAllByType(SessionFileDetailsView)).toHaveLength(1);
        expect(screen.findHostByTestId('session-file-details-loading')).toBeNull();
    });
});
