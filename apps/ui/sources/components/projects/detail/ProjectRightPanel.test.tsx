import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'desktop';
const routerReplaceSpy = vi.fn();
const appPaneScopeMock = vi.hoisted(() => ({
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
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

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: true, activeTabId: 'git' } },
        openRight: appPaneScopeMock.openRight,
        closeRight: appPaneScopeMock.closeRight,
        setRightTab: appPaneScopeMock.setRightTab,
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            replace: routerReplaceSpy,
            push: vi.fn(),
            back: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@/components/projects/files/WorkspaceRepositoryTreeBrowserView', () => ({
    WorkspaceRepositoryTreeBrowserView: () => React.createElement('WorkspaceRepositoryTreeBrowserViewStub'),
}));

vi.mock('@/components/projects/scm/WorkspaceRightPanelGitView', () => ({
    WorkspaceRightPanelGitView: () => React.createElement('WorkspaceRightPanelGitViewStub'),
}));

describe('ProjectRightPanel', () => {
    it('does not render a close affordance when the parent screen does not provide one', async () => {
        deviceTypeMock = 'desktop';
        routerReplaceSpy.mockClear();
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const workspaceRef = {
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            createdAtMs: 1,
        } satisfies WorkspaceRefV1;

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
            />,
        );

        expect(screen.tree.findByType('WorkspaceRightPanelGitViewStub')).toBeTruthy();
        expect(screen.tree.findAll((node) => node.props?.testID === 'project-rightpanel-close')).toHaveLength(0);
    });

    it('navigates between sibling mobile routes when the segmented tabs are pressed on phone', async () => {
        deviceTypeMock = 'phone';
        routerReplaceSpy.mockClear();
        appPaneScopeMock.openRight.mockClear();
        appPaneScopeMock.setRightTab.mockClear();
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const workspaceRef = {
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            createdAtMs: 1,
        } satisfies WorkspaceRefV1;

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo"
                onSelectRootPath={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const filesTab = screen.tree.findByProps({ testID: 'project-rightpanel-tab:files' });
        await act(async () => {
            filesTab.props.onPress();
        });

        expect(appPaneScopeMock.openRight).toHaveBeenCalledWith({ tabId: 'files' });
        expect(appPaneScopeMock.setRightTab).toHaveBeenCalledWith('files');
        expect(routerReplaceSpy).toHaveBeenCalledWith('/projects/wr_1/files');
        expect(screen.tree.findAll((node) => node.props?.testID === 'project-rightpanel-close')).toHaveLength(0);
    });

    it('preserves the selected worktree path in mobile route changes', async () => {
        deviceTypeMock = 'phone';
        routerReplaceSpy.mockClear();
        appPaneScopeMock.openRight.mockClear();
        appPaneScopeMock.setRightTab.mockClear();
        const { ProjectRightPanel } = await import('./ProjectRightPanel');

        const workspaceRef = {
            id: 'wr_1',
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
            createdAtMs: 1,
        } satisfies WorkspaceRefV1;

        const screen = await renderScreen(
            <ProjectRightPanel
                workspaceRef={workspaceRef}
                scopeId="project:wr_1"
                activeRootPath="/repo/.worktrees/feature-auth"
                onSelectRootPath={() => {}}
                onRequestClose={() => {}}
            />,
        );

        const filesTab = screen.tree.findByProps({ testID: 'project-rightpanel-tab:files' });
        await act(async () => {
            filesTab.props.onPress();
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith(
            '/projects/wr_1/files?activeRootPath=%2Frepo%2F.worktrees%2Ffeature-auth',
        );
    });
});
