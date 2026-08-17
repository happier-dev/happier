import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stackOptionsCapture = createStackOptionsCapture();
const paneOpenDetailsTabSpy = vi.fn();
const setLocalSettingSpy = vi.fn();
const setSettingSpy = vi.fn();
let localSettingsMock: Record<string, unknown> = {};
let projectLastMobileSurfaceByWorkspaceRefIdMock: Record<string, string> = {};
let accountSettingsMock: Record<string, unknown> = {};
let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'phone';
let paneScopeStateMock: {
    right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
    details: {
        isOpen: boolean;
        tabs: Array<{ key: string; kind: string; resource: { kind: string; path: string } }>;
        activeTabKey: string | null;
        tabState: Record<string, unknown>;
    };
} = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
    details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
};
const routerMock = createExpoRouterMock({
    params: {
        workspaceRefId: 'wr_1',
        worktreeId: 'gitwt_feature',
    },
    navigation: { canGoBack: () => true },
    stackOptionsCapture,
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

const workspaceRefMock = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/Users/test/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useNavigation: () => ({
        canGoBack: () => true,
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => accountSettingsMock[key],
        useSettingMutable: (key: string) => [
            accountSettingsMock[key],
            (value: unknown) => {
                accountSettingsMock[key] = value;
                setSettingSpy(value);
            },
        ],
        useLocalSetting: (key: string) => {
            if (key === 'mobileWorkspaceExperienceV1') {
                throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
            }
            return localSettingsMock[key];
        },
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                if (key === 'mobileWorkspaceExperienceV1') {
                    throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
                }
                localSettingsMock[key] = value;
                setLocalSettingSpy(value);
            },
        ],
        useProjectLastMobileSurface: (workspaceRefId: string | null) => (
            workspaceRefId ? projectLastMobileSurfaceByWorkspaceRefIdMock[workspaceRefId] ?? null : null
        ),
    });
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: paneScopeStateMock,
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        closeDetails: vi.fn(),
        openDetailsTab: paneOpenDetailsTabSpy,
    }),
}));

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: {
            repo: {
                isRepo: true,
                worktrees: [
                    { id: 'gitwt_main', path: '/Users/test/repo', branch: 'main', isCurrent: true, isMain: true },
                    { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ],
            },
        },
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

vi.mock('@/components/projects/detail/ProjectRightPanel', () => ({
    ProjectRightPanel: (props: Record<string, unknown>) => React.createElement('ProjectRightPanelStub', props),
}));

vi.mock('@/components/projects/detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: (props: Record<string, unknown>) => React.createElement('ProjectDetailsMainPanelStub', props),
}));

vi.mock('@/components/workspaceCockpit/project/ProjectCockpitShell', () => ({
    ProjectCockpitShell: (props: Record<string, unknown>) => React.createElement('ProjectCockpitShellStub', props),
}));

describe('project mobile route headers', () => {
    beforeEach(() => {
        localSettingsMock = {};
        projectLastMobileSurfaceByWorkspaceRefIdMock = {};
        accountSettingsMock = {};
        deviceTypeMock = 'phone';
        paneScopeStateMock = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        };
        setLocalSettingSpy.mockClear();
        setSettingSpy.mockClear();
        stackOptionsCapture.reset();
        paneOpenDetailsTabSpy.mockClear();
        routerMock.spies.push.mockClear();
        routerMock.spies.replace.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git'],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files'],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details'],
        ['terminal', '@/app/(app)/projects/[workspaceRefId]/terminal'],
    ])('sets the native header title for the %s route', async (_name, moduleId) => {
        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(stackOptionsCapture.getResolved()).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'Project Alpha · feature-auth',
            headerBackTitle: 'common.back',
        }));
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', { wr_1: 'git' }],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', { wr_1: 'browse' }],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details', { wr_1: 'git' }],
        ['terminal', '@/app/(app)/projects/[workspaceRefId]/terminal', { wr_1: 'terminal' }],
    ])('persists the current mobile project subroute for the %s route', async (_name, moduleId, expected) => {
        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).toHaveBeenCalledWith(expected);
    });

    it('hydrates the remembered active worktree state from a worktreeId query param', async () => {
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/git')).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: '/Users/test/repo/.worktrees/feature-auth',
        });
        expect(setLocalSettingSpy).toHaveBeenCalledWith({
            wr_1: 'gitwt_feature',
        });
    });

    it('persists the details route when a fullscreen detail tab is actually present', async () => {
        paneScopeStateMock = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: 'a' } }],
                activeTabKey: 'file:a',
                tabState: {},
            },
        };
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).toHaveBeenCalledWith({ wr_1: 'tabs' });
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', 'push', '/projects/wr_1/details?worktreeId=gitwt_feature&showWorktrees=1&sourceSurface=git'],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', 'push', '/projects/wr_1/details?worktreeId=gitwt_feature&showWorktrees=1&sourceSurface=browse'],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details', 'replace', '/projects/wr_1/details?worktreeId=gitwt_feature&showWorktrees=1'],
        ['terminal', '@/app/(app)/projects/[workspaceRefId]/terminal', 'push', '/projects/wr_1/details?worktreeId=gitwt_feature&showWorktrees=1&sourceSurface=terminal'],
    ])('configures mobile header actions for the %s route', async (_name, moduleId, navigationMethod, expectedHref) => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };

        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerRight).toBe('function');

        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));

        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-open-terminal' })).toBeTruthy();
        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-toggle-workspace-experience' })).toBeTruthy();
        const worktreeButtons = headerTree.root.findAllByProps({ testID: 'project-mobile-header-open-worktrees' });
        expect(worktreeButtons.length > 0).toBe(true);

        await act(async () => {
            worktreeButtons[0]!.props.onPress();
        });
        if (navigationMethod === 'replace') {
            expect(routerMock.spies.replace).toHaveBeenCalledWith(expectedHref);
        } else {
            expect(routerMock.spies.push).toHaveBeenCalledWith(expectedHref);
        }

        const terminalButton = headerTree.root.findByProps({ testID: 'project-mobile-header-open-terminal' });
        await act(async () => {
            terminalButton.props.onPress();
        });
        expect(paneOpenDetailsTabSpy).toHaveBeenCalled();
        expect(paneOpenDetailsTabSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                key: 'terminal:project:wr_1:terminal',
                kind: 'terminal',
                resource: expect.objectContaining({
                    kind: 'terminal',
                    terminalInstanceId: 'project:wr_1:terminal',
                    cwd: '/Users/test/repo/.worktrees/feature-auth',
                }),
            }),
            { intent: 'pinned' },
        );
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', 'push'],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', 'push'],
        ['terminal', '@/app/(app)/projects/[workspaceRefId]/terminal', 'push'],
    ])('routes the cockpit worktrees header action through the root overview surface for the %s route', async (_name, moduleId, navigationMethod) => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };

        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));
        const worktreeButton = headerTree.root.findByProps({ testID: 'project-mobile-header-open-worktrees' });
        routerMock.spies.push.mockClear();
        routerMock.spies.replace.mockClear();

        await act(async () => {
            worktreeButton.props.onPress();
        });

        if (navigationMethod === 'replace') {
            expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=overview');
            expect(routerMock.spies.push).not.toHaveBeenCalled();
            return;
        }

        expect(routerMock.spies.push).toHaveBeenCalledWith('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=overview');
        expect(routerMock.spies.replace).not.toHaveBeenCalled();
    });

    it('routes the cockpit details header toggle through the root overview surface instead of the legacy showWorktrees query', async () => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));
        const worktreeButton = headerTree.root.findByProps({ testID: 'project-mobile-header-open-worktrees' });

        await act(async () => {
            worktreeButton.props.onPress();
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=overview');
        expect(routerMock.spies.push).not.toHaveBeenCalled();
    });

    it('toggles the mobile workspace experience from the project mobile header', async () => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/git')).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));
        const toggleButton = headerTree.root.findByProps({ testID: 'project-mobile-header-toggle-workspace-experience' });

        await act(async () => {
            toggleButton.props.onPress();
        });

        expect(setSettingSpy).toHaveBeenCalledWith('cockpit');
        expect(accountSettingsMock.mobileWorkspaceExperienceV1).toBe('cockpit');
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', 'git'],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', 'browse'],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details', 'tabs'],
        ['terminal', '@/app/(app)/projects/[workspaceRefId]/terminal', 'terminal'],
    ])('renders the project cockpit shell on the %s route when cockpit mode is enabled', async (_name, moduleId, surface) => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };

        const Screen = (await import(moduleId)).default as React.ComponentType;
        const screen = await renderScreen(<Screen />);

        const cockpit = screen.root.findByType('ProjectCockpitShellStub' as never);
        expect(cockpit.props.workspaceRef.id).toBe('wr_1');
        expect(cockpit.props.surface).toBe(surface);
        expect(screen.root.findAllByType('ProjectRightPanelStub' as never)).toHaveLength(0);
        expect(screen.root.findAllByType('ProjectDetailsMainPanelStub' as never)).toHaveLength(0);
    });

    it('routes terminal cockpit root selections through the project route selection owner', async () => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/terminal')).default as React.ComponentType;
        const screen = await renderScreen(<Screen />);
        const cockpit = screen.root.findByType('ProjectCockpitShellStub' as never);
        routerMock.spies.replace.mockClear();

        await act(async () => {
            cockpit.props.onSelectRootPath('  /Users/test/repo/.worktrees/feature-auth  ');
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1/terminal?worktreeId=gitwt_feature');
    });

    it('uses the mobile header test-id prefix on the phone index cockpit route', async () => {
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        projectLastMobileSurfaceByWorkspaceRefIdMock = { wr_1: 'overview' };

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));

        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-open-terminal' })).toBeTruthy();
        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-toggle-workspace-experience' })).toBeTruthy();
        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-open-worktrees' })).toBeTruthy();
    });
});
