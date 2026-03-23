import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type MachinesSettingsViewModel = {
    activeServerId: string;
    allMachines: Array<{ id: string; metadata?: { displayName?: string; host?: string } }>;
    hasMachines: boolean;
    machineRows: Array<{ id: string; title: string; subtitle?: string; serverId?: string }>;
    showMachinesGroupedByServer: boolean;
    visibleMachineGroups: Array<{
        serverId: string;
        serverName: string;
        status: 'idle';
        machines: Array<{ id: string; metadata?: { displayName?: string; host?: string } }>;
    }>;
};

const routerPushSpy = vi.fn();

const viewModelState = vi.hoisted(() => ({
    value: null as unknown as MachinesSettingsViewModel,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            View: 'View',
                                            Pressable: 'Pressable',
                                            Platform: {
                                                OS: 'web',
                                                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
                                            },
                                        }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
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
});

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
        viewModelState.value = {
            activeServerId: 'srv-a',
            allMachines: [
                {
                    id: 'machine-a1',
                    metadata: { displayName: 'Machine A1', host: 'a.local' },
                },
            ],
            hasMachines: true,
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
        };
    });

    it('renders existing machines in a separate section from setup actions', async () => {
        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        expect(groups).toHaveLength(2);
        expect(groups[0]?.props.title).toBe('settings.machines');

        const firstGroupItems = groups[0]!.findAllByType('Item' as any);
        const secondGroupItems = groups[1]!.findAllByType('Item' as any);

        expect(firstGroupItems.map((node: any) => node.props.title)).toContain('Machine A1');
        expect(secondGroupItems.map((node: any) => node.props.title)).toContain('settings.addMachine');

        const addMachineItem = secondGroupItems.find((node: any) => node.props.title === 'settings.addMachine');
        expect(addMachineItem).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(addMachineItem!);
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/machines/add');
    });

    it('shows an empty-state row when the user has no machines yet', async () => {
        viewModelState.value = {
            activeServerId: 'srv-a',
            allMachines: [],
            hasMachines: false,
            machineRows: [],
            showMachinesGroupedByServer: false,
            visibleMachineGroups: [],
        };

        const { MachinesSettingsView } = await import('./MachinesSettingsView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(MachinesSettingsView))).tree;

        const groups = tree.findAllByType('Group' as any);
        const firstGroupItems = groups[0]!.findAllByType('Item' as any);

        expect(firstGroupItems.map((node: any) => node.props.title)).toContain('newSession.noMachinesFound');
        expect(firstGroupItems[0]?.props.showChevron).toBe(false);
    });
});
