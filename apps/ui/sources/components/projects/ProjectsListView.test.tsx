import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openMachinePathBrowserModalSpy = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<string | null>>());
const workspaceListDirectorySpy = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<any>>());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());

let machinesMock: Machine[] = [];
let workspaceRefsV1Mock: any[] = [];
let pinnedWorkspaceRefIdsV1Mock: string[] = [];
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
        translate: (key, params) => typeof params?.machine === 'string' ? `${key}:${params.machine}` : key,
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
        useSettingMutable: (key: string) => {
            if (key === 'workspaceRefsV1') return [workspaceRefsV1Mock, setWorkspaceRefsV1Spy];
            if (key === 'pinnedWorkspaceRefIdsV1') return [pinnedWorkspaceRefIdsV1Mock, setPinnedWorkspaceRefIdsV1Spy];
            return [undefined, vi.fn()];
        },
    });
});

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
});
