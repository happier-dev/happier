import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let scopeState: any = {
    right: { isOpen: true, activeTabId: 'browser', tabState: {} },
};
let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'desktop';

const pluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        machineId: string | null;
        serverId: string | null;
        platform: 'web';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        machineId: 'm1',
        serverId: 's1',
        platform: 'web',
    },
}));
const scopedPluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        machineId: string | null;
        serverId: string | null;
        platform: 'web';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        machineId: 'm1',
        serverId: 's1',
        platform: 'web',
    },
}));

const appPaneScopeMock = vi.hoisted(() => ({
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: appPaneScopeMock.openRight,
        closeRight: appPaneScopeMock.closeRight,
        setRightTab: appPaneScopeMock.setRightTab,
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/projects/files/WorkspaceRepositoryTreeBrowserView', () => ({
    WorkspaceRepositoryTreeBrowserView: () => React.createElement('WorkspaceRepositoryTreeBrowserViewStub'),
}));

vi.mock('@/components/projects/scm/WorkspaceRightPanelGitView', () => ({
    WorkspaceRightPanelGitView: () => React.createElement('WorkspaceRightPanelGitViewStub'),
}));

vi.mock('@/components/browser/surfaces', () => ({
    resolveBrowserSurfacePlatform: () => 'web',
    BrowserSurfaceHost: (props: Record<string, unknown>) => React.createElement('BrowserSurfaceHostStub', props),
}));

vi.mock('@/components/sessions/localServices', () => ({
    DetectedLocalServicesPane: (props: Record<string, unknown>) => React.createElement('DetectedLocalServicesPaneStub', props),
    LocalServicesSurfaceHost: (props: Record<string, unknown>) => React.createElement(
        'DetectedLocalServicesPaneStub',
        props,
    ),
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => pluginProjectionState.value,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => scopedPluginProjectionState.value,
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSurfacePlacementHost: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementHostStub', props),
    PluginSurfacePlacementStack: (props: Record<string, unknown>) => React.createElement('PluginSurfacePlacementStackStub', props),
}));

const workspaceRef = {
    id: 'wr_1',
    serverId: 's1',
    machineId: 'm1',
    rootPath: '/repo',
    createdAtMs: 1,
} satisfies WorkspaceRefV1;

function createProjectPluginProjection() {
    const placement = {
        id: 'pluginUi:review:surfacePlacement:project-review-panel',
        pluginId: 'review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'project-review-panel',
        placement: 'project.rightSidebarTab',
        target: { kind: 'project' },
        renderer: { kind: 'host', rendererId: 'review.projectPanel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        order: 70,
        rightSidebar: {
            tabId: 'review',
            scope: 'project',
            order: 70,
            mobile: { enabled: true, surface: 'pluginTab' },
            disabledPolicy: 'disable',
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        structuredMessagesByKind: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        surfacePlacementsByPlacement: Object.freeze({ 'project.rightSidebarTab': Object.freeze([placement]) }),
        uiArtifactsById: Object.freeze({}),
        digestsByPluginId: Object.freeze({}),
        unknownEntriesById: Object.freeze({}),
    });
}

describe('ProjectRightPanel right-sidebar registry tabs', () => {
    beforeEach(() => {
        deviceTypeMock = 'desktop';
        scopeState = { right: { isOpen: true, activeTabId: 'browser', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: null,
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        appPaneScopeMock.openRight.mockClear();
        appPaneScopeMock.closeRight.mockClear();
        appPaneScopeMock.setRightTab.mockClear();
    });

    it('drops the Browser tab on desktop but keeps Services (D1)', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        // D1: the desktop project right sidebar no longer shows a Browser tab; Services is the
        // single desktop services/launch surface.
        expect(screen.findByTestId('project-rightpanel-tab:browser')).toBeNull();
        expect(screen.findByTestId('project-rightpanel-surface-browser')).toBeNull();
        expect(screen.findByTestId('project-rightpanel-tab:services')).toBeTruthy();
    });

    it('renders the project Services surface through the local services owner', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'services', tabState: {} } };
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-surface-services')).toBeTruthy();
        expect(screen.findByType('DetectedLocalServicesPaneStub')).toBeTruthy();
    });

    it('keeps Browser and Services available on phone through the shared mobile projection lane', async () => {
        deviceTypeMock = 'phone';
        scopeState = { right: { isOpen: true, activeTabId: 'browser', tabState: {} } };
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-tab:browser')).toBeTruthy();
        expect(screen.findByTestId('project-rightpanel-tab:services')).toBeTruthy();
        expect(screen.findByTestId('project-rightpanel-surface-browser')).toBeTruthy();
        expect(appPaneScopeMock.setRightTab).not.toHaveBeenCalledWith('git');
    });

    it('renders plugin right-sidebar tabs through PluginSurfacePlacementHost', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'plugin:review:review', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        scopedPluginProjectionState.value = pluginProjectionState.value;
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-tab:plugin:review:review')).toBeTruthy();
        expect(screen.findByTestId('project-rightpanel-surface-plugin:review:review')).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.placement.descriptorId).toBe('project-review-panel');
        expect(host.props.machineId).toBe('m1');
        expect(host.props.serverId).toBe('s1');
    });

    it('uses the workspace-scoped plugin projection instead of the app-shell projection', async () => {
        scopeState = { right: { isOpen: true, activeTabId: 'plugin:scoped:review', tabState: {} } };
        const globalProjection = createProjectPluginProjection();
        const scopedProjection = createProjectPluginProjection();
        const globalPlacement = Object.values(globalProjection.surfacePlacementsById)[0]!;
        const scopedPlacement = Object.values(scopedProjection.surfacePlacementsById)[0]!;
        const globalModel = {
            ...globalProjection,
            surfacePlacementsById: Object.freeze({
                [globalPlacement.id]: Object.freeze({
                    ...globalPlacement,
                    pluginId: 'global',
                    descriptorId: 'global-project-panel',
                    rightSidebar: { ...globalPlacement.rightSidebar, tabId: 'review' },
                }),
            }),
            surfacePlacementsByPlacement: Object.freeze({
                'project.rightSidebarTab': Object.freeze([Object.freeze({
                    ...globalPlacement,
                    pluginId: 'global',
                    descriptorId: 'global-project-panel',
                    rightSidebar: { ...globalPlacement.rightSidebar, tabId: 'review' },
                })]),
            }),
        };
        const scopedModel = {
            ...scopedProjection,
            surfacePlacementsById: Object.freeze({
                [scopedPlacement.id]: Object.freeze({
                    ...scopedPlacement,
                    pluginId: 'scoped',
                    descriptorId: 'scoped-project-panel',
                    rightSidebar: { ...scopedPlacement.rightSidebar, tabId: 'review' },
                }),
            }),
            surfacePlacementsByPlacement: Object.freeze({
                'project.rightSidebarTab': Object.freeze([Object.freeze({
                    ...scopedPlacement,
                    pluginId: 'scoped',
                    descriptorId: 'scoped-project-panel',
                    rightSidebar: { ...scopedPlacement.rightSidebar, tabId: 'review' },
                })]),
            }),
        };
        pluginProjectionState.value = {
            pluginUiProjection: globalModel,
            machineId: 'machine-global',
            serverId: 'server-global',
            platform: 'web',
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: scopedModel,
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(screen.findByTestId('project-rightpanel-tab:plugin:global:review')).toBeNull();
        expect(screen.findByTestId('project-rightpanel-tab:plugin:scoped:review')).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.machineId).toBe('m1');
        expect(host.props.serverId).toBe('s1');
        expect(host.props.placement.descriptorId).toBe('scoped-project-panel');
    });
});
