import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let localSettingsMock: Record<string, unknown> = {};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                localSettingsMock[key] = value;
            },
        ],
    });
});

vi.mock('@/components/projects/detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: (props: Record<string, unknown>) => React.createElement('ProjectDetailsMainPanel', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectBrowseFilesSurface', () => ({
    ProjectBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('ProjectBrowseFilesSurface', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectGitSurface', () => ({
    ProjectGitSurface: (props: Record<string, unknown>) => React.createElement('ProjectGitSurface', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: (props: Record<string, unknown>) => React.createElement('ProjectTerminalSurface', props),
}));

vi.mock('@/components/projects/detail/browser/ProjectRightPanelBrowserView', () => ({
    ProjectRightPanelBrowserView: (props: Record<string, unknown>) => React.createElement('ProjectRightPanelBrowserView', props),
}));

vi.mock('@/components/projects/detail/services/ProjectRightPanelServicesView', () => ({
    ProjectRightPanelServicesView: (props: Record<string, unknown>) => React.createElement('ProjectRightPanelServicesView', props),
}));

vi.mock('@/components/projects/detail/useProjectSurfaceActions', () => ({
    useProjectSurfaceActions: () => ({
        openFileInDetails: vi.fn(),
        openFileInDetailsPinned: vi.fn(),
        openReviewAllChanges: vi.fn(),
        openStashDetails: vi.fn(),
        openCreateWorktreeFlow: vi.fn(),
        openCommitInDetails: vi.fn(),
        revealInFilesTree: vi.fn(),
    }),
}));

vi.mock('@/sync/domains/workspaces/workspaceScope', () => ({
    buildWorkspaceCacheKey: () => 'workspace-cache-key',
}));

function PaneScopeProbe(props: Readonly<{ scopeId: string }>) {
    const pane = useAppPaneScope(props.scopeId);

    return React.createElement('PaneScopeProbe', {
        scopeState: pane.scopeState,
    });
}

function ManualRightTabSelection(props: Readonly<{
    scopeId: string;
    tabId: string;
    enabled: boolean;
}>) {
    const pane = useAppPaneScope(props.scopeId);

    React.useEffect(() => {
        if (!props.enabled) return;
        pane.openRight({ tabId: props.tabId });
        pane.setRightTab(props.tabId);
    }, [pane, props.enabled, props.tabId]);

    return null;
}

describe('ProjectCockpitShell', () => {
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
    });

    it('closes an already-open right pane when the overview surface becomes active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'project:wr_1': {
                    right: { isOpen: true, activeTabId: 'files', tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            projectLastMobileSurfaceByWorkspaceRefId: null,
        };

        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const workspaceRef = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            title: 'Repo',
        } as const;

        const screen = await renderScreen(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="overview"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
                <PaneScopeProbe scopeId="project:wr_1" />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <ProjectCockpitShell
                        workspaceRef={workspaceRef as any}
                        scopeId="project:wr_1"
                        activeRootPath="/repo"
                        activeWorktreeId={null}
                        surface="overview"
                        isFocused={true}
                        onSelectRootPath={vi.fn()}
                    />
                    <PaneScopeProbe scopeId="project:wr_1" />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabId: 'files',
        }));
        expect(screen.tree.findByType('ProjectDetailsMainPanel' as never).props.forceOverviewMode).toBe(true);
    });

    it('does not re-sync over a manually selected right-pane tab on a cockpit surface rerender', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'project:wr_1': {
                    right: { isOpen: true, activeTabId: 'files', tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            projectLastMobileSurfaceByWorkspaceRefId: null,
        };

        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const workspaceRef = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            title: 'Repo',
        } as const;

        const screen = await renderScreen(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="browse"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
                <PaneScopeProbe scopeId="project:wr_1" />
            </AppPaneProvider>,
        );

        await screen.update(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="browse"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
                <ManualRightTabSelection scopeId="project:wr_1" tabId="browser" enabled={true} />
                <PaneScopeProbe scopeId="project:wr_1" />
            </AppPaneProvider>,
        );

        await screen.update(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="browse"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
                <ManualRightTabSelection scopeId="project:wr_1" tabId="browser" enabled={false} />
                <PaneScopeProbe scopeId="project:wr_1" />
            </AppPaneProvider>,
        );

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: true,
            activeTabId: 'browser',
        }));
    });

    it('renders a stable terminal screen wrapper when the terminal surface is active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'project:wr_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            projectLastMobileSurfaceByWorkspaceRefId: null,
        };

        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const workspaceRef = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            title: 'Repo',
        } as const;

        const screen = await renderScreen(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="terminal"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
            </AppPaneProvider>,
        );

        expect(screen.tree.findByProps({ testID: 'project-terminal-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('ProjectTerminalSurface' as never).props.workspaceRefId).toBe('wr_1');
    });

    it('renders Browser and Services mobile surfaces through the shared right-sidebar owners', async () => {
        const { ProjectCockpitShell } = await import('./ProjectCockpitShell');
        const workspaceRef = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            title: 'Repo',
        } as const;

        const screen = await renderScreen(
            <AppPaneProvider>
                <ProjectCockpitShell
                    workspaceRef={workspaceRef as any}
                    scopeId="project:wr_1"
                    activeRootPath="/repo"
                    activeWorktreeId={null}
                    surface="browser"
                    isFocused={true}
                    onSelectRootPath={vi.fn()}
                />
            </AppPaneProvider>,
        );

        expect(screen.tree.findByProps({ testID: 'project-browser-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('ProjectRightPanelBrowserView' as never).props.workspaceRefId).toBe('wr_1');

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <ProjectCockpitShell
                        workspaceRef={workspaceRef as any}
                        scopeId="project:wr_1"
                        activeRootPath="/repo"
                        activeWorktreeId={null}
                        surface="services"
                        isFocused={true}
                        onSelectRootPath={vi.fn()}
                    />
                </AppPaneProvider>,
            );
        });

        expect(screen.tree.findByProps({ testID: 'project-services-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('ProjectRightPanelServicesView' as never).props.machineId).toBe('machine-1');
        expect(screen.tree.findByType('ProjectRightPanelServicesView' as never).props.serverId).toBe('server-1');
        // SVC-2: the mobile project cockpit supplies the live Services→Browser open binding.
        expect(screen.tree.findByType('ProjectRightPanelServicesView' as never).props.onOpenServiceInBrowser)
            .toBeTypeOf('function');
    });
});
