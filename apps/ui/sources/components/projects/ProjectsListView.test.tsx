import * as React from 'react';
import { act } from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openMachinePathBrowserModalSpy = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string | null>>());
const workspaceListDirectorySpy = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<any>>());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
let translationPrefixMock = '';

let machinesMock: Machine[] = [];
let workspaceRefsV1Mock: any[] = [];
let pinnedWorkspaceRefIdsV1Mock: string[] = [];
let deviceTypeMock: 'phone' | 'tablet' = 'tablet';
let paneScopesMock: Record<string, { right?: { activeTabId?: string | null } }> = {};
let localSettingsMock: Record<string, unknown> = {};
let projectLastMobileSurfacesByWorkspaceRefIdMock: Record<string, string> = {};
let accountSettingsMock: Record<string, unknown> = {};
const setWorkspaceRefsV1Spy = vi.hoisted(() => vi.fn());
const setPinnedWorkspaceRefIdsV1Spy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Platform: { OS: 'web' },
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
    return createTextModuleMock({
        translate: (key, params) => {
            const base = typeof params?.machine === 'string' ? `${key}:${params.machine}` : key;
            return `${translationPrefixMock}${base}`;
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@/components/appShell/panes/AppPaneProvider', async () => {
    const actual = await vi.importActual<typeof import('@/components/appShell/panes/AppPaneProvider')>(
        '@/components/appShell/panes/AppPaneProvider',
    );
    return {
        ...actual,
        useOptionalAppPaneContext: () => ({
            state: { scopes: paneScopesMock },
        }),
    };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
        },
    }).module;
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (...args: any[]) => openMachinePathBrowserModalSpy(...args),
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceListDirectory: (...args: any[]) => workspaceListDirectorySpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => machinesMock,
        useSetting: (key: string) => accountSettingsMock[key],
        useLocalSetting: (key: string) => localSettingsMock[key],
        useProjectLastMobileSurfacesByWorkspaceRefId: () => projectLastMobileSurfacesByWorkspaceRefIdMock,
        useSettingMutable: (key: string) => {
            if (key === 'workspaceRefsV1') return [workspaceRefsV1Mock, setWorkspaceRefsV1Spy];
            if (key === 'pinnedWorkspaceRefIdsV1') return [pinnedWorkspaceRefIdsV1Mock, setPinnedWorkspaceRefIdsV1Spy];
            return [undefined, vi.fn()];
        },
    });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const triggerParams = {
            open: Boolean(props.open),
            toggle: vi.fn(),
            openMenu: vi.fn(),
            closeMenu: vi.fn(),
            selectedItem: null,
        };
        const triggerResult = typeof props.trigger === 'function'
            ? props.trigger(triggerParams)
            : props.trigger ?? null;
        return React.createElement('DropdownMenu', props, triggerResult);
    },
}));

function createMachine(params: Readonly<{
    id: string;
    host: string;
    active?: boolean;
    activeAt?: number;
}>): Machine {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: params.active ?? true,
        activeAt: params.activeAt ?? 1,
        metadata: {
            host: params.host,
            platform: 'darwin',
            happyCliVersion: '0',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('ProjectsListView', () => {
    beforeEach(() => {
        standardCleanup();
        machinesMock = [];
        workspaceRefsV1Mock = [];
        pinnedWorkspaceRefIdsV1Mock = [];
        deviceTypeMock = 'tablet';
        paneScopesMock = {};
        localSettingsMock = {};
        projectLastMobileSurfacesByWorkspaceRefIdMock = {};
        accountSettingsMock = {};
        translationPrefixMock = '';
        openMachinePathBrowserModalSpy.mockReset();
        workspaceListDirectorySpy.mockReset();
        modalAlertSpy.mockReset();
        routerPushSpy.mockReset();
        setWorkspaceRefsV1Spy.mockReset();
        setPinnedWorkspaceRefIdsV1Spy.mockReset();
    });

    it('dedupes the empty-state add-first machine rows by display host and keeps the action subtitle', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm1', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
            createMachine({ id: 'm2', host: 'leeroy-mbp', active: false, activeAt: 1 }),
        ];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        const firstRow = screen.findByTestId('projects-add-first-machine:m1');
        expect(firstRow).toBeTruthy();
        if (!firstRow) {
            throw new Error('Expected projects-add-first-machine:m1 row to render');
        }
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => String(node.props.children) === 'projects.actions.chooseProjectFolderOnMachine:leeroy-mbp'),
        ).toBe(true);
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => String(node.props.children) === 'projects.actions.chooseProjectFolderSubtitle'),
        ).toBe(true);
        expect(screen.findByTestId('projects-add-first-machine:m2')).toBeNull();
    });

    it('does not persist a project when the selected path cannot be listed via workspace filesystem', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm1', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
        ];
        openMachinePathBrowserModalSpy.mockResolvedValueOnce('/');
        workspaceListDirectorySpy.mockResolvedValueOnce({ success: false, error: "Access denied: Path '/' is outside the allowed directories" });

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-add-first-machine:m1');

        expect(workspaceListDirectorySpy).toHaveBeenCalledTimes(1);
        expect(setWorkspaceRefsV1Spy).toHaveBeenCalledTimes(0);
        expect(routerPushSpy).toHaveBeenCalledTimes(0);
        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    });

    it('opens the last active mobile project subroute from the projects list', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        paneScopesMock = {
            'project:wr_1': {
                right: { activeTabId: 'git' },
            },
        };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith('/projects/wr_1/git?worktreeId=%40root');
    });

    it('defaults mobile project opens to the files route when no last tab is remembered', async () => {
        deviceTypeMock = 'phone';
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith('/projects/wr_1/files?worktreeId=%40root');
    });

    it('keeps project row menu props stable across unrelated cockpit-state rerenders', async () => {
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        const firstDropdown = screen.findAllByType('DropdownMenu' as any)[0];
        expect(firstDropdown).toBeTruthy();
        const firstItems = firstDropdown?.props?.items;
        const firstOnSelect = firstDropdown?.props?.onSelect;

        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'git' };

        await act(async () => {
            screen.tree.update(<ProjectsListView />);
        });

        const secondDropdown = screen.findAllByType('DropdownMenu' as any)[0];
        expect(secondDropdown?.props?.items).toBe(firstItems);
        expect(secondDropdown?.props?.onSelect).toBe(firstOnSelect);
    });

    it('reopens the remembered mobile worktree path without reviving the retired route setting', async () => {
        deviceTypeMock = 'phone';
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        localSettingsMock = {
            projectLastMobileRouteByWorkspaceRefId: { wr_1: 'git' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith('/projects/wr_1/files?worktreeId=gitwt_feature');
    });

    it('reopens the remembered cockpit-era mobile surface from local project state', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'overview' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith('/projects/wr_1?worktreeId=gitwt_feature&mobileSurface=overview');
    });

    it('reopens the remembered cockpit terminal surface from local project state', async () => {
        deviceTypeMock = 'phone';
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        projectLastMobileSurfacesByWorkspaceRefIdMock = { wr_1: 'terminal' };

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        await screen.pressByTestIdAsync('projects-list-item-wr_1');

        expect(routerPushSpy).toHaveBeenCalledWith('/projects/wr_1/terminal?worktreeId=gitwt_feature');
    });

    it('anchors project row menus below the trigger', async () => {
        workspaceRefsV1Mock = [{
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        }];

        const { ProjectsListView } = await import('./ProjectsListView');
        const screen = await renderScreen(<ProjectsListView />);

        const dropdowns = screen.findAllByType('DropdownMenu' as any);
        expect(dropdowns.length).toBeGreaterThan(0);
        expect(dropdowns[0]?.props.placement).toBe('bottom');
        expect(dropdowns[0]?.props.popoverAnchorAlign).toBe('end');
    });

    it('refreshes project row menu labels after the translation output changes', async () => {
        const workspaceRef = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'm1',
            rootPath: '/repo',
            label: 'Repo',
            createdAtMs: 1,
        };
        const { ProjectsListItemMenu } = await import('./ProjectsListItemMenu');
        const theme = createThemeFixture();
        const firstOnRemove = vi.fn();
        const screen = await renderScreen(
            <ProjectsListItemMenu
                theme={theme}
                workspaceRef={workspaceRef as any}
                pinAction="pin"
                onTogglePinned={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                onRemove={firstOnRemove}
            />,
        );

        const englishDropdown = screen.findAllByType('DropdownMenu' as any)[0];
        expect(englishDropdown).toBeTruthy();
        expect(englishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('sessionsList.renameWorkspace');

        translationPrefixMock = 'es:';
        const secondOnRemove = vi.fn();
        await act(async () => {
            screen.tree.update(
                <ProjectsListItemMenu
                    theme={theme}
                    workspaceRef={workspaceRef as any}
                    pinAction="pin"
                    onTogglePinned={vi.fn()}
                    onRename={vi.fn()}
                    onReset={vi.fn()}
                    onRemove={secondOnRemove}
                />,
            );
        });

        const spanishDropdown = screen.findAllByType('DropdownMenu' as any)[0];
        expect(spanishDropdown?.props.items.find((item: { id: string; title: string }) => item.id === 'rename')?.title)
            .toBe('es:sessionsList.renameWorkspace');
    });
});
