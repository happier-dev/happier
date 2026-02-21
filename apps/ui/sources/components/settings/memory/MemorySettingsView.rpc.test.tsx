import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const modalPrompt = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { OS: 'web', select: (opt: any) => opt?.default },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: {
        prompt: modalPrompt,
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => ([
        { id: 'm1', metadata: { displayName: 'Machine 1' } },
    ]),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv_1', generation: 1 }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

afterEach(() => {
    machineRpcSpy.mockReset();
    modalPrompt.mockReset();
});

describe('MemorySettingsView', () => {
    it('writes backfillPolicy changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const menus = tree!.root.findAllByType('DropdownMenu' as any);
        const backfillMenu = menus.find(
            (m: any) => Array.isArray(m.props?.items) && m.props.items.some((i: any) => i.id === 'all_history'),
        );
        expect(backfillMenu).toBeTruthy();

        await act(async () => {
            backfillMenu!.props.onSelect?.('all_history');
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.settings.set',
        }));
        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.backfillPolicy).toBe('all_history');
    });

    it('writes hints.summarizerBackendId changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: true, indexMode: 'hints' };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });
        modalPrompt.mockResolvedValue('codex');

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const backendItem = items.find((item) => item.props?.testID === 'memory-settings-summarizer-backend');
        expect(backendItem).toBeTruthy();

        await act(async () => {
            await backendItem!.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerBackendId).toBe('codex');
    });

    it('writes hints.summarizerPermissionMode changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: true, indexMode: 'hints' };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const menus = tree!.root.findAllByType('DropdownMenu' as any);
        const permissionMenu = menus.find(
            (m: any) => Array.isArray(m.props?.items) && m.props.items.some((i: any) => i.id === 'read_only'),
        );
        expect(permissionMenu).toBeTruthy();

        await act(async () => {
            permissionMenu!.props.onSelect?.('read_only');
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerPermissionMode).toBe('read_only');
    });

    it('writes deleteOnDisable changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: true, indexMode: 'hints', deleteOnDisable: false };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const privacyItem = items.find((item) => item.props?.testID === 'memory-settings-delete-on-disable-item');
        expect(privacyItem).toBeTruthy();
        const toggle = privacyItem!.props?.rightElement;
        expect(toggle?.props?.testID).toBe('memory-settings-delete-on-disable');

        await act(async () => {
            toggle.props.onValueChange?.(true);
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.deleteOnDisable).toBe(true);
    });

    it('writes embeddings.enabled changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: true, indexMode: 'deep', embeddings: { enabled: false } };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const embeddingsItem = items.find((item) => item.props?.testID === 'memory-settings-embeddings-enabled-item');
        expect(embeddingsItem).toBeTruthy();
        const toggle = embeddingsItem!.props?.rightElement;
        expect(toggle?.props?.testID).toBe('memory-settings-embeddings-enabled');

        await act(async () => {
            toggle.props.onValueChange?.(true);
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.enabled).toBe(true);
    });

    it('writes budgets.maxDiskMbLight changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: true, indexMode: 'hints', budgets: { maxDiskMbLight: 250 } };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });
        modalPrompt.mockResolvedValue('123');

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const budgetItem = items.find((item) => item.props?.testID === 'memory-settings-budget-light');
        expect(budgetItem).toBeTruthy();

        await act(async () => {
            await budgetItem!.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.budgets?.maxDiskMbLight).toBe(123);
    });
});
