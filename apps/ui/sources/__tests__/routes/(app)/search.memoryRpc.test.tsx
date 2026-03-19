import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const routerPushSpy = vi.fn();
const featureEnabledState: Record<string, boolean> = { 'memory.search': true };
const machinesState = [
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
    {
        id: 'm2',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { displayName: 'Machine 2' },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    },
];

vi.mock('react-native', () => ({
    View: 'View',
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            text: '#111',
            textSecondary: '#666',
            shadow: { color: '#000', opacity: 0.2 },
            input: { placeholder: '#999', background: '#fff' },
            accent: { blue: '#07f' },
            success: '#0a0',
        },
    };

    return {
        StyleSheet: { create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles) },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => machinesState,
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllSessions: () => ([
        { id: 'sess-1', metadata: { title: 'Session One' } },
    ]),
    useLocalSetting: () => null,
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: (session: any) => session?.metadata?.title ?? session?.id ?? 'session',
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
    it('loads daemon.memory.status for the selected machine', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'hints',
                    hintsIndexReady: true,
                    deepIndexReady: false,
                    activeIndexReady: true,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'ready',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
        const Screen = mod.default;

        await act(async () => {
            renderer.create(React.createElement(Screen));
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.status',
        }));
    });

    it('renders an explicit machine selector dropdown', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'hints',
                    hintsIndexReady: true,
                    deepIndexReady: false,
                    activeIndexReady: true,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'ready',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const menus = tree.root.findAllByType('DropdownMenu' as any);
        expect(menus.length).toBeGreaterThan(0);
        expect(menus[0]?.props?.itemTrigger?.title).toBe('memorySearchSettings.machine.changeTitle');
    });

    it('clears stale memory status while switching machines', async () => {
        let resolveSecondStatus: ((value: any) => void) | null = null;
        machineRpcSpy.mockImplementation((params: any) => {
            if (params?.method === 'daemon.memory.status' && params?.machineId === 'm1') {
                return Promise.resolve({
                    v: 1,
                    enabled: true,
                    indexMode: 'hints',
                    hintsIndexReady: true,
                    deepIndexReady: false,
                    activeIndexReady: true,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'ready',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                });
            }
            if (params?.method === 'daemon.memory.status' && params?.machineId === 'm2') {
                return new Promise((resolve) => {
                    resolveSecondStatus = resolve;
                });
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

        const menu = tree.root.findByType('DropdownMenu' as any);
        await act(async () => {
            menu.props.onSelect?.('m2');
        });

        const textsAfterSwitch = tree.root.findAllByType('Text' as any).map((node) => node.props.children);
        expect(textsAfterSwitch).toContain('common.loading');
        expect(textsAfterSwitch).not.toContain('memorySearchSettings.status.readyLight');

        await act(async () => {
            resolveSecondStatus?.({
                v: 1,
                enabled: false,
                indexMode: 'hints',
                hintsIndexReady: false,
                deepIndexReady: false,
                activeIndexReady: false,
                embeddingsEnabled: false,
                embeddingsMode: 'disabled',
                embeddingsPresetId: null,
                embeddingsProviderKind: null,
                embeddingsModelId: null,
                embeddingsRuntimeState: 'unavailable',
                embeddingsUsingFallback: false,
                tier1DbPath: null,
                deepDbPath: null,
                tier1DbBytes: null,
                deepDbBytes: null,
            });
        });
    });

    it('does not call daemon.memory.search when memory.search is disabled', async () => {
        featureEnabledState['memory.search'] = false;
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
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
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'hints',
                    hintsIndexReady: true,
                    deepIndexReady: false,
                    activeIndexReady: true,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'ready',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                };
            }
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: true, hits: [] };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
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
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.search',
        }));
        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.search');
        expect(call?.[0]?.payload?.query).toBe('openclaw');
    });

    it('offers an enable CTA when memory is disabled', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return {
                    v: 1,
                    enabled: false,
                    indexMode: 'hints',
                    hintsIndexReady: false,
                    deepIndexReady: false,
                    activeIndexReady: false,
                    embeddingsEnabled: false,
                    embeddingsMode: 'disabled',
                    embeddingsPresetId: null,
                    embeddingsProviderKind: null,
                    embeddingsModelId: null,
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: null,
                    deepDbPath: null,
                    tier1DbBytes: null,
                    deepDbBytes: null,
                };
            }
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
            }
            throw new Error('unexpected rpc');
        });

        const mod = await import('@/app/(app)/search');
        const Screen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const input = tree.root.findByType('TextInput' as any);
        await act(async () => {
            input.props.onChangeText?.('openclaw');
        });

        const btn = tree.root.findByProps({ testID: 'memory-search-submit' });
        await act(async () => {
            btn.props.onPress?.();
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const enableBtn = tree.root.findByProps({ testID: 'memory-search-enable' });
        await act(async () => {
            enableBtn.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/memory');
    });
});
