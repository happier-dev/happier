import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks();

const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const detailsSplitWorkspaceSpy = vi.hoisted(() => vi.fn((props: {
    renderHeaderActions?: (() => React.ReactNode) | null;
    renderTabContent?: ((tab: unknown) => React.ReactNode) | null;
}) => React.createElement(React.Fragment, null, props.renderHeaderActions?.())));

vi.mock('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace', () => ({
    DetailsSplitWorkspace: (props: Parameters<typeof detailsSplitWorkspaceSpy>[0]) => detailsSplitWorkspaceSpy(props),
}));

vi.mock('@/components/appShell/panes/details/surfaces', () => ({
    DetailsSurfaceHost: (props: unknown) => React.createElement('DetailsSurfaceHostMock', { props }),
    createDetailsSurfacePaneCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { isOpen: false },
            details: {
                isOpen: true,
                activeTabKey: null,
                tabs: [],
                groups: [],
                root: null,
                tabState: {},
            },
        },
        closeDetails: vi.fn(),
        openDetailsTab: openDetailsTabSpy,
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props, testID: props.testID ?? 'browser-view-details-surface' })
    ),
    mergeBrowserSurfaceProductModels: (
        primary: Record<string, unknown> | null | undefined,
        fallback: Record<string, unknown> | null | undefined,
    ) => primary ?? fallback,
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

vi.mock('./useSessionDetailsPanelPluginRuntime', () => ({
    useSessionDetailsPanelPluginRuntime: () => ({
        machineId: 'machine_1',
        serverId: 'server_1',
        platform: 'web',
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        peerMediationObservabilityScope: null,
    }),
}));

vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    renderProviderSessionDetailsTab: () => null,
    resolveProviderSessionDetailsTabIconName: () => null,
}));

vi.mock('./registry/sessionSurfaces', () => ({
    renderSessionSurfaceTab: () => null,
    resolveSessionSurfaceTabIconName: () => null,
}));

describe('SessionDetailsPanel browser product mount', () => {
    it('opens the browser launchpad as a generic browser details surface tab', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        openDetailsTabSpy.mockClear();

        const screen = await renderScreen(
            <SessionDetailsPanel sessionId="s1" scopeId="session:s1" />,
        );

        await screen.pressByTestIdAsync('session-details-open-browser');

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'browser:launchpad',
                kind: 'browser-view',
                resource: expect.objectContaining({
                    kind: 'browser-view',
                    mode: 'launchpad',
                }),
            }),
            { intent: 'pinned' },
        );
    });

    it('registers the browser details renderer for session browser-surface tabs', async () => {
        const { createSessionDetailsSurfaceRenderers } = await import('./surfaces/sessionDetailsSurfaceRenderers');
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const launchpadRows = [{
            id: 'pluginHostedWeb:preview-pane',
            section: 'plugin',
            sourceKind: 'hostedPluginWeb',
            title: 'Preview pane',
            subtitle: 'localhost:4173',
            detail: 'acme.preview',
            target: {
                kind: 'hostedPluginWeb',
                targetId: 'preview-pane',
                pluginId: 'acme.preview',
                contributionId: 'preview-pane',
                display: { title: 'Preview pane', addressLabel: 'localhost:4173' },
            },
            currentUrl: 'https://plugins.happier.test/preview-pane/',
            currentUrlExpiresAt: 3_000,
            disabledReason: null,
            lastSeenAt: 2_000,
        }] satisfies readonly BrowserLaunchpadRow[];
        const tab = {
            ...createBrowserLaunchpadDetailsTab(),
            isPinned: true,
            isPreview: false,
        };
        const renderers = createSessionDetailsSurfaceRenderers({
            sessionId: 's1',
            scopeId: 'session:s1',
            requestClose: vi.fn(),
            openFileTab: vi.fn(),
            getStartEditingFileHandler: () => vi.fn(),
            sessionScreenTestIdsEnabled: false,
            closeDetailsTab: vi.fn(),
            launchpadRows,
            launchpadRefreshStatus: 'idle',
            launchpadRefreshError: null,
        });
        const renderInput = {
            tab,
            descriptor: {
                surfaceId: 'session:s1:browser:launchpad',
                resourceKey: 'browser:launchpad',
                scope: { kind: 'session' as const, sessionId: 's1' },
                region: 'details' as const,
                status: 'available' as const,
            },
            scope: { kind: 'session' as const, sessionId: 's1' },
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const browserRenderer = renderers.find((renderer) => renderer.id === 'browser-view-details-surface');

        expect(browserRenderer).toBeDefined();
        expect(browserRenderer?.owner).toBe('browser');
        expect(browserRenderer?.canRender(renderInput)).toBe(true);
        const screen = await renderScreen(<>{browserRenderer?.render(renderInput)}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        expect(host?.props.launchpadRows).toBe(launchpadRows);
        expect(host?.props.launchpadRefreshStatus).toBe('idle');
        expect(host?.props.launchpadRefreshError).toBeNull();
    });

    it('builds a live browser recording model for session browser-surface tabs', async () => {
        const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
        const launchpadTab = {
            ...createBrowserLaunchpadDetailsTab(),
            isPinned: true,
            isPreview: false,
        };
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        await renderScreen(
            <SessionDetailsPanel sessionId="s1" scopeId="session:s1" />,
        );
        const workspaceProps = detailsSplitWorkspaceSpy.mock.calls.at(-1)?.[0];
        expect(workspaceProps?.renderTabContent).toBeTypeOf('function');

        const panelScreen = await renderScreen(<>{workspaceProps?.renderTabContent?.(launchpadTab)}</>);
        const detailsHost = panelScreen.root.findByType('DetailsSurfaceHostMock' as never);
        const detailsHostProps = detailsHost.props.props as {
            renderers: ReadonlyArray<{
                id: string;
                render: (input: unknown) => React.ReactNode;
            }>;
        };
        const browserRenderer = detailsHostProps.renderers.find((renderer) => renderer.id === 'browser-view-details-surface');

        expect(browserRenderer).toBeDefined();

        const browserScreen = await renderScreen(<>{browserRenderer?.render({
            tab: launchpadTab,
            descriptor: {
                surfaceId: 'session:s1:browser:launchpad',
                resourceKey: 'browser:launchpad',
                scope: { kind: 'session', sessionId: 's1' },
                region: 'details',
                status: 'available',
            },
            scope: { kind: 'session', sessionId: 's1' },
            region: 'details',
            active: true,
            callbacks: {},
        })}</>);
        const browserHost = browserScreen.findByTestId('browser-view-details-surface');

        expect(browserHost?.props.productModels?.browserRecording?.state).toBeTruthy();
    });
});
