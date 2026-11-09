import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

import type { MemoryStatusV1 } from '@happier-dev/protocol/memory/memoryStatus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.fn();
const modalPrompt = vi.fn();
const featureState = vi.hoisted(() => ({ memorySearchEnabled: true }));
const routerState = vi.hoisted(() => ({ push: null as null | ((...args: unknown[]) => unknown) & { mock: { calls: unknown[][] } } }));
const administrationTargetState = vi.hoisted(() => {
    const state: {
        current: {
            target: { serverIdentityId: string; machineId: string };
            serverId: string;
            machine: { id: string };
        } | null;
    } = {
        current: {
            target: { serverIdentityId: 'identity-1', machineId: 'm1' },
            serverId: 'srv_1',
            machine: { id: 'm1' },
        },
    };
    return Object.assign(state, {
        resolveExecutionTarget: () => state.current,
    });
});
const machinesState = [
    { id: 'm1', metadata: { displayName: 'Machine 1' } },
    { id: 'm2', metadata: { displayName: 'Machine 2' } },
];

function createReadyMemoryStatus(overrides: Record<string, unknown> = {}): MemoryStatusV1 {
    return {
        v: 1,
        enabled: true,
        indexMode: 'hints',
        hintsIndexReady: true,
        hintsIndexHasContent: true,
        deepIndexReady: false,
        deepIndexHasContent: false,
        activeIndexReady: true,
        activeIndexSearchable: true,
        indexContent: {
            lightShardCount: 1,
            lightTermCount: 12,
            deepChunkCount: 0,
            deepEmbeddingCount: 0,
            searchableSessionCount: 1,
            lastIndexedAtMs: 1,
            latestIndexedMessageAtMs: 1,
        },
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
        worker: null,
        queue: null,
        lastRun: null,
        ...overrides,
    } as MemoryStatusV1;
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
    return renderScreen(React.createElement(MemorySettingsView));
}

type MemorySettingsScreen = Awaited<ReturnType<typeof renderMemorySettingsView>>;

async function renderSettledMemorySettingsView(): Promise<MemorySettingsScreen> {
    const screen = await renderMemorySettingsView();
    await flushHookEffects({ cycles: 1 });
    return screen;
}

/** A row choosing between always-visible options, found by one of its option ids. */
function findSegmentedChoice(screen: MemorySettingsScreen, optionId: string) {
    return screen.findAllByType(Item).find((item) => {
        const tabs = (item.props as { rightElement?: { props?: { tabs?: unknown } } }).rightElement?.props?.tabs;
        return Array.isArray(tabs) && tabs.some((tab: { id?: string }) => tab.id === optionId);
    });
}

async function chooseSegment(screen: MemorySettingsScreen, optionId: string) {
    const choice = findSegmentedChoice(screen, optionId);
    expect(choice).toBeTruthy();
    await act(async () => {
        (choice!.props as any).rightElement.props.onSelectTab(optionId);
    });
}

/** Types into an inline field row and leaves the field, which commits the value. */
async function typeIntoFieldRow(screen: MemorySettingsScreen, rowTestID: string, text: string) {
    const findRow = () => screen.findAllByType(Item).find(node => node.props.testID === rowTestID);
    const row = findRow();
    expect(row?.props.rightElement?.props.onChangeText).toBeTypeOf('function');
    await act(async () => {
        findRow()!.props.rightElement.props.onChangeText(text);
    });
    await act(async () => {
        await findRow()!.props.rightElement.props.onBlur();
    });
}

function findDropdownMenu(
    screen: MemorySettingsScreen,
    predicate: (props: Record<string, unknown>) => boolean,
) {
    return screen.findAllByType(DropdownMenu).find((menu) => predicate(menu.props as Record<string, unknown>));
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            Platform: {
                OS: 'web',
                select: (opt: any) => opt?.default,
            },
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: modalPrompt,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllMachines: () => machinesState,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const mock = createExpoRouterMock();
        routerState.push = mock.spies.push as any;
        return mock.module;
    },
});






vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({ serverId: 'srv_1', generation: 1 }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcSpy,
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.current?.target ?? null,
        canExecute: administrationTargetState.current !== null,
        resolveExecutionTarget: administrationTargetState.resolveExecutionTarget,
    }),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => featureState.memorySearchEnabled,
}));

afterEach(() => {
    machineRpcSpy.mockReset();
    modalPrompt.mockReset();
    featureState.memorySearchEnabled = true;
    administrationTargetState.current = {
        target: { serverIdentityId: 'identity-1', machineId: 'm1' },
        serverId: 'srv_1',
        machine: { id: 'm1' },
    };
});

// Load real screen owners after boundary setup, outside behavior deadlines.
const { MemorySettingsView } = await import('./MemorySettingsView');
const { Item } = await import('@/components/ui/lists/Item');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

describe('MemorySettingsView', () => {
    it('keeps default keyword settings keyless when another indexing preference is saved', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1 }),
            settingsSet: (params) => params.payload,
            status: () => createReadyMemoryStatus({
                indexMode: 'deep',
                hintsIndexReady: false,
                hintsIndexHasContent: false,
                deepIndexReady: true,
                deepIndexHasContent: true,
            }),
        });

        const screen = await renderSettledMemorySettingsView();
        expect(screen.findByProps({ title: 'memorySearchSettings.enabled.title' }).props.rightElement.props.value).toBe(true);
        expect(findSegmentedChoice(screen, 'deep')?.props.rightElement.props.activeTabId).toBe('deep');
        await chooseSegment(screen, 'all_history');

        const saved = machineRpcSpy.mock.calls.find((call) => call[0]?.method === 'daemon.memory.settings.set')?.[0]?.payload;
        expect(saved).toMatchObject({
            enabled: true,
            indexMode: 'deep',
            backfillPolicy: 'all_history',
            hints: { enabled: false },
            embeddings: { mode: 'disabled' },
        });
    });

    it('opts into model hints when the person selects hints indexing', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, indexMode: 'deep', hints: { enabled: false } }),
            settingsSet: (params) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'hints');

        const saved = machineRpcSpy.mock.calls.find((call) => call[0]?.method === 'daemon.memory.settings.set')?.[0]?.payload;
        expect(saved).toMatchObject({ indexMode: 'hints', hints: { enabled: true } });
    });

    it('does not mislabel a transient status failure as an unsupported old daemon', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'hints',
                includeArchivedSessions: true,
            }),
            status: () => { throw new Error('temporarily unreachable'); },
        });

        const screen = await renderSettledMemorySettingsView();
        const archivedItem = screen.findAllByType(Item).find(node => node.props.testID === 'memory-settings-include-archived-item');
        expect(archivedItem?.props.subtitle).toBe('common.unavailable');
        expect(archivedItem?.props.subtitle).not.toBe('memorySearchSettings.archived.unsupportedSubtitle');
        expect(archivedItem?.props.rightElement?.props.disabled).toBe(true);
    });

    it('labels a resolved status without the effective field as an unsupported old daemon', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints' }),
            status: () => createReadyMemoryStatus(),
        });

        const screen = await renderSettledMemorySettingsView();
        const archivedItem = screen.findAllByType(Item).find(node => node.props.testID === 'memory-settings-include-archived-item');
        expect(archivedItem?.props.subtitle).toBe('memorySearchSettings.archived.unsupportedSubtitle');
        expect(archivedItem?.props.rightElement?.props.disabled).toBe(true);
    });

    it('shows daemon memory status in read-only mode when the daemon lacks daemon.memory.settings.get', async () => {
        installMemoryRpc({
            settingsGet: () => {
                // Only a missing method marks an old daemon read-only (7cde1e059b);
                // RPC_METHOD_NOT_AVAILABLE is a retryable routing failure.
                throw Object.assign(new Error('Method not found'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
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

    it('uses the exact Administration target rather than the first listed machine for memory RPCs', async () => {
        administrationTargetState.current = {
            target: { serverIdentityId: 'identity-2', machineId: 'm2' },
            serverId: 'srv_2',
            machine: { id: 'm2' },
        };
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', backfillPolicy: 'new_only' }),
            settingsSet: (params: any) => params.payload,
            status: () => createReadyMemoryStatus(),
        });

        const screen = await renderSettledMemorySettingsView();
        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm2',
            serverId: 'srv_2',
            method: 'daemon.memory.settings.get',
        }));

        await chooseSegment(screen, 'all_history');

        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'm2',
            serverId: 'srv_2',
            method: 'daemon.memory.settings.set',
        }));
    });

    it('falls back to read-only mode when the daemon lacks daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' }),
            status: () => createReadyMemoryStatus(),
            settingsSet: () => {
                // Only a missing method marks an old daemon read-only (7cde1e059b);
                // RPC_METHOD_NOT_AVAILABLE is a retryable routing failure.
                throw Object.assign(new Error('Method not found'), {
                    rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
                });
            },
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'all_history');

        const enabledItem = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(enabledItem.props?.rightElement ?? null).toBeNull();
    });

    it('writes backfillPolicy changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: false, indexMode: 'hints', backfillPolicy: 'new_only' }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'all_history');

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

        const screen = await renderSettledMemorySettingsView();
        await typeIntoFieldRow(screen, 'memory-settings-summarizer-backend', 'codex');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerBackendId).toBe('codex');
    });

    it('writes hints.summarizerPermissionMode changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints' }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'read_only');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.hints?.summarizerPermissionMode).toBe('read_only');
    });

    it('writes deleteOnDisable changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', deleteOnDisable: false }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const privacyItem = screen.findAllByType(Item).find(node => node.props.testID === 'memory-settings-delete-on-disable-item');
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
        const embeddingsModeDropdown = findDropdownMenu(screen, props => {
            const trigger = props.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return trigger?.itemProps?.testID === 'memory-settings-embeddings-mode';
        });
        expect(embeddingsModeDropdown).toBeTruthy();

        await act(async () => {
            embeddingsModeDropdown!.props.onSelect?.('preset:long_context');
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

        const screen = await renderSettledMemorySettingsView();
        await typeIntoFieldRow(screen, 'memory-settings-embeddings-openai-api-key', 'sk-remote-test');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.apiKey).toEqual({ _isSecretValue: true, value: 'sk-remote-test' });
    });

    it('switches the custom embeddings provider from its two always-visible choices', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'deep',
                embeddings: { mode: 'custom', presetId: 'balanced', custom: { kind: 'local_transformers', modelId: 'm' } },
            }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'openai_compatible');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.embeddings?.custom?.kind).toBe('openai_compatible');
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

        const screen = await renderSettledMemorySettingsView();
        await typeIntoFieldRow(screen, 'memory-settings-embeddings-local-model', 'Xenova/jina-embeddings-v2-small-en');

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

    it('shows index content and queue status from daemon memory telemetry', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints' }),
            status: () => createReadyMemoryStatus({
                activeIndexSearchable: false,
                indexContent: {
                    lightShardCount: 0,
                    lightTermCount: 0,
                    deepChunkCount: 0,
                    deepEmbeddingCount: 0,
                    searchableSessionCount: 0,
                    lastIndexedAtMs: null,
                    latestIndexedMessageAtMs: null,
                },
                queue: {
                    selectedSessionCount: 6,
                    queuedSessionCount: 3,
                    indexingSessionCount: 1,
                    indexedSessionCount: 1,
                    emptySessionCount: 1,
                    failedSessionCount: 0,
                    waitingSessionCount: 0,
                    oldestQueuedAtMs: 123,
                },
                worker: {
                    state: 'indexing',
                    lastTickAtMs: 456,
                    lastInventoryAtMs: 123,
                    currentSessionId: 'sess_1',
                    currentPhase: 'backfill',
                },
                lastRun: {
                    startedAtMs: 1,
                    finishedAtMs: null,
                    sessionsConsidered: 6,
                    sessionsProcessed: 2,
                    rawRowsFetched: 40,
                    semanticRowsFound: 3,
                    lightShardsCreated: 0,
                    deepChunksCreated: 0,
                    failures: 0,
                    skipReasons: { no_semantic_rows: 1 },
                },
            }),
        });

        const screen = await renderSettledMemorySettingsView();

        expect(screen.findByProps({ title: 'memorySearchSettings.indexContents.title' })).toBeTruthy();
        expect(screen.findByProps({ title: 'memorySearchSettings.queue.title' })).toBeTruthy();
        expect(screen.findByProps({ title: 'memorySearchSettings.lastRun.title' })).toBeTruthy();
        expect(screen.findByProps({ title: 'memorySearchSettings.status.title' }).props?.subtitle)
            .toBe('memorySearchSettings.status.indexing');
    });

    it('writes coverage policy changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'hints',
                coveragePolicy: { type: 'latest_messages', maxSemanticMessagesPerSession: 250 },
            }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        expect(findSegmentedChoice(screen, 'since_enabled')).toBeTruthy();
        await chooseSegment(screen, 'full');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.coveragePolicy).toEqual({ type: 'full' });
    });

    it('writes content policy toggle changes via daemon.memory.settings.set without exposing raw tool outputs', async () => {
        installMemoryRpc({
            settingsGet: () => ({
                v: 1,
                enabled: true,
                indexMode: 'hints',
                contentPolicy: {
                    includeUserMessages: true,
                    includeAssistantMessages: true,
                    includeReasoning: false,
                    includeToolSummaries: false,
                    includeToolOutputs: false,
                },
            }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        const reasoningItem = screen.findAllByType(Item).find(node => node.props.testID === 'memory-settings-content-reasoning-item');
        expect(reasoningItem).toBeTruthy();
        const toggle = reasoningItem?.props?.rightElement;
        expect(toggle?.props?.testID).toBe('memory-settings-content-reasoning');

        await act(async () => {
            toggle.props.onValueChange?.(true);
        });

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.contentPolicy?.includeReasoning).toBe(true);
        expect(screen.findAllByTestId('memory-settings-content-tool-outputs-item')).toHaveLength(0);
    });

    it('writes budgets.maxDiskMbLight changes via daemon.memory.settings.set', async () => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', budgets: { maxDiskMbLight: 250 } }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await typeIntoFieldRow(screen, 'memory-settings-budget-light', '123');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.budgets?.maxDiskMbLight).toBe(123);
    });
    it.each([false, true])('keeps hints opt-in %s when selecting keyword mode', async (hintsEnabled) => {
        installMemoryRpc({
            settingsGet: () => ({ v: 1, enabled: true, indexMode: 'hints', hints: { enabled: hintsEnabled } }),
            settingsSet: (params: any) => params.payload,
        });

        const screen = await renderSettledMemorySettingsView();
        await chooseSegment(screen, 'deep');

        const call = machineRpcSpy.mock.calls.find((c) => c?.[0]?.method === 'daemon.memory.settings.set');
        expect(call?.[0]?.payload?.indexMode).toBe('deep');
        expect(call?.[0]?.payload?.hints?.enabled).toBe(hintsEnabled);
    });

    it('asks for a machine instead of showing machine settings when none is selected', async () => {
        administrationTargetState.current = null;
        installMemoryRpc({});

        const screen = await renderSettledMemorySettingsView();
        const enabledItem = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(enabledItem.props?.subtitle).toBe('memorySearchSettings.enabled.chooseMachine');
        expect(enabledItem.props?.rightElement ?? null).toBeNull();
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });

    it('says the machine cannot be reached, with a retry, instead of showing defaults as its settings', async () => {
        let reachable = false;
        installMemoryRpc({
            settingsGet: () => {
                if (!reachable) throw new Error('machine offline');
                return { v: 1, enabled: true, indexMode: 'hints' };
            },
            status: () => createReadyMemoryStatus(),
        });

        const screen = await renderSettledMemorySettingsView();
        const enabledItem = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(enabledItem.props?.subtitle).toBe('memorySearchSettings.enabled.unreachable');
        expect(findSegmentedChoice(screen, 'deep')).toBeUndefined();

        reachable = true;
        await act(async () => {
            await enabledItem.props.rightElement.props.onPress();
        });
        await flushHookEffects({ cycles: 1 });

        expect(findSegmentedChoice(screen, 'deep')).toBeTruthy();
        expect(screen.findByProps({ title: 'memorySearchSettings.enabled.title' }).props?.rightElement?.props?.value).toBe(true);
    });

    it('keeps the machine settings read-only until the read for the current machine settles', async () => {
        let resolveRead: (value: unknown) => void = () => {};
        installMemoryRpc({
            settingsGet: () => new Promise((resolve) => { resolveRead = resolve; }),
            settingsSet: (params: any) => params.payload,
            status: () => createReadyMemoryStatus(),
        });

        const screen = await renderSettledMemorySettingsView();
        // While the read is in flight the row's switch holds its place (no jump when the value arrives)
        // but is disabled and cannot write defaults over the machine.
        const pending = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(pending.props?.rightElement?.props?.disabled).toBe(true);
        expect(pending.props?.rightElement?.props?.onValueChange).toBeFalsy();
        // It still says what it does.
        expect(pending.props?.subtitle).toBe('memorySearchSettings.enabled.subtitle');
        expect(pending.props?.loading).toBeFalsy();
        // The rows whose values are not known yet wait with the same spinner; none claims "unavailable".
        // Each reserves its value line (a blank one), so the sheet does not grow when the values arrive.
        for (const title of ['memorySearchSettings.status.title', 'memorySearchSettings.status.diskUsageTitle']) {
            const row = screen.findByProps({ title });
            expect(row.props?.loading).toBe(true);
            expect(String(row.props?.subtitle).trim()).toBe('');
            expect(row.props?.subtitle).toBeTruthy();
        }
        expect(findSegmentedChoice(screen, 'deep')).toBeUndefined();
        expect(screen.findAllByTestId('memory-settings-budget-light')).toHaveLength(0);

        await act(async () => {
            resolveRead({ v: 1, enabled: true, indexMode: 'hints' });
        });
        await flushHookEffects({ cycles: 1 });

        const settled = screen.findByProps({ title: 'memorySearchSettings.enabled.title' });
        expect(settled.props?.rightElement?.props?.value).toBe(true);
        expect(findSegmentedChoice(screen, 'deep')).toBeTruthy();
        expect(machineRpcSpy.mock.calls.some((c) => c?.[0]?.method === 'daemon.memory.settings.set')).toBe(false);
    });

    it('leads to Features when memory search is turned off', async () => {
        featureState.memorySearchEnabled = false;

        const screen = await renderSettledMemorySettingsView();
        const openFeatures = screen.findByTestId('memory-settings-open-features');
        expect(openFeatures).toBeTruthy();
        await act(async () => {
            await openFeatures!.props.onPress?.();
        });

        expect(routerState.push?.mock.calls).toContainEqual(['/settings/features']);
        expect(machineRpcSpy).not.toHaveBeenCalled();
    });
});
