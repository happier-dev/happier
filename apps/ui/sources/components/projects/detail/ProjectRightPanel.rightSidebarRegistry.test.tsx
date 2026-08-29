import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';

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
        phase: 'establishing' | 'current' | 'retainedOffline' | 'unavailable';
        interactionEnabled?: boolean;
        machineId: string | null;
        serverId: string | null;
        platform: 'web' | 'ios';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        phase: 'unavailable',
        machineId: 'm1',
        serverId: 's1',
        platform: 'web',
    },
}));
const scopedPluginProjectionState = vi.hoisted<{
    value: {
        pluginUiProjection: unknown;
        phase: 'establishing' | 'current' | 'retainedOffline' | 'unavailable';
        interactionEnabled?: boolean;
        machineId: string | null;
        serverId: string | null;
        platform: 'web' | 'ios';
    };
}>(() => ({
    value: {
        pluginUiProjection: null,
        phase: 'unavailable',
        machineId: 'm1',
        serverId: 's1',
        platform: 'web',
    },
}));

const appPaneScopeMock = vi.hoisted(() => ({
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
    selectRightDestination: vi.fn(),
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
        selectRightDestination: appPaneScopeMock.selectRightDestination,
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

const REVIEW_PLUGIN_ID = 'acme.review';
const GLOBAL_PLUGIN_ID = 'acme.global';
const SCOPED_PLUGIN_ID = 'acme.scoped';

function projectRightSidebarBinding(pluginId: string, destinationId: string) {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId,
        rendererId: 'project-panel-renderer',
        container: 'rightSidebarTab',
        target: { kind: 'project' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 project right-sidebar binding');
    }
    return binding;
}

function createProjectPluginProjection() {
    const binding = projectRightSidebarBinding(REVIEW_PLUGIN_ID, 'project-review-panel');
    const placement = {
        id: `surfacePlacement:${REVIEW_PLUGIN_ID}:project-review-panel`,
        pluginId: REVIEW_PLUGIN_ID,
        contributionKind: 'surfacePlacement',
        descriptorId: 'project-review-panel',
        binding,
        target: binding.target,
        renderer: { kind: 'host', rendererId: 'review.projectPanel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        hostOrigin: {
            machineId: 'm1',
            serverId: 's1',
            generation: 4,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    pluginId: REVIEW_PLUGIN_ID,
                    machineId: 'm1',
                    materializationId: 'project-review-install-a',
                },
            } satisfies PluginMachineExecutionOriginV1,
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        unknownEntriesById: Object.freeze({}),
    });
}

describe('ProjectRightPanel right-sidebar registry tabs', () => {
    beforeEach(() => {
        deviceTypeMock = 'desktop';
        scopeState = { right: { isOpen: true, activeTabId: 'browser', tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: null,
            phase: 'unavailable',
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: null,
            phase: 'unavailable',
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        appPaneScopeMock.openRight.mockClear();
        appPaneScopeMock.closeRight.mockClear();
        appPaneScopeMock.setRightTab.mockClear();
        appPaneScopeMock.selectRightDestination.mockClear();
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
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`, tabState: {} } };
        pluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            phase: 'current',
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

        expect(screen.findByTestId(`project-rightpanel-tab:plugin:${REVIEW_PLUGIN_ID}:project-review-panel`)).toBeTruthy();
        expect(screen.findByTestId(`project-rightpanel-surface-plugin:${REVIEW_PLUGIN_ID}:project-review-panel`)).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.placement.descriptorId).toBe('project-review-panel');
        expect(host.props.machineId).toBe('m1');
        expect(host.props.serverId).toBe('s1');
    });

    it('keeps a restored desktop/tablet Project tab as a native-phone tombstone instead of advertising or mounting it', async () => {
        deviceTypeMock = 'phone';
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`,
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
                },
                tabState: {},
            },
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            phase: 'current',
            interactionEnabled: true,
            machineId: 'm1',
            serverId: 's1',
            platform: 'ios',
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

        expect(screen.findByTestId(`project-rightpanel-tab:plugin:${REVIEW_PLUGIN_ID}:project-review-panel`)).toBeNull();
        expect(screen.root.findAllByType('PluginSurfacePlacementHostStub' as never)).toHaveLength(0);
        expect(screen.findByTestId('plugin-rn-ui-unavailable-diagnostic-plugin_destination_unavailable')).toBeTruthy();
        expect(appPaneScopeMock.selectRightDestination).not.toHaveBeenCalled();
    });

    it('routes a qualified plugin open through the shared current resolver before selecting the project pane', async () => {
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`,
                tabState: {},
            },
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            phase: 'current',
            interactionEnabled: true,
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
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);

        await act(async () => {
            await expect(host.props.binding.openSurface({
                destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
                input: { source: 'review-header' },
            })).resolves.toEqual({ ok: true });
        });
        expect(appPaneScopeMock.selectRightDestination).toHaveBeenCalledWith({
            kind: 'plugin',
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
        });
    });

    it('routes a mounted project tab through the shared qualified destination resolver', async () => {
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`,
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
                },
                tabState: {},
            },
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            phase: 'current',
            interactionEnabled: true,
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
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);

        await act(async () => {
            await expect(host.props.binding.openSurface({
                destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
                input: { source: 'review' },
            })).resolves.toEqual({ ok: true });
        });
        expect(appPaneScopeMock.selectRightDestination).toHaveBeenCalledWith({
            kind: 'plugin',
            destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
        });
    });

    it('does not replace a restored plugin tab with a built-in before the scoped projection is current', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`, tabState: {} } };
        scopedPluginProjectionState.value = {
            pluginUiProjection: null,
            phase: 'establishing',
            interactionEnabled: false,
            machineId: 'm1',
            serverId: 's1',
            platform: 'web',
        };
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(appPaneScopeMock.setRightTab).not.toHaveBeenCalled();
    });

    it('hands a retained offline projection to the plugin host instead of showing projection loading forever', async () => {
        scopeState = {
            right: {
                isOpen: true,
                activeTabId: `plugin:${REVIEW_PLUGIN_ID}:project-review-panel`,
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: REVIEW_PLUGIN_ID, localId: 'project-review-panel' },
                },
                tabState: {},
            },
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: createProjectPluginProjection(),
            phase: 'retainedOffline',
            // A retained snapshot is displayable but never executable even
            // if a stale caller has not yet cleared this boolean.
            interactionEnabled: true,
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

        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.projectionInteractionEnabled).toBe(false);
    });

    it('uses the workspace-scoped plugin projection instead of the app-shell projection', async () => {
        scopeState = { right: { isOpen: true, activeTabId: `plugin:${SCOPED_PLUGIN_ID}:scoped-project-panel`, tabState: {} } };
        const globalProjection = createProjectPluginProjection();
        const scopedProjection = createProjectPluginProjection();
        const globalPlacement = Object.values(globalProjection.surfacePlacementsById)[0]!;
        const scopedPlacement = Object.values(scopedProjection.surfacePlacementsById)[0]!;
        const globalBinding = projectRightSidebarBinding(GLOBAL_PLUGIN_ID, 'global-project-panel');
        const scopedBinding = projectRightSidebarBinding(SCOPED_PLUGIN_ID, 'scoped-project-panel');
        const globalModel = {
            ...globalProjection,
            surfacePlacementsById: Object.freeze({
                [`surfacePlacement:${GLOBAL_PLUGIN_ID}:global-project-panel`]: Object.freeze({
                    ...globalPlacement,
                    id: `surfacePlacement:${GLOBAL_PLUGIN_ID}:global-project-panel`,
                    pluginId: GLOBAL_PLUGIN_ID,
                    descriptorId: 'global-project-panel',
                    binding: globalBinding,
                    target: globalBinding.target,
                }),
            }),
        };
        const scopedModel = {
            ...scopedProjection,
            surfacePlacementsById: Object.freeze({
                [`surfacePlacement:${SCOPED_PLUGIN_ID}:scoped-project-panel`]: Object.freeze({
                    ...scopedPlacement,
                    id: `surfacePlacement:${SCOPED_PLUGIN_ID}:scoped-project-panel`,
                    pluginId: SCOPED_PLUGIN_ID,
                    descriptorId: 'scoped-project-panel',
                    binding: scopedBinding,
                    target: scopedBinding.target,
                }),
            }),
        };
        pluginProjectionState.value = {
            pluginUiProjection: globalModel,
            phase: 'current',
            machineId: 'machine-global',
            serverId: 'server-global',
            platform: 'web',
        };
        scopedPluginProjectionState.value = {
            pluginUiProjection: scopedModel,
            phase: 'current',
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

        expect(screen.findByTestId(`project-rightpanel-tab:plugin:${GLOBAL_PLUGIN_ID}:global-project-panel`)).toBeNull();
        expect(screen.findByTestId(`project-rightpanel-tab:plugin:${SCOPED_PLUGIN_ID}:scoped-project-panel`)).toBeTruthy();
        const host = screen.findByType('PluginSurfacePlacementHostStub' as never);
        expect(host.props.machineId).toBe('m1');
        expect(host.props.serverId).toBe('s1');
        expect(host.props.placement.descriptorId).toBe('scoped-project-panel');
    });
});
