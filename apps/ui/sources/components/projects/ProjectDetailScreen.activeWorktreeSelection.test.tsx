import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const projectRightPanelSpy = vi.hoisted(() => vi.fn());
const projectDetailsMainPanelSpy = vi.hoisted(() => vi.fn());
const setLocalSettingSpy = vi.hoisted(() => vi.fn());
let localSettingsMock: Record<string, unknown> = {};

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
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: true, activeTabId: 'git' } },
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
    }),
}));

vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: Record<string, unknown> & {
        main?: React.ReactNode;
        rightPane?: React.ReactNode;
    }) => React.createElement('AppPaneScopeHost', props, props.main, props.rightPane),
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
    it('keeps the main panel and right panel in sync when the active worktree changes', async () => {
        localSettingsMock = {};
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
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
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/feature-persisted',
            },
        };
        setLocalSettingSpy.mockClear();
        projectRightPanelSpy.mockClear();
        projectDetailsMainPanelSpy.mockClear();
        const { ProjectDetailScreen } = await import('./ProjectDetailScreen');

        const screen = await renderScreen(<ProjectDetailScreen workspaceRefId="wr_1" />);

        const rightPanel = screen.tree.findByType('ProjectRightPanelStub' as never);
        const mainPanel = screen.tree.findByType('ProjectDetailsMainPanelStub' as never);

        expect(rightPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-persisted');
        expect(mainPanel.props.activeRootPath).toBe('/repo/.worktrees/feature-persisted');
    });

    it('adopts a persisted active worktree path when local settings hydrate after mount', async () => {
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
});
