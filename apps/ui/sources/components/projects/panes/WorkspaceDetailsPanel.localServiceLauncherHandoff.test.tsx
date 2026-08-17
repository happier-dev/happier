import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import {
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';

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

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { details: { tabState: {} } },
        closeDetails: vi.fn(),
        openDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'unavailable',
        interactionEnabled: false,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    }),
}));

vi.mock('@/components/workspaces/files/details/WorkspaceFileDetailsView', () => ({
    WorkspaceFileDetailsView: () => React.createElement('WorkspaceFileDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceCommitDetailsView', () => ({
    WorkspaceCommitDetailsView: () => React.createElement('WorkspaceCommitDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView', () => ({
    WorkspaceScmReviewDetailsView: () => React.createElement('WorkspaceScmReviewDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmStashDetailsView', () => ({
    WorkspaceScmStashDetailsView: () => React.createElement('WorkspaceScmStashDetailsView'),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: () => React.createElement('ProjectTerminalSurface'),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useLocalSetting: () => false,
        useLocalSettingMutable: () => [false, vi.fn()],
        useWorkspaceReviewCommentsDrafts: () => [],
    });
});

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-1',
        updatedAt: 3_000,
        targets: [{
            id: 'preview:project-browser-feed',
            source: 'registered_preview',
            machineId: 'machine-1',
            title: 'Project browser feed',
            subtitle: 'localhost:3000',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-project-browser-feed',
                sessionId: 'session-project',
                machineId: 'machine-1',
            },
        }],
    });
}

const hostedPluginProjection = {
    ...EMPTY_PLUGIN_BROWSER_PROJECTION,
    generation: 4,
    targetsById: {
        'browserTarget:acme.preview:pane': {
            id: 'browserTarget:acme.preview:pane',
            pluginId: 'acme.preview',
            contributionKind: 'browserTarget',
            contributionId: 'pane',
            target: {
                kind: 'hostedPluginWeb',
                targetId: 'plugin_pane',
                pluginId: 'acme.preview',
                contributionId: 'pane',
                display: {
                    title: 'Plugin Preview',
                    addressLabel: 'plugin://acme.preview/pane',
                },
            },
            display: {
                title: 'Plugin Preview',
                addressLabel: 'plugin://acme.preview/pane',
            },
            endpointUrl: 'https://preview.happier.test/plugin/acme/',
            endpointExpiresAt: 1_700_000_000_000,
        },
    },
} satisfies PluginBrowserProjectionModel;

function renderBrowserLaunchpadRenderer(element: unknown): React.ReactElement<{
    launchpadRows?: readonly { id: string; disabledReason: string | null; target: { kind: string } | null }[];
}> | null {
    return element as React.ReactElement<{
        launchpadRows?: readonly { id: string; disabledReason: string | null; target: { kind: string } | null }[];
    }> | null;
}

describe('WorkspaceDetailsPanel local service launcher handoff', () => {
    it('passes supplied LSV launcher rows into the browser details renderer', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        detailsSurfaceHostSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    createdAtMs: 1_700_000_000_000,
                    label: 'Repo',
                }}
                scopeId="project:wr_1"
                activeRootPath="/repo/main"
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
            callbacks: { replaceTab: vi.fn() },
        }) as React.ReactElement<{ launchpadRows?: readonly { id: string; disabledReason: string | null }[] }> | null;

        expect(element?.props.launchpadRows).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'localService:preview:project-browser-feed',
                disabledReason: null,
            }),
        ]));
    });

    it('threads pluginBrowserProjection into the workspace launchpad feed (drift fix)', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        detailsSurfaceHostSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    createdAtMs: 1_700_000_000_000,
                    label: 'Repo',
                }}
                scopeId="project:wr_1"
                activeRootPath="/repo/main"
                localServiceLauncherState={buildLauncherState()}
                pluginBrowserProjection={hostedPluginProjection}
                nowMs={() => 1_500}
            />,
        );

        const hostProps = detailsSurfaceHostSpy.mock.calls.at(-1)?.[0] as {
            renderers?: readonly Readonly<{
                id: string;
                render: (input: unknown) => React.ReactElement | null;
            }>[];
        };
        const browserRenderer = hostProps.renderers?.find((renderer) => renderer.id === 'browser-view-details-surface');
        const element = renderBrowserLaunchpadRenderer(browserRenderer?.render({
            tab: {
                ...createBrowserLaunchpadDetailsTab(),
                isPinned: true,
                isPreview: false,
            },
            descriptor: { surfaceId: 'browser-launchpad' },
            active: true,
            callbacks: { replaceTab: vi.fn() },
        }));

        expect(element?.props.launchpadRows?.some((row) => row.target?.kind === 'hostedPluginWeb')).toBe(true);
    });
});
