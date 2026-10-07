import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (commit resource)', () => {
    it('renders the stored commit resource through the scoped Session surface', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionCommitDetailsView } = await import('@/components/sessions/files/views/SessionCommitDetailsView');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'commit:abc', kind: 'commit', title: 'abc1234',
            resource: { kind: 'commit', sha: 'abc1234' },
        }, { intent: 'pinned' }));
        const views = screen.tree.findAllByType(SessionCommitDetailsView);
        expect(views).toHaveLength(1);
        expect(views[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId, sha: 'abc1234' });
    });
});
