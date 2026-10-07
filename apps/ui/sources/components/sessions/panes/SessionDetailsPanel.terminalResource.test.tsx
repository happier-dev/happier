import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel (terminal resource)', () => {
    it('renders the scoped terminal resource in the Details dock', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { SessionEmbeddedTerminalPane } = await import('@/components/sessions/terminal/SessionEmbeddedTerminalPane');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'terminal:term-1', kind: 'terminal', title: 'Terminal',
            resource: { kind: 'terminal', terminalInstanceId: 'term-1' },
        }, { intent: 'pinned' }));
        const terminals = screen.tree.findAllByType(SessionEmbeddedTerminalPane);
        expect(terminals).toHaveLength(1);
        expect(terminals[0].props).toMatchObject({
            sessionId: 's1', scopeId: 'session:s1', terminalInstanceId: 'term-1', currentDockLocation: 'details',
        });
        expect(screen.findHostByTestId('details-surface-fallback-pending')).toBeNull();
    });
});
