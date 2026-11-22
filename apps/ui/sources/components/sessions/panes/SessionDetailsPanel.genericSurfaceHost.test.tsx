import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { PanePresentationProvider, type PanePresentationIntent } from '@/components/appShell/panes/panePresentation';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

describe('SessionDetailsPanel generic details surface host adapter', () => {
    it('presents Browser from the empty Open files strip in a constrained navigator', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { BrowserSurfaceOpenButton } = await import('@/components/browser/surfaces/BrowserSurfaceOpenButton');
        const intents: PanePresentationIntent[] = [];
        const screen = await renderScreen(<runtime.Wrapper>
            <PanePresentationProvider value={intent => { intents.push(intent); }}>
                <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
            </PanePresentationProvider>
        </runtime.Wrapper>);
        // Exercise the launcher handler with the real pane owner; feature eligibility is a
        // separate boundary and the reported production control was already enabled.
        await act(async () => screen.tree.findByType(BrowserSurfaceOpenButton).props.onPress());
        expect(intents).toContainEqual(expect.objectContaining({
            scopeId: 'session:s1', pane: 'right',
            destination: expect.objectContaining({ kind: 'builtin', id: 'browser' }),
        }));
    });

    it.each([
        ['an unsupported resource', {
            key: 'unsupported:one', kind: 'unsupported', title: 'Unsupported surface',
            resource: { kind: 'unsupported' },
        }],
        // Not shipped: no Details renderer may admit it.
        ['the unshipped pluginSessionSurface resource', {
            key: 'plugin:preview', kind: 'pluginSessionSurface', title: 'Preview',
            resource: { kind: 'pluginSessionSurface', destination: { pluginId: 'acme.preview', localId: 'preview-pane' } },
        }],
    ])('routes scoped tabs through the shared host and visibly rejects %s', async (_label, tab) => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { DetailsSurfaceHost } = await import('@/components/appShell/panes/details/surfaces');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(tab as never, { intent: 'pinned' }));
        const hosts = screen.tree.findAllByType(DetailsSurfaceHost);
        expect(hosts).toHaveLength(1);
        expect(hosts[0].props).toMatchObject({
            scope: { kind: 'session', sessionId: 's1', serverId: runtime.serverId },
            region: 'details', tab: { key: tab.key },
        });
        expect(screen.findHostByTestId('details-surface-fallback-unsupported')).not.toBeNull();
        expect(screen.findHostByTestId('details-surface-fallback-pending')).toBeNull();
    });
});
