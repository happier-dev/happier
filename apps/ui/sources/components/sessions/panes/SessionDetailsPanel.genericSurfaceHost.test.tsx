import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel generic details surface host adapter', () => {
    it('routes scoped tabs through the shared host and visibly rejects an unsupported resource', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { DetailsSurfaceHost } = await import('@/components/appShell/panes/details/surfaces');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'unsupported:one', kind: 'unsupported', title: 'Unsupported surface',
            resource: { kind: 'unsupported' },
        }, { intent: 'pinned' }));
        const hosts = screen.tree.findAllByType(DetailsSurfaceHost);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].props).toMatchObject({
            scope: { kind: 'session', sessionId: 's1', serverId: runtime.serverId },
            region: 'details', tab: { key: 'unsupported:one' },
        });
        expect(screen.findHostByTestId('details-surface-fallback-unsupported')).not.toBeNull();
        expect(screen.findHostByTestId('details-surface-fallback-pending')).toBeNull();
    });
});
