import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { renderScreen } from '@/dev/testkit';

import type { MemoryStatusV1 } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const modalPrompt = vi.fn();
const machinesState = [
    { id: 'm1', metadata: { displayName: 'Machine 1' } },
    { id: 'm2', metadata: { displayName: 'Machine 2' } },
];

function createReadyMemoryStatus(overrides: Partial<MemoryStatusV1> = {}): MemoryStatusV1 {
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
        embeddingsRuntimeState: 'unavailable',
        embeddingsUsingFallback: false,
        tier1DbPath: '/tmp/memory.sqlite',
        deepDbPath: null,
        tier1DbBytes: 1024,
        deepDbBytes: null,
        ...overrides,
    };
}

function installMemoryRpc(handlers: Readonly<{
    settingsGet?: (params: any) => Promise<any> | any;
    settingsSet?: (params: any) => Promise<any> | any;
    status?: (params: any) => Promise<any> | any;
}>): void {
    machineRpcSpy.mockImplementation(async (params: any) => {
        if (params?.method === 'daemon.memory.settings.get') {
            if (!handlers.settingsGet) throw new Error('unexpected rpc');
            return handlers.settingsGet(params);
        }
        if (params?.method === 'daemon.memory.settings.set') {
            if (!handlers.settingsSet) throw new Error('unexpected rpc');
            return handlers.settingsSet(params);
        }
        if (params?.method === 'daemon.memory.status') {
            if (!handlers.status) throw new Error('unexpected rpc');
            return handlers.status(params);
        }
        throw new Error('unexpected rpc');
    });
}

async function renderMemorySettingsView() {
    const { MemorySettingsView } = await import('./MemorySettingsView');
    return renderScreen(React.createElement(MemorySettingsView));
}

type MemorySettingsScreen = Awaited<ReturnType<typeof renderMemorySettingsView>>;

async function renderSettledMemorySettingsView(): Promise<MemorySettingsScreen> {
    const screen = await renderMemorySettingsView();
    await act(async () => {
        await Promise.resolve();
    });
    return screen;
}

function findDropdownMenu(
    screen: MemorySettingsScreen,
    predicate: (props: Record<string, unknown>) => boolean,
) {
    return screen.findAllByType('DropdownMenu' as any).find((menu) => predicate(menu.props as Record<string, unknown>));
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                View: 'View',
                AppState: {
                    addEventListener: () => ({ remove: () => {} }),
                },
                Platform: {
                    OS: 'web',
                    select: (opt: any) => opt?.default,
                },
            }
    );
});

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
    DropdownMenu: (props: any) =>
        React.createElement('DropdownMenu', {
            ...props,
            testID: props.testID ?? props.itemTrigger?.itemProps?.testID,
        }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: 'TextInput',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: modalPrompt,
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => machinesState,
});
});

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
    vi.resetModules();
});

describe('MemorySettingsView', () => {
    it('shows daemon memory status in read-only mode when daemon.memory.settings.get is unavailable', async () => {
        installMemoryRpc({
            settingsGet: () => {
                throw Object.assign(new Error('RPC method not available'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
            },
            status: () => createReadyMemoryStatus(),
        });

        const screen = await renderSettledMemorySettingsView();
        const enabledItem = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        const statusItem = screen.findByProps({ title: 'memorySearchSettings.status.title' });

        expect(enabledItem.props?.rightElement ?? null).toBeNull();
        expect(statusItem.props?.subtitle).toBe('memorySearchSettings.status.readyLight');
    });

    it('clears stale status while loading settings for another machine', async () => {
        let resolveSecondSettings: ((value: any) => void) | null = null;
        installMemoryRpc({
            settingsGet: (params: any) => {
                if (params?.machineId === 'm1') {
                    return Promise.resolve({ v: 1, enabled: true, indexMode: 'hints' });
                }
                if (params?.machineId === 'm2') {
                    return new Promise((resolve) => {
                        resolveSecondSettings = resolve;
                    });
                }
                throw new Error('unexpected rpc');
            },
            status: (params: any) => {
                if (params?.machineId === 'm1') {
                    return Promise.resolve(createReadyMemoryStatus());
                }
                if (params?.machineId === 'm2') {
                    return Promise.resolve(null);
                }
                throw new Error('unexpected rpc');
            },
        });

        const screen = await renderSettledMemorySettingsView();
        const menu = findDropdownMenu(screen, (props) => props.selectedId === 'm1');
        expect(menu).toBeTruthy();

        await act(async () => {
            menu!.props.onSelect?.('m2');
        });

        const statusItem = screen.findByProps({ title: 'memorySearchSettings.status.title' });
        expect(statusItem.props?.subtitle).toBe('common.loading');

        await act(async () => {
            resolveSecondSettings?.({ v: 1, enabled: false, indexMode: 'hints' });
        });
    });

    it('falls back to read-only mode when daemon.memory.settings.set becomes unavailable', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' }),
            status: () => createReadyMemoryStatus(),
            settingsSet: () => {
                throw Object.assign(new Error('RPC method not available'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
            },
        });

        const screen = await renderSettledMemorySettingsView();
        const backfillMenu = findDropdownMenu(
            screen,
            (props) => Array.isArray(props.items) && props.items.some((item: any) => item.id === 'all_history'),
        );
        expect(backfillMenu).toBeTruthy();

        await act(async () => {
            backfillMenu!.props.onSelect?.('all_history');
        });

        const enabledItem = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(enabledItem.props?.rightElement ?? null).toBeNull();
    });

    it('writes backfillPolicy changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const backfillMenu = findDropdownMenu(
            screen,
            (props) => Array.isArray(props.items) && props.items.some((item: any) => item.id === 'all_history'),
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
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints' }),
            settingsSet: (params: any) => params.payload,
        });
        modalPrompt.mockResolvedValue('codex');

        const screen = await renderSettledMemorySettingsView();
        const backendItem = screen.findByTestId('memory-settings-summarizer-backend');
        expect(backendItem).toBeTruthy();
        if (!backendItem) {
            return;
        }

        await act(async () => {
            await backendItem.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerBackendId).toBe('codex');
    });

    it('writes hints.summarizerPermissionMode changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints' }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const permissionMenu = findDropdownMenu(
            screen,
            (props) => Array.isArray(props.items) && props.items.some((item: any) => item.id === 'read_only'),
        );
        expect(permissionMenu).toBeTruthy();

        await act(async () => {
            permissionMenu!.props.onSelect?.('read_only');
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerPermissionMode).toBe('read_only');
    });

    it('writes deleteOnDisable changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', deleteOnDisable: false }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const privacyItem = screen.findByTestId('memory-settings-delete-on-disable-item');
        if (!privacyItem) {
            return;
        }
        const toggle = privacyItem.props?.rightElement;
        expect(toggle?.props?.testID).toBe('memory-settings-delete-on-disable');
        if (!toggle) {
            return;
        }

        await act(async () => {
            toggle.props.onValueChange?.(true);
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.deleteOnDisable).toBe(true);
    });

    it('writes embeddings preset changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                embeddings: {
                    mode: 'preset',
                    presetId: 'balanced',
                    custom: null,
                    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
                },
            }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const embeddingsModeDropdown = screen.findByTestId('memory-settings-embeddings-mode');
        expect(embeddingsModeDropdown).toBeTruthy();
        if (!embeddingsModeDropdown) {
            return;
        }

        await act(async () => {
            embeddingsModeDropdown.props.onSelect?.('preset:long_context');
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.mode).toBe('preset');
        expect(call?.[0]?.payload?.embeddings?.presetId).toBe('long_context');
    });

    it('writes custom remote embeddings api keys as secret containers', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                embeddings: {
                    mode: 'custom',
                    presetId: 'balanced',
                    custom: {
                        kind: 'openai_compatible',
                        baseUrl: 'https://example.test/v1',
                        apiKey: null,
                        model: 'text-embedding-3-small',
                        dimensions: 256,
                    },
                    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
                },
            }),
            settingsSet: (params: any) => params.payload,
        });
        modalPrompt.mockResolvedValue('sk-remote-test');

        const screen = await renderSettledMemorySettingsView();
        const apiKeyItem = screen.findByTestId('memory-settings-embeddings-openai-api-key');
        expect(apiKeyItem).toBeTruthy();
        if (!apiKeyItem) {
            return;
        }

        await act(async () => {
            await apiKeyItem.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.apiKey).toEqual({ _isSecretValue: true, value: 'sk-remote-test' });
    });

    it('writes custom local embeddings model changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                embeddings: {
                    mode: 'custom',
                    presetId: 'balanced',
                    custom: {
                        kind: 'local_transformers',
                        modelId: 'Xenova/all-MiniLM-L6-v2',
                        queryPrefix: null,
                        documentPrefix: null,
                    },
                    blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
                },
            }),
            settingsSet: (params: any) => params.payload,
        });
        modalPrompt.mockResolvedValue('Xenova/jina-embeddings-v2-small-en');

        const screen = await renderSettledMemorySettingsView();
        const modelItem = screen.findByTestId('memory-settings-embeddings-local-model');
        expect(modelItem).toBeTruthy();
        if (!modelItem) {
            return;
        }

        await act(async () => {
            await modelItem.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.modelId).toBe('Xenova/jina-embeddings-v2-small-en');
    });

    it('shows embeddings runtime status and active model details from daemon status', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
            }),
            status: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                hintsIndexReady: true,
                deepIndexReady: true,
                activeIndexReady: true,
                embeddingsEnabled: true,
                embeddingsMode: 'preset',
                embeddingsPresetId: 'long_context',
                embeddingsProviderKind: 'local_transformers',
                embeddingsModelId: 'Xenova/jina-embeddings-v2-small-en',
                embeddingsRuntimeState: 'ready',
                embeddingsUsingFallback: false,
                tier1DbPath: '/tmp/memory.sqlite',
                deepDbPath: '/tmp/deep.sqlite',
                tier1DbBytes: 1024,
                deepDbBytes: 2048,
            }),
        });

        const screen = await renderSettledMemorySettingsView();
        const embeddingsStatusItem = screen.findByProps({ title: 'memorySearchSettings.status.embeddingsTitle' });
        const embeddingsModelItem = screen.findByProps({ title: 'memorySearchSettings.status.embeddingsModelTitle' });

        expect(embeddingsStatusItem.props?.subtitle).toBe('memorySearchSettings.status.embeddingsReady');
        expect(embeddingsModelItem.props?.subtitle).toBe('Xenova/jina-embeddings-v2-small-en');
    });

    it('shows embeddings fallback status when daemon is using text-only fallback', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
            }),
            status: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                hintsIndexReady: true,
                deepIndexReady: true,
                activeIndexReady: true,
                embeddingsEnabled: true,
                embeddingsMode: 'custom',
                embeddingsPresetId: null,
                embeddingsProviderKind: 'openai_compatible',
                embeddingsModelId: 'text-embedding-3-small',
                embeddingsRuntimeState: 'error',
                embeddingsUsingFallback: true,
                tier1DbPath: '/tmp/memory.sqlite',
                deepDbPath: '/tmp/deep.sqlite',
                tier1DbBytes: 1024,
                deepDbBytes: 2048,
            }),
        });

        const screen = await renderSettledMemorySettingsView();
        const embeddingsStatusItem = screen.findByProps({ title: 'memorySearchSettings.status.embeddingsTitle' });

        expect(embeddingsStatusItem.props?.subtitle).toBe('memorySearchSettings.status.embeddingsFallback');
    });

    it('writes budgets.maxDiskMbLight changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', budgets: { maxDiskMbLight: 250 } }),
            settingsSet: (params: any) => params.payload,
        });
        modalPrompt.mockResolvedValue('123');

        const screen = await renderSettledMemorySettingsView();
        const budgetItem = screen.findByTestId('memory-settings-budget-light');
        expect(budgetItem).toBeTruthy();
        if (!budgetItem) {
            return;
        }

        await act(async () => {
            await budgetItem.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.budgets?.maxDiskMbLight).toBe(123);
    });
});
