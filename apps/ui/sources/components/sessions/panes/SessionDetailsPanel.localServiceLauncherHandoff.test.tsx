import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces';

import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

installSessionDetailsPanelCommonModuleMocks();

const detailsSurfaceHostSpy = vi.hoisted(() => vi.fn((props: unknown) => React.createElement('DetailsSurfaceHostMock', { props })));

vi.mock('@/components/appShell/panes/details/surfaces', () => ({
    DetailsSurfaceHost: (props: unknown) => detailsSurfaceHostSpy(props),
    createDetailsSurfacePaneCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace', () => ({
    DetailsSplitWorkspace: (props: {
        renderTabContent?: (tab: unknown) => React.ReactNode;
    }) => React.createElement(
        React.Fragment,
        null,
        props.renderTabContent?.({
            key: 'browser:launchpad',
            kind: 'browser-view',
            title: 'Browser',
            resource: {
                kind: 'browser-view',
                mode: 'launchpad',
                browserSessionId: 'browser_surface:details:browser_launchpad',
            },
            isPinned: true,
            isPreview: false,
        }),
    ),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { isOpen: false },
            details: {
                isOpen: true,
                activeTabKey: 'browser:launchpad',
                tabs: [],
                groups: [],
                root: null,
                tabState: {},
            },
        },
        closeDetails: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('./SessionDetailsPanelDetailViews', () => ({
    SessionCommitDetailsViewForPanel: () => React.createElement('SessionCommitDetailsViewForPanel'),
    SessionFileDetailsViewForPanel: () => React.createElement('SessionFileDetailsViewForPanel'),
    SessionScmReviewDetailsViewForPanel: () => React.createElement('SessionScmReviewDetailsViewForPanel'),
    SessionScmStashDetailsViewForPanel: () => React.createElement('SessionScmStashDetailsViewForPanel'),
    SessionSubagentDetailsViewForPanel: () => React.createElement('SessionSubagentDetailsViewForPanel'),
}));

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: () => React.createElement('SessionExecutionRunLauncherView'),
}));

vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    renderProviderSessionDetailsTab: () => null,
    resolveProviderSessionDetailsTabIconName: () => null,
}));

vi.mock('./registry/sessionSurfaces', () => ({
    renderSessionSurfaceTab: () => null,
    resolveSessionSurfaceTabIconName: () => null,
}));

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'preview:session-browser-feed',
            source: 'registered_preview',
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Session browser feed',
            subtitle: 'localhost:5173',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-session-browser-feed',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

describe('SessionDetailsPanel local service launcher handoff', () => {
    it('passes supplied LSV launcher rows into the browser details renderer', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        detailsSurfaceHostSpy.mockClear();

        await renderScreen(
            <SessionDetailsPanel
                sessionId="session-a"
                scopeId="session:session-a"
                nowMs={() => 4_000}
                localServiceLauncherState={buildLauncherState()}
            />,
        );

        const hostProps = detailsSurfaceHostSpy.mock.calls.at(-1)?.[0] as {
            renderers?: readonly Readonly<{
                id: string;
                render: (input: unknown) => React.ReactElement | null;
            }>[];
        };
        const browserRenderer = hostProps.renderers?.find((renderer) => renderer.id === 'browser-view-details-surface');
        const element = browserRenderer?.render({
            tab: {
                ...createBrowserLaunchpadDetailsTab(),
                isPinned: true,
                isPreview: false,
            },
            descriptor: { surfaceId: 'browser-launchpad' },
            active: true,
        }) as React.ReactElement<{ launchpadRows?: readonly { id: string; disabledReason: string | null }[] }> | null;

        expect(element?.props.launchpadRows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'localService:preview:session-browser-feed',
                disabledReason: null,
            }),
        ]));
    });
});
