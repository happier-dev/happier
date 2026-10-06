import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (subagent resource)', () => {
    it('renders the real subagent details and retains its tab subtitle', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionSubagentDetailsView } = await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'subagent:execution_run:run_1', kind: 'subagent', title: 'Code review', subtitle: 'Subagent · Codex',
            resource: { kind: 'subagent', subagentId: 'execution_run:run_1' },
        }, { intent: 'preview' }));
        const views = screen.tree.findAllByType(SessionSubagentDetailsView);
        expect(views).toHaveLength(1);
        expect(views[0].props).toMatchObject({ sessionId: 's1', scopeId: 'session:s1', subagentId: 'execution_run:run_1' });
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Subagent · Codex');
    });
});
