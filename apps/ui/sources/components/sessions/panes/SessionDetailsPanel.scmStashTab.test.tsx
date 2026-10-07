import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionScmStashDetailsTab } from './details/sessionDetailsTabBuilders';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (scmStash)', () => {
    it('renders the scoped stash details view when its tab is active', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionScmStashDetailsView } = await import('@/components/sessions/files/views/SessionScmStashDetailsView');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionScmStashDetailsTab(), { intent: 'pinned' }));
        const views = screen.tree.findAllByType(SessionScmStashDetailsView);
        expect(views).toHaveLength(1);
        expect(views[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId });
    });
});
