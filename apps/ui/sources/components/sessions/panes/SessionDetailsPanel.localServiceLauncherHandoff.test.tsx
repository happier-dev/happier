import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'session-a' });

describe('SessionDetailsPanel local service launcher handoff', () => {
    it('passes supplied LSV launcher rows into the real browser details renderer', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const { DetailsSurfaceHost, createDetailsSurfaceDescriptor } = await import('@/components/appShell/panes/details/surfaces');
        const { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
        const { BrowserDetailsSurface, createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const session = createSessionFixture({ id: 'session-a', serverId: runtime.serverId });
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, machineId: 'machine-a' } }]);
        const launcherState = applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
            v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 3_000,
            targets: [{
                id: 'preview:session-browser-feed', source: 'registered_preview',
                machineId: 'machine-a', sessionId: 'session-a', title: 'Session browser feed',
                subtitle: 'localhost:5173', confidence: 'high', state: 'available', actions: [],
                browserTarget: {
                    kind: 'localServicePreview', targetId: 'preview-session-browser-feed',
                    sessionId: 'session-a', machineId: 'machine-a',
                },
            }],
        });
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="session-a" routeServerId={runtime.serverId}
                scopeId="session:session-a" nowMs={() => 4_000} localServiceLauncherState={launcherState} />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'unsupported:launcher-probe', kind: 'unsupported', title: 'Launcher probe',
            resource: { kind: 'unsupported' },
        }, { intent: 'pinned' }));
        const host = screen.tree.findByType(DetailsSurfaceHost);
        const tab = { ...createBrowserLaunchpadDetailsTab(), isPinned: true, isPreview: false };
        const descriptor = createDetailsSurfaceDescriptor({ tab, scope: host.props.scope, region: 'details' });
        const browserRenderer = host.props.renderers.find((renderer: { id: string }) => renderer.id === 'browser-view-details-surface');
        expect(browserRenderer).toBeDefined();
        const element = browserRenderer.render({
            tab, descriptor, scope: host.props.scope, region: 'details', active: true, callbacks: host.props.callbacks,
        });
        expect(React.isValidElement(element)).toBe(true);
        if (!React.isValidElement<React.ComponentProps<typeof BrowserDetailsSurface>>(element)) {
            throw new Error('Expected the real browser details surface');
        }
        expect(element.type).toBe(BrowserDetailsSurface);
        expect(element.props.launchpadRows).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'localService:preview:session-browser-feed', disabledReason: null }),
        ]));
    });
});
