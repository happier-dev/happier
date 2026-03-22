import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

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
        metadata: {
            displayName: 'Machine 1',
            host: 'm1',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/m1/.happier',
            homeDir: '/Users/m1',
        },
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
        metadata: {
            displayName: 'Machine 2',
            host: 'm2',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/m2/.happier',
            homeDir: '/Users/m2',
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    },
] satisfies Machine[];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                View: 'View',
                Text: (props: any) => React.createElement('Text', props, props.children),
                TextInput: (props: any) => React.createElement('TextInput', props),
                Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                Platform: {
                    OS: 'web',
                    select: (options: any) => (options && 'default' in options ? options.default : undefined),
                },
            }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
            replace: vi.fn(),
            back: vi.fn(),
            setParams: vi.fn(),
        },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
                shadow: { color: '#000', opacity: 0.2 },
                input: { placeholder: '#999', background: '#fff' },
                accent: { blue: '#07f' },
                success: '#0a0',
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        {
            ...props,
            testID: props.testID ?? props.itemTrigger?.itemProps?.testID,
        },
    ),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useAllMachines: () => machinesState,
        },
    });
});

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
    standardCleanup();
});

function createMemoryStatusResponse(enabled: boolean) {
    return {
        v: 1,
        enabled,
        indexMode: 'hints',
        hintsIndexReady: enabled,
        deepIndexReady: false,
        activeIndexReady: enabled,
        embeddingsEnabled: false,
        embeddingsMode: 'disabled',
        embeddingsPresetId: null,
        embeddingsProviderKind: null,
        embeddingsModelId: null,
        embeddingsRuntimeState: enabled ? 'ready' : 'unavailable',
        embeddingsUsingFallback: false,
        tier1DbPath: enabled ? '/tmp/memory.sqlite' : null,
        deepDbPath: null,
        tier1DbBytes: enabled ? 1024 : null,
        deepDbBytes: null,
    };
}

async function renderMemorySearchScreen() {
    const Screen = (await import('@/app/(app)/search')).default;
    return renderScreen(React.createElement(Screen));
}

function findRequiredTestNode(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    testID: string,
) {
    const node = screen.findByTestId(testID);
    expect(node).toBeTruthy();
    if (!node) {
        throw new Error(`Expected ${testID} to exist`);
    }
    return node;
}

async function settleMemorySearchScreen() {
    await flushHookEffects();
}

describe('Memory search screen', () => {
    it('loads daemon.memory.status for the selected machine', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return createMemoryStatusResponse(true);
            }
            throw new Error('unexpected rpc');
        });

        await renderMemorySearchScreen();

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.status',
        }));
    });

    it('renders an explicit machine selector dropdown', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return createMemoryStatusResponse(true);
            }
            throw new Error('unexpected rpc');
        });

        const screen = await renderMemorySearchScreen();

        const menu = findRequiredTestNode(screen, 'memory-search-machine-trigger');
        expect(menu?.props?.itemTrigger?.title).toBe('memorySearchSettings.machine.changeTitle');
    });

    it('clears stale memory status while switching machines', async () => {
        let resolveSecondStatus: ((value: any) => void) | null = null;
        machineRpcSpy.mockImplementation((params: any) => {
            if (params?.method === 'daemon.memory.status' && params?.machineId === 'm1') {
                return Promise.resolve(createMemoryStatusResponse(true));
            }
            if (params?.method === 'daemon.memory.status' && params?.machineId === 'm2') {
                return new Promise((resolve) => {
                    resolveSecondStatus = resolve;
                });
            }
            throw new Error('unexpected rpc');
        });

        const screen = await renderMemorySearchScreen();

        const menu = findRequiredTestNode(screen, 'memory-search-machine-trigger');
        await act(async () => {
            menu.props.onSelect?.('m2');
        });
        await settleMemorySearchScreen();

        const textsAfterSwitch = screen.root.findAllByType('Text' as any).map((node) => node.props.children);
        expect(textsAfterSwitch).toContain('common.loading');
        expect(textsAfterSwitch).not.toContain('memorySearchSettings.status.readyLight');

        await act(async () => {
            resolveSecondStatus?.(createMemoryStatusResponse(false));
        });
    });

    it('does not call daemon.memory.search when memory.search is disabled', async () => {
        featureEnabledState['memory.search'] = false;
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('unexpected rpc');
        });

        const screen = await renderMemorySearchScreen();

        const btns = screen.findAllByTestId('memory-search-submit');
        expect(btns).toHaveLength(0);
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('calls daemon.memory.search when searching', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return createMemoryStatusResponse(true);
            }
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: true, hits: [] };
            }
            throw new Error('unexpected rpc');
        });

        const screen = await renderMemorySearchScreen();

        const input = findRequiredTestNode(screen, 'memory-search-query');
        await act(async () => {
            input.props.onChangeText?.('openclaw');
        });

        const btn = findRequiredTestNode(screen, 'memory-search-submit');
        await act(async () => {
            btn.props.onPress?.();
        });
        await settleMemorySearchScreen();

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.memory.search',
        }));
        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.search');
        expect(call?.[0]?.payload?.query).toBe('openclaw');
    });

    it('offers an enable CTA when memory is disabled', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.status') {
                return createMemoryStatusResponse(false);
            }
            if (params?.method === 'daemon.memory.search') {
                return { v: 1, ok: false, errorCode: 'memory_disabled', error: 'memory_disabled' };
            }
            throw new Error('unexpected rpc');
        });

        const screen = await renderMemorySearchScreen();

        const input = findRequiredTestNode(screen, 'memory-search-query');
        await act(async () => {
            input.props.onChangeText?.('openclaw');
        });

        const btn = findRequiredTestNode(screen, 'memory-search-submit');
        await act(async () => {
            btn.props.onPress?.();
        });

        await settleMemorySearchScreen();

        const enableBtn = findRequiredTestNode(screen, 'memory-search-enable');
        await act(async () => {
            enableBtn.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/memory');
    });
});
