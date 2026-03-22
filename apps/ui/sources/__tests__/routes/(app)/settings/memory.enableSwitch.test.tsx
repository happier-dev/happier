import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const featureEnabledState: Record<string, boolean> = { 'memory.search': true };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            TextInput: 'TextInput',
                        }
    );
});

vi.mock('react-native-unistyles', async () => await createUnistylesMock());

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => createTextModuleMock());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.rightElement ?? null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => await createStorageModuleMock({
    importOriginal,
    overrides: {
        // Boundary fixture: only the machine fields exercised by this screen matter here.
        useAllMachines: (() => ([
            {
                id: 'm1',
                seq: 0,
                createdAt: 0,
                updatedAt: 0,
                active: true,
                activeAt: 0,
                metadata: { displayName: 'Machine 1' },
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ])) as any,
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv_1', generation: 1 }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));

afterEach(() => {
    machineRpcSpy.mockReset();
    featureEnabledState['memory.search'] = true;
});

describe('Memory settings (enable switch)', () => {
    it('loads daemon.memory.status alongside settings', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: false,
                    indexMode: 'hints',
                    hintsIndexReady: false,
                    deepIndexReady: false,
                    activeIndexReady: false,
                    embeddingsEnabled: false,
                    tier1DbPath: null,
                    deepDbPath: null,
                    tier1DbBytes: null,
                    deepDbBytes: null,
                };
            }
            return { v: 1 };
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        await renderScreen(React.createElement(Screen));

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.status',
        }));
    });

    it('does not fetch settings when memory.search is disabled', async () => {
        featureEnabledState['memory.search'] = false;
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        const screen = await renderScreen(React.createElement(Screen));

        const switches = screen.findAllByType('Switch' as any);
        expect(switches).toHaveLength(0);
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('writes daemon.memory.settings.set when toggling enabled', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: false,
                    indexMode: 'hints',
                    hintsIndexReady: false,
                    deepIndexReady: false,
                    activeIndexReady: false,
                    embeddingsEnabled: false,
                    tier1DbPath: null,
                    deepDbPath: null,
                    tier1DbBytes: null,
                    deepDbBytes: null,
                };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            return { v: 1 };
        });

        const mod = await import('@/app/(app)/settings/memory');
        const Screen = mod.default;

        const screen = await renderScreen(React.createElement(Screen));

        const switches = screen.findAllByType('Switch' as any);
        const enabledSwitch = switches.find((node: any) => node?.props?.testID == null);
        expect(enabledSwitch).toBeTruthy();
        await act(async () => {
            enabledSwitch!.props.onValueChange(true);
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.settings.set',
        }));

        const setCall = machineRpcSpy.mock.calls.find((call) => call?.[0]?.method === 'daemon.memory.settings.set');
        expect(setCall?.[0]?.payload?.enabled).toBe(true);
    });
});
