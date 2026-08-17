import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const projectRightPanelSpy = vi.hoisted(() => vi.fn());
const projectDetailsMainPanelSpy = vi.hoisted(() => vi.fn());
const setLocalSettingSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const openRightSpy = vi.hoisted(() => vi.fn());
const setRightTabSpy = vi.hoisted(() => vi.fn());
let localSettingsMock: Record<string, unknown> = {};
const workspaceScmSnapshotControllerSpy = vi.hoisted(() => vi.fn());
let paneScopeStateMock: {
    right: {
        isOpen: boolean;
        activeTabId: string | null;
        selectedDestination?: Readonly<{
            kind: 'plugin';
            destination: Readonly<{ pluginId: string; localId: string }>;
        }> | null;
    };
    details?: { isOpen: boolean; tabs: Array<{ key: string }> };
} = {
    right: { isOpen: true, activeTabId: 'git' },
    details: { isOpen: false, tabs: [] },
};
const paneScopeSubscribers = new Set<() => void>();

function setPaneScopeState(nextState: typeof paneScopeStateMock): void {
    paneScopeStateMock = nextState;
    for (const subscriber of paneScopeSubscribers) {
        subscriber();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref: React.Ref<unknown>) =>
            React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
    });
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

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            back: routerBackSpy,
            replace: routerReplaceSpy,
        },
        navigation: {
            canGoBack: () => true,
        },
    }).module;
});

vi.mock('@react-navigation/native', () => ({
    useNavigation: () => ({
        canGoBack: () => true,
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => key === 'uiMultiPanePanelsEnabled'
            ? true
            : localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            key === 'projectLastActiveRootPathByWorkspaceRefId' ? {} : true,
            setLocalSettingSpy,
        ],
    });
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
    useHeaderHeight: () => 48,
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        interactionEnabled: false,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const scopeState = React.useSyncExternalStore(
            (subscriber) => {
                paneScopeSubscribers.add(subscriber);
                return () => {
                    paneScopeSubscribers.delete(subscriber);
                };
            },
            () => paneScopeStateMock,
            () => paneScopeStateMock,
        );
        return {
            scopeState,
            openRight: openRightSpy,
            closeRight: vi.fn(),
            setRightTab: setRightTabSpy,
            openDetailsTab: vi.fn(),
        };
    },
}));

vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: Record<string, unknown> & {
        main?: React.ReactNode;
        rightPane?: React.ReactNode;
        rightPaneBuiltinAdapter?: Readonly<{
            defaultDestinationId?: string;
            render: (context: Readonly<{ scopeId: string; destinationId: string }>) => React.ReactNode;
        }>;
        scopeId?: string;
    }) => React.createElement(
        'AppPaneScopeHost',
        props,
        props.main,
        props.rightPane ?? props.rightPaneBuiltinAdapter?.render({
            scopeId: props.scopeId ?? '',
            destinationId: props.rightPaneBuiltinAdapter.defaultDestinationId ?? 'files',
        }),
    ),
}));

const workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

vi.mock('./detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRef,
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: (scope: unknown) => {
        workspaceScmSnapshotControllerSpy(scope);
        return {
            snapshot: {
                repo: {
                    isRepo: true,
                    worktrees: [
                        { id: 'gitwt_main', path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                        { id: 'gitwt_feature', path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                        { id: 'gitwt_persisted', path: '/repo/.worktrees/feature-persisted', branch: 'feature/persisted', isCurrent: false },
                        { id: 'gitwt_hydrated', path: '/repo/.worktrees/feature-hydrated', branch: 'feature/hydrated', isCurrent: false },
                    ],
                },
            },
            loading: false,
            error: null,
            refresh: vi.fn(async () => {}),
        };
    },
}));

vi.mock('./detail/ProjectRightPanel', () => ({
    ProjectRightPanel: (props: Record<string, unknown>) => {
        projectRightPanelSpy(props);
        return React.createElement('ProjectRightPanelStub', props);
    },
}));

vi.mock('./detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: (props: Record<string, unknown>) => {
        projectDetailsMainPanelSpy(props);
        return React.createElement('ProjectDetailsMainPanelStub', props);
    },
}));

describe('ProjectDetailScreen active worktree selection', () => {
    it('reopens a closed project pane without overwriting its restored plugin destination', async () => {
        setPaneScopeState({
            right: {
                isOpen: false,
                activeTabId: 'files',
                selectedDestination: {
                    kind: 'plugin',
                    destination: { pluginId: 'acme.review', localId: 'project-review' },
                },
            },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        expect(openRightSpy).toHaveBeenCalledWith();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });

    it('keeps the main panel and right panel in sync when the active worktree changes', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        let rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        let mainPanel = screen.tree.findByType('ProjectDetailsMainPanelStub' as never);

        expect(rightPanel.props.activeRootPath).toBe('/repo');
        expect(mainPanel.props.activeRootPath).toBe('/repo');

        await act(async () => {
            rightPanel.props.onSelectRootPath('/repo/.worktrees/feature-auth');
        });

        rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        mainPanel = screen.tree.findByType('ProjectDetailsMainPanelStub' as never);

        expect(rightPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-auth');
        expect(mainPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-auth');
        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: '/repo/.worktrees/feature-auth',
        });
    });

    it('prefers the persisted active worktree path when the screen is uncontrolled', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/feature-persisted',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_persisted',
            },
        };
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        const rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        const mainPanel = screen.tree.findByType('ProjectDetailsMainPanelStub' as never);

        expect(rightPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-persisted');
        expect(mainPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-persisted');
    });

    it('falls back to the base project root when a persisted worktree path no longer exists', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/deleted-worktree',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_deleted',
            },
        };
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        const rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        const mainPanel = screen.tree.findByType('ProjectDetailsMainPanelStub' as never);
        const recoveryToast = screen.tree.findByProps({ testID: 'project-worktree-recovery-toast' });

        expect(rightPanel.props.activeRootPath).toBe('/repo');
        expect(mainPanel.props.activeRootPath).toBe('/repo');
        expect(recoveryToast).toBeTruthy();
        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: '/repo',
        });
    });

    it('repairs a controlled invalid worktree path through onSelectRootPath so route-backed screens recover', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const onSelectRootPath = vi.fn();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        await renderScreen(
            <ProjectDetailScreen
                workspaceRefId="wr_1"
                activeRootPath="/repo/.worktrees/deleted-worktree"
                onSelectRootPath={onSelectRootPath}
            />,
        );

        expect(onSelectRootPath).toHaveBeenCalledWith('/repo');
    });

    it('does not repair or persist route-backed worktree state while unfocused', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const onSelectRootPath = vi.fn();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        await renderScreen(
            React.createElement(ProjectDetailScreen as React.ComponentType<any>, {
                workspaceRefId: 'wr_1',
                activeRootPath: '/repo/.worktrees/deleted-worktree',
                isFocused: false,
                onSelectRootPath,
            }),
        );

        expect(onSelectRootPath).not.toHaveBeenCalled();
        expect(setLocalSettingSpy).not.toHaveBeenCalled();
    });

    it('adopts a persisted active worktree path when local settings hydrate after mount', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');
        const firstOnSelectRootPath = () => {};

        const screen = await renderScreen(
            <ProjectDetailScreen workspaceRefId="wr_1" onSelectRootPath={firstOnSelectRootPath} />,
        );
        expect(screen.tree.findByType('ProjectRightPanelStub' as never).props.activeRootPath).toBe('/repo');

        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/feature-hydrated',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_hydrated',
            },
        };
        const secondOnSelectRootPath = () => {};

        await act(async () => {
            await screen.update(
                <ProjectDetailScreen workspaceRefId="wr_1" onSelectRootPath={secondOnSelectRootPath} />,
            );
        });

        expect(screen.tree.findByType('ProjectRightPanelStub' as never).props.activeRootPath)
            .toBe('/repo/.worktrees/feature-hydrated');
    });

    it('keeps the main repository selected when the user explicitly switches back from a worktree', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/feature-persisted',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_persisted',
            },
        };
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);
        let rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);

        expect(rightPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-persisted');

        await act(async () => {
            rightPanel.props.onSelectRootPath('/repo');
        });

        rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        expect(rightPanel.props.activeRootPath).toBe('/repo');
        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: '/repo',
        });
        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: '@root',
        });
    });

    it('forwards explicit overview mode to the main panel on desktop', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(
            <ProjectDetailScreen
                workspaceRefId="wr_1"
                showWorktrees
            />,
        );

        expect(screen.tree.findByType('ProjectDetailsMainPanelStub' as never).props.forceOverviewMode).toBe(true);
    });

    it('keeps explicit overview visible when it is opened while details already exist', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: true, tabs: [{ key: 'file:a' }] },
        });
        const onSetShowWorktrees = vi.fn();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(
            <ProjectDetailScreen
                workspaceRefId="wr_1"
                showWorktrees
                onSetShowWorktrees={onSetShowWorktrees}
            />,
        );

        expect(screen.tree.findByType('ProjectDetailsMainPanelStub' as never).props.forceOverviewMode).toBe(true);
        expect(onSetShowWorktrees).not.toHaveBeenCalled();
    });

    it('automatically exits overview mode once a details tab is available', async () => {
        setPaneScopeState({
            right: { isOpen: true, activeTabId: 'git' },
            details: { isOpen: false, tabs: [] },
        });
        const onSetShowWorktrees = vi.fn();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(
            <ProjectDetailScreen
                workspaceRefId="wr_1"
                showWorktrees
                onSetShowWorktrees={onSetShowWorktrees}
            />,
        );

        await act(async () => {
            setPaneScopeState({
                right: { isOpen: true, activeTabId: 'git' },
                details: { isOpen: true, tabs: [{ key: 'terminal' }] },
            });
            await Promise.resolve();
        });

        expect(screen.tree.findByType('ProjectDetailsMainPanelStub' as never).props.forceOverviewMode).toBe(false);
        expect(onSetShowWorktrees).toHaveBeenCalledWith(false);
    });
});
