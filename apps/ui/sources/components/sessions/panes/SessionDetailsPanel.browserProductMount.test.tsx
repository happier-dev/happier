import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { createPluginDetailsDestinationTab } from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
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

    it('registers the canonical qualified plugin details renderer for session tabs', async () => {
        const { createSessionDetailsSurfaceRenderers } = await import('./surfaces/sessionDetailsSurfaceRenderers');
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'com.example.viewer',
            destinationId: 'workspace-file',
            rendererId: 'workspace-file-renderer',
            container: 'detailsTab',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        if (!binding) throw new Error('session details fixture must be admitted');
        const placement = {
            id: 'surfacePlacement:com.example.viewer:workspace-file',
            pluginId: 'com.example.viewer',
            contributionKind: 'surfacePlacement' as const,
            descriptorId: 'workspace-file',
            binding,
            target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'workspace-file-renderer' },
            display: { developerFallback: 'Workspace file viewer' },
            availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
            headerActions: [],
        } satisfies PluginUiSurfacePlacementProjection;
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 4,
            surfacePlacementsById: { [placement.id]: placement },
        };
        const tab = {
            ...createPluginDetailsDestinationTab({
                destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
                title: 'Workspace file viewer',
            }),
            isPinned: true,
            isPreview: false,
        };
        const renderers = createSessionDetailsSurfaceRenderers({
            sessionId: 's1',
            scopeId: 'session:s1',
            machineId: 'machine-1',
            serverId: 'server-1',
            pluginUiProjection: projection,
            pluginUiProjectionPhase: 'current',
            pluginUiInteractionEnabled: true,
            platform: 'web',
            requestClose: vi.fn(),
            openFileTab: vi.fn(),
            getStartEditingFileHandler: () => vi.fn(),
            sessionScreenTestIdsEnabled: false,
            closeDetailsTab: vi.fn(),
        });
        const renderInput = {
            tab,
            descriptor: {
                surfaceId: 'session:s1:details:plugin-file',
                resourceKey: 'pluginDetailsDestination:plugin-file',
                scope: { kind: 'session' as const, sessionId: 's1', serverId: 'server-1', machineId: 'machine-1' },
                region: 'details' as const,
                status: 'available' as const,
            },
            scope: { kind: 'session' as const, sessionId: 's1', serverId: 'server-1', machineId: 'machine-1' },
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const renderer = renderers.find((candidate) => candidate.id === 'plugin-details-destination:session');

        expect(renderer).toBeDefined();
        expect(renderer?.canRender(renderInput)).toBe(true);
    });

    it('passes the current session file-tab context to the shared openable-content viewer owner', async () => {
        const { createSessionDetailsSurfaceRenderers } = await import('./surfaces/sessionDetailsSurfaceRenderers');
        const replaceTab = vi.fn();
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 9 };
        const renderers = createSessionDetailsSurfaceRenderers({
            sessionId: 's1',
            scopeId: 'session:s1',
            machineId: 'machine-1',
            serverId: 'server-1',
            pluginUiProjection: projection,
            pluginUiProjectionPhase: 'current',
            pluginUiInteractionEnabled: true,
            platform: 'web',
            requestClose: vi.fn(),
            openFileTab: vi.fn(),
            getStartEditingFileHandler: () => vi.fn(),
            sessionScreenTestIdsEnabled: false,
            closeDetailsTab: vi.fn(),
        });
        const renderInput = {
            tab: {
                key: 'file:README.md',
                kind: 'file',
                title: 'README.md',
                resource: { kind: 'file', path: 'README.md' },
                isPinned: true,
                isPreview: false,
            },
            descriptor: {
                surfaceId: 'session:s1:details:file:README.md',
                resourceKey: 'file:README.md',
                scope: {
                    kind: 'session' as const,
                    sessionId: 's1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                },
                region: 'details' as const,
                status: 'available' as const,
            },
            scope: {
                kind: 'session' as const,
                sessionId: 's1',
                serverId: 'server-1',
                machineId: 'machine-1',
            },
            region: 'details' as const,
            active: true,
            callbacks: { replaceTab },
        };
        const renderer = renderers.find((candidate) => candidate.id === 'session-file');

        const rendered = renderer?.render(renderInput);

        expect(React.isValidElement(rendered)).toBe(true);
        if (!React.isValidElement<{ openableContentViewer?: unknown }>(rendered)) return;
        expect(rendered.props.openableContentViewer).toMatchObject({
            targetKind: 'session',
            projection,
            details: renderInput,
            scopedLaunchFacts: {
                serverId: 'server-1',
                machineId: 'machine-1',
                generation: 9,
                interactionEnabled: true,
            },
        });
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
