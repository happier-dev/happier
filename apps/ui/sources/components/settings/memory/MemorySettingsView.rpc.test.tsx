import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const modalPrompt = vi.fn();
const machinesState = [
    { id: 'm1', metadata: { displayName: 'Machine 1' } },
    { id: 'm2', metadata: { displayName: 'Machine 2' } },
];

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
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', {
        ...props,
        testID: props.testID ?? props.itemTrigger?.itemProps?.testID,
    }),
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
    useAllMachines: () => machinesState,
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
    it('shows daemon memory status in read-only mode when daemon.memory.settings.get is unavailable', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                throw Object.assign(new Error('RPC method not available'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
            }
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
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                };
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const items = tree!.root.findAllByType('Item' as any);
        const enabledItem = items.find((item) => item.props?.title === 'memorySearchSettings.enabled.title');
        const statusItem = items.find((item) => item.props?.title === 'memorySearchSettings.status.title');

        expect(enabledItem?.props?.rightElement ?? null).toBeNull();
        expect(statusItem?.props?.subtitle).toBe('memorySearchSettings.status.readyLight');
    });

    it('clears stale status while loading settings for another machine', async () => {
        let resolveSecondSettings: ((value: any) => void) | null = null;
        machineRpcSpy.mockImplementation((params: any) => {
            if (params?.machineId === 'm1' && params?.method === 'daemon.memory.settings.get') {
                return Promise.resolve({ v: 1, enabled: true, indexMode: 'hints' });
            }
            if (params?.machineId === 'm1' && params?.method === 'daemon.memory.status') {
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
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                });
            }
            if (params?.machineId === 'm2' && params?.method === 'daemon.memory.settings.get') {
                return new Promise((resolve) => {
                    resolveSecondSettings = resolve;
                });
            }
            if (params?.machineId === 'm2' && params?.method === 'daemon.memory.status') {
                return Promise.resolve(null);
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const menu = tree!.root.findAllByType('DropdownMenu' as any)[0];
        await act(async () => {
            menu.props.onSelect?.('m2');
        });

        const statusItem = tree!.root.findAllByType('Item' as any).find((item) =>
            item.props?.title === 'memorySearchSettings.status.title',
        );
        expect(statusItem?.props?.subtitle).toBe('common.loading');

        await act(async () => {
            resolveSecondSettings?.({ v: 1, enabled: false, indexMode: 'hints' });
        });
    });

    it('falls back to read-only mode when daemon.memory.settings.set becomes unavailable', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return { v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' };
            }
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
                    embeddingsRuntimeState: 'unavailable',
                    embeddingsUsingFallback: false,
                    tier1DbPath: '/tmp/memory.sqlite',
                    deepDbPath: null,
                    tier1DbBytes: 1024,
                    deepDbBytes: null,
                };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                throw Object.assign(new Error('RPC method not available'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                });
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const menus = tree!.root.findAllByType('DropdownMenu' as any);
        const backfillMenu = menus.find(
            (m: any) => Array.isArray(m.props?.items) && m.props.items.some((i: any) => i.id === 'all_history'),
        );
        expect(backfillMenu).toBeTruthy();

        await act(async () => {
            backfillMenu!.props.onSelect?.('all_history');
        });

        const items = tree!.root.findAllByType('Item' as any);
        const enabledItem = items.find((item) => item.props?.title === 'memorySearchSettings.enabled.title');
        expect(enabledItem?.props?.rightElement ?? null).toBeNull();
    });

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

    it('writes embeddings preset changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'deep',
                    embeddings: {
                        mode: 'preset',
                        presetId: 'balanced',
                        custom: null,
                        blend: { ftsWeight: 0.7, embeddingWeight: 0.3 },
                    },
                };
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

        const dropdowns = tree!.root.findAllByType('DropdownMenu' as any);
        const embeddingsModeDropdown = dropdowns.find((item) => item.props?.testID === 'memory-settings-embeddings-mode');
        expect(embeddingsModeDropdown).toBeTruthy();

        await act(async () => {
            embeddingsModeDropdown!.props.onSelect?.('preset:long_context');
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.mode).toBe('preset');
        expect(call?.[0]?.payload?.embeddings?.presetId).toBe('long_context');
    });

    it('writes custom remote embeddings api keys as secret containers', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return {
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
                };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });
        modalPrompt.mockResolvedValue('sk-remote-test');

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const apiKeyItem = items.find((item) => item.props?.testID === 'memory-settings-embeddings-openai-api-key');
        expect(apiKeyItem).toBeTruthy();

        await act(async () => {
            await apiKeyItem!.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.apiKey).toEqual({ _isSecretValue: true, value: 'sk-remote-test' });
    });

    it('writes custom local embeddings model changes via daemon.memory.settings.set', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return {
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
                };
            }
            if (params?.method === 'daemon.memory.settings.set') {
                return params.payload;
            }
            throw new Error('unexpected rpc');
        });
        modalPrompt.mockResolvedValue('Xenova/jina-embeddings-v2-small-en');

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const modelItem = items.find((item) => item.props?.testID === 'memory-settings-embeddings-local-model');
        expect(modelItem).toBeTruthy();

        await act(async () => {
            await modelItem!.props.onPress?.();
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.modelId).toBe('Xenova/jina-embeddings-v2-small-en');
    });

    it('shows embeddings runtime status and active model details from daemon status', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'deep',
                };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
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
                };
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const items = tree!.root.findAllByType('Item' as any);
        const embeddingsStatusItem = items.find((item) => item.props?.title === 'memorySearchSettings.status.embeddingsTitle');
        const embeddingsModelItem = items.find((item) => item.props?.title === 'memorySearchSettings.status.embeddingsModelTitle');

        expect(embeddingsStatusItem?.props?.subtitle).toBe('memorySearchSettings.status.embeddingsReady');
        expect(embeddingsModelItem?.props?.subtitle).toBe('Xenova/jina-embeddings-v2-small-en');
    });

    it('shows embeddings fallback status when daemon is using text-only fallback', async () => {
        machineRpcSpy.mockImplementation(async (params: any) => {
            if (params?.method === 'daemon.memory.settings.get') {
                return {
                    v: 1,
                    enabled: true,
                    indexMode: 'deep',
                };
            }
            if (params?.method === 'daemon.memory.status') {
                return {
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
                };
            }
            throw new Error('unexpected rpc');
        });

        const { MemorySettingsView } = await import('./MemorySettingsView');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(MemorySettingsView));
        });
        await act(async () => {
            await Promise.resolve();
        });

        const items = tree!.root.findAllByType('Item' as any);
        const embeddingsStatusItem = items.find((item) => item.props?.title === 'memorySearchSettings.status.embeddingsTitle');

        expect(embeddingsStatusItem?.props?.subtitle).toBe('memorySearchSettings.status.embeddingsFallback');
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
