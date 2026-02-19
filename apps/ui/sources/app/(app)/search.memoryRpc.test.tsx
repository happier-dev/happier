import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const routerPushSpy = vi.fn();
const featureEnabledState: Record<string, boolean> = { 'memory.search': true };

vi.mock('react-native', () => ({
    View: 'View',
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { text: '#111', textSecondary: '#666', input: { placeholder: '#999', background: '#fff' } } },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => ([
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
    ]),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv_1', generation: 1 }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));

afterEach(() => {
    machineRpcSpy.mockReset();
    routerPushSpy.mockReset();
    featureEnabledState['memory.search'] = true;
});

describe('Memory search screen', () => {
    it('does not call daemon.memory.search when memory.search is disabled', async () => {
        featureEnabledState['memory.search'] = false;
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('unexpected rpc');
        });

        const mod = await import('./search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const btns = tree.root.findAllByProps({ testID: 'memory-search-submit' });
        expect(btns).toHaveLength(0);
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('calls daemon.memory.search when searching', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: true, hits: [] };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('./search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const input = tree.root.findByType('TextInput' as any);
        await act(async () => {
            input.props.onChangeText?.('openclaw');
        });

        const btn = tree.root.findByProps({ testID: 'memory-search-submit' });
        await act(async () => {
            btn.props.onPress?.();
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.search',
        }));
        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.search');
        expect(call?.[0]?.payload?.query).toBe('openclaw');
    });

    it('offers an enable CTA when memory is disabled', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('./search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const input = tree.root.findByType('TextInput' as any);
        await act(async () => {
            input.props.onChangeText?.('openclaw');
        });

        const btn = tree.root.findByProps({ testID: 'memory-search-submit' });
        await act(async () => {
            btn.props.onPress?.();
        });

        const enableBtn = tree.root.findByProps({ testID: 'memory-search-enable' });
        await act(async () => {
            enableBtn.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/memory');
    });
});
