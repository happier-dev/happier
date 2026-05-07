import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type MachinesSettingsViewModel = {
    activeServerId: string;
    allMachines: Array<{ id: string; metadata?: { displayName?: string; host?: string } }>;
    hasMachines: boolean;
    isLoadingMachines: boolean;
    machineRows: Array<{ id: string; title: string; subtitle?: string; serverId?: string }>;
    showMachinesGroupedByServer: boolean;
    visibleMachineGroups: Array<{
        serverId: string;
        serverName: string;
        status: 'idle';
        machines: Array<{ id: string; metadata?: { displayName?: string; host?: string } }>;
    }>;
    relayDriftBanner: null | {
        kind: 'warning';
        title: string;
        description: string;
        actionLabel: string;
    };
};

const routerPushSpy = vi.fn();
const tauriDesktopState = vi.hoisted(() => ({ value: false }));

const viewModelState = vi.hoisted(() => ({
    value: null as unknown as MachinesSettingsViewModel,
}));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: 'blue', orange: 'orange' },
                    textSecondary: 'gray',
                    status: { connected: 'green', disconnected: 'red' },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: any) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/components/settings/server/sections/ActiveSelectionMachinesSection', () => ({
    ActiveSelectionMachinesSection: ({ visibleMachineGroups, allMachines, showMachinesGroupedByServer, machinesTitle }: any) => {
        const groups = showMachinesGroupedByServer
            ? visibleMachineGroups ?? []
            : [{ serverId: 'srv-a', title: machinesTitle, machines: allMachines ?? [] }];

        return React.createElement(
            React.Fragment,
            null,
            groups.map((group: any) =>
                React.createElement(
                    'Group',
                    {
                        key: group.serverId,
                        title: group.title,
                    },
                    (group.machines ?? []).map((machine: any) =>
                        React.createElement('Item', {
                            key: `${group.serverId}-${machine.id}`,
                            title: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
                        }),
                    ),
                ),
            ),
        );
    },
}));

vi.mock('./machinesSettingsViewModel', () => ({
    useMachinesSettingsViewModel: () => viewModelState.value,
}));

describe('MachinesSettingsView', () => {
    beforeEach(() => {
        routerPushSpy.mockClear();
        tauriDesktopState.value = false;
        viewModelState.value = {
            activeServerId: 'srv-a',
            allMachines: [
                {
                    id: 'machine-a1',
                    metadata: { displayName: 'Machine A1', host: 'a.local' },
                },
            ],
            hasMachines: true,
            isLoadingMachines: false,
            machineRows: [
                {
                    id: 'machine-a1',
                    title: 'Machine A1',
                    subtitle: 'status.online',
                    serverId: 'srv-a',
                },
            ],
            showMachinesGroupedByServer: false,
            visibleMachineGroups: [
                {
                    serverId: 'srv-a',
                    serverName: 'Server A',
                    status: 'idle',
                    machines: [
                        {
                            id: 'machine-a1',
                            metadata: { displayName: 'Machine A1', host: 'a.local' },
                        },
                    ],
                },
            ],
            relayDriftBanner: null,
        };
    });

    it('keeps the Machines settings screen web-safe by hiding desktop-only setup actions', async () => {
        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        expect(groups).toHaveLength(2);
        expect(groups[0]?.props.title).toBe('settings.machines');
        expect(groups[1]?.props.title).toBe('settings.addMachine');

        const firstGroupItems = groups[0]!.findAllByType('Item' as any);
        expect(firstGroupItems.map((node: any) => node.props.title)).toContain('Machine A1');
        expect(firstGroupItems.map((node: any) => node.props.title)).not.toContain('settings.machineSetupCurrentMachineTitle');
        expect(firstGroupItems.map((node: any) => node.props.title)).not.toContain('settings.addMachine');

        const setupNoticeItems = groups[1]!.findAllByType('Item' as any);
        expect(setupNoticeItems.map((node: any) => node.props.title)).toContain('setupOnboarding.webDesktopOnlyTitle');
        expect(setupNoticeItems.map((node: any) => node.props.subtitle)).toContain('setupOnboarding.webDesktopOnlyBody');
    });

    it('shows desktop-only setup actions when running inside the Tauri desktop shell', async () => {
        tauriDesktopState.value = true;

        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        const tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        expect(groups).toHaveLength(2);

        const secondGroupItems = groups[1]!.findAllByType('Item' as any);
        expect(secondGroupItems.map((node: any) => node.props.title)).toContain('settings.machineSetupCurrentMachineTitle');
        expect(secondGroupItems.map((node: any) => node.props.title)).toContain('settings.addMachine');

        const setupThisComputerItem = secondGroupItems.find((node: any) => node.props.title === 'settings.machineSetupCurrentMachineTitle');
        expect(setupThisComputerItem).toBeTruthy();
        await act(async () => {
            await pressTestInstanceAsync(setupThisComputerItem!);
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/this-computer');
    });

    it('renders relay drift on web as a read-only notice instead of a repair action card', async () => {
        viewModelState.value = {
            ...viewModelState.value,
            relayDriftBanner: {
                kind: 'warning',
                title: 'relay.banner.title',
                description: 'relay.banner.description',
                actionLabel: 'relay.banner.action',
            },
        };

        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        const tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const banners = tree.findAllByType('RelayDriftActionCard' as any);
        expect(banners).toHaveLength(0);

        const items = tree.findAllByType('Item' as any);
        expect(items.find((node: any) => node.props.testID === 'settings.machines.relayDrift.webNotice')).toBeTruthy();
    });

    it('shows an empty-state row when the user has no machines yet', async () => {
        viewModelState.value = {
            activeServerId: 'srv-a',
            allMachines: [],
            hasMachines: false,
            isLoadingMachines: false,
            machineRows: [],
            showMachinesGroupedByServer: false,
            visibleMachineGroups: [],
            relayDriftBanner: null,
        };

        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        const firstGroupItems = groups[0]!.findAllByType('Item' as any);

        expect(firstGroupItems.map((node: any) => node.props.title)).toContain('newSession.noMachinesFound');
        expect(firstGroupItems[0]?.props.showChevron).toBe(false);
    });

    it('shows a loading-state row when machines are still bootstrapping', async () => {
        viewModelState.value = {
            activeServerId: 'srv-a',
            allMachines: [],
            hasMachines: false,
            isLoadingMachines: true,
            machineRows: [],
            showMachinesGroupedByServer: false,
            visibleMachineGroups: [],
            relayDriftBanner: null,
        };

        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        const tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        const firstGroupItems = groups[0]!.findAllByType('Item' as any);

        expect(firstGroupItems.map((node: any) => node.props.title)).toContain('common.loading');
        expect(firstGroupItems[0]?.props.showChevron).toBe(false);
    });
});
