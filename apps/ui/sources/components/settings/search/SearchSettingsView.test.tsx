import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySettingsV1Schema, type MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { createDeferred, createMachineFixture, flushHookEffects, PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { SEARCH_SETTINGS } from './searchSettings';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const homes = createHomeGovernanceHarness();
const serverIdentityId = 'srv_search_settings';
let serverId: string;

// Only process-external boundaries are replaced; the store, target selection,
// feature decision, daemon projector and rendered app controls stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalConfirm } }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routeParams.value }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpcSpy }));

beforeEach(async () => {
    routeParams.value = {};
    await homes.reset();
    serverId = await homes.addHome({ serverUrl: 'https://search-settings.example.test', serverIdentityId, name: 'Search Home', accountId: 'search-account' });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => {
        const token = homes.findByServerUrl(url)?.token;
        return token ? { token } : null;
    });
    const machines = ['m1', 'm2'].map((id) => createMachineFixture({ id, activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, displayName: id === 'm1' ? 'Studio' : 'Laptop',
    } }));
    const scope = { serverId, accountId: 'search-account' };
    storage.setState((state) => ({
        isDataReady: true,
        profile: { ...state.profile, id: scope.accountId },
        profileScope: scope,
        settingsScope: scope,
        machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
        machineListByServerId: { [serverId]: machines },
        machineListStatusByServerId: { [serverId]: 'idle' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { 'memory.search': true },
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory]: { serverIdentityId, machineId: 'm1' } },
        },
    }));
    clearDaemonMergedProjectionCacheForTests();
    expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: 'm1' })).not.toBeNull();
    // Cleanup restores the canonical modal mock between cases. Rebind its
    // external confirmation handler without replacing any UI owner.
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockImplementation((...args) => modalConfirm(...args));
    vi.useFakeTimers();
});

afterEach(async () => {
    standardCleanup();
    machineRpcSpy.mockReset();
    modalConfirm.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await homes.reset();
});

type RpcRequest = Readonly<{ machineId: string; serverId: string; method: string; payload: unknown }>;
type Daemon = { settings: MemorySettingsV1; cleared: number; statusReads: number };

const projection = PluginProjectionV2Schema.parse({
    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    agentsById: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById,
        'acme.archive': {
            id: 'acme.archive', identity: { pluginId: 'acme.review', localId: 'archive' }, title: 'Archive Agent',
            externalSessions: {
                agent: { pluginId: 'acme.review', localId: 'archive' }, generation: 7,
                operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                sources: [{ sourceKind: 'archive', schema: { fields: [{ name: 'kind', kind: 'literal', value: 'archive' }] },
                    key: { segments: [{ kind: 'literal', value: 'archive' }] }, instances: [{ kind: 'default', constants: {} }] }],
            },
        },
    },
});

/** The transport boundary holds separate settings documents for each real target. */
function installDaemons(initial: Record<string, unknown>, options: Readonly<{
    unreachable?: boolean;
    second?: Record<string, unknown>;
    readFirstAfter?: PromiseLike<void>;
    readProjectionAfter?: PromiseLike<void>;
}> = {}) {
    const daemons: Record<string, Daemon> = {
        m1: { settings: MemorySettingsV1Schema.parse({ v: 1, ...initial }), cleared: 0, statusReads: 0 },
        m2: { settings: MemorySettingsV1Schema.parse({ v: 1, ...options.second }), cleared: 0, statusReads: 0 },
    };
    machineRpcSpy.mockImplementation(async (params: RpcRequest) => {
        if (options.unreachable) throw new Error('unreachable');
        const daemon = daemons[params.machineId];
        if (!daemon || params.serverId !== serverId) throw new Error('unexpected target');
        if (params.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) {
            if (params.machineId === 'm1') await options.readFirstAfter;
            return daemon.settings;
        }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET) {
            daemon.settings = MemorySettingsV1Schema.parse(params.payload);
            return daemon.settings;
        }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) { daemon.statusReads += 1; return null; }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX) { daemon.cleared += 1; return { ok: true }; }
        if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            await options.readProjectionAfter;
            return { protocolVersion: 1, projection };
        }
        throw new Error(`unexpected rpc ${params.method}`);
    });
    return daemons;
}

async function renderSearchSettings() {
    const { SearchSettingsView } = await import('./SearchSettingsView');
    return renderScreen(React.createElement(SearchSettingsView), { flushOptions: { runOnlyPendingTimers: true } });
}
type SearchSettingsScreen = Awaited<ReturnType<typeof renderSearchSettings>>;

async function renderedControl(screen: SearchSettingsScreen, testID: string) {
    await flushHookEffects({ runOnlyPendingTimers: true });
    const control = screen.findHostByTestId(testID);
    expect(control).not.toBeNull();
    return control!;
}

async function toggle(screen: SearchSettingsScreen, testID: string) {
    const control = await renderedControl(screen, testID);
    await act(async () => control.props.onValueChange(!control.props.value));
    await flushHookEffects({ runOnlyPendingTimers: true });
}

describe('SearchSettingsView', () => {
    it('shows a loading state, not an Agent row, until the machine projection arrives', async () => {
        const held = createDeferred<void>();
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true } } }, { readProjectionAfter: held.promise });
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-index-external');
        expect(screen.findHostByTestId('search-settings-agents-loading')).not.toBeNull();
        expect(screen.findHostByTestId('search-settings-agents-empty')).toBeNull();
        expect(screen.findHostByTestId('search-settings-agent:claude')).toBeNull();
        await act(async () => { held.resolve(); });
        await renderedControl(screen, 'search-settings-agent:claude');
        expect(screen.findHostByTestId('search-settings-agents-loading')).toBeNull();
    });
    it('lands a settings search on the Agents controls once indexing is available', async () => {
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
        routeParams.value = { setting: SEARCH_SETTINGS.settings.agents.anchor };
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-agent:claude');
        expect(screen.findHostByTestId(`setting-reveal.${SEARCH_SETTINGS.settings.agents.anchor}`)).not.toBeNull();
        expect(screen.findHostByTestId(`setting-reveal.${SEARCH_SETTINGS.sectionRefs.external.id}`)).toBeNull();
    });

    it('reveals the indexing prerequisite when settings search requests unavailable Agent controls', async () => {
        installDaemons({ enabled: true });
        routeParams.value = { setting: SEARCH_SETTINGS.settings.agents.anchor };
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-index-external');
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.findHostByTestId(`setting-reveal.${SEARCH_SETTINGS.sectionRefs.external.id}`)).not.toBeNull();
        expect(screen.findHostByTestId(`setting-reveal.${SEARCH_SETTINGS.settings.agents.anchor}`)).toBeNull();
    });

    it('turns on-demand search off on the machine without touching its other memory settings', async () => {
        const daemons = installDaemons({ enabled: true, indexMode: 'deep' });
        const screen = await renderSearchSettings();
        expect((await renderedControl(screen, 'search-settings-standard')).props.value).toBe(true);
        await toggle(screen, 'search-settings-standard');
        expect(daemons.m1.settings).toMatchObject({ enabled: true, indexMode: 'deep', conversationSearch: { standardSearch: { enabled: false }, indexExternal: { enabled: false } } });
        expect(screen.findHostByTestId('search-settings-standard')!.props.value).toBe(false);
    });

    it('keeps indexing unavailable while memory search is off without rewriting the stored choice', async () => {
        const daemons = installDaemons({ enabled: false, conversationSearch: { indexExternal: { enabled: true, agents: ['claude'] } } });
        const screen = await renderSearchSettings();
        const control = await renderedControl(screen, 'search-settings-index-external');
        expect(control.props).toMatchObject({ disabled: true, value: false });
        expect(screen.getTextContent()).toContain('conversationSearch.externalNeedsMemory');
        expect(screen.findHostByTestId('search-settings-agent:claude')).toBeNull();
        expect(screen.findHostByTestId('search-settings-clear-index')).toBeNull();
        expect(daemons.m1.settings.conversationSearch.indexExternal.enabled).toBe(true);
    });

    it('saves the chosen Agents, history window and tool output through rendered controls', async () => {
        const daemons = installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: ['claude', 'codex'], historyDays: 14 } } });
        const screen = await renderSearchSettings();
        await toggle(screen, 'search-settings-agent:codex');
        await toggle(screen, 'search-settings-tool-output');
        expect(screen.findHostByTestId('search-settings-history:14')!.props.accessibilityState.checked).toBe(true);
        await screen.pressByTestIdAsync('search-settings-history:all');
        await flushHookEffects();
        expect(daemons.m1.settings.conversationSearch.indexExternal).toEqual({ enabled: true, agents: ['claude'], historyDays: null, includeToolOutput: true });
        expect(screen.findHostByTestId('search-settings-history:all')!.props.accessibilityState.checked).toBe(true);
        expect(machineRpcSpy.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true);
    });

    it('clears the index only after confirmation and refreshes the machine status', async () => {
        const daemons = installDaemons({ enabled: true });
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-clear-index');
        modalConfirm.mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('search-settings-clear-index');
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(modalConfirm).toHaveBeenCalled();
        expect(daemons.m1.cleared).toBe(0);
        const readsBefore = daemons.m1.statusReads;
        modalConfirm.mockResolvedValueOnce(true);
        await screen.pressByTestIdAsync('search-settings-clear-index');
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(daemons.m1.cleared).toBe(1);
        expect(daemons.m1.statusReads).toBe(readsBefore + 1);
        expect(modalConfirm.mock.calls[1]?.[2]).toMatchObject({ destructive: true });
    });

    it('offers only daemon-declared Agents with browsable conversations alongside stored choices', async () => {
        const daemons = installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: ['retired-agent'] } } });
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-agent:acme.archive');
        expect(screen.findHostByTestId('search-settings-agent:acme.review.provider')).toBeNull();
        expect(screen.findHostByTestId('search-settings-agent:retired-agent')).not.toBeNull();
        await toggle(screen, 'search-settings-agent:acme.archive');
        await toggle(screen, 'search-settings-agent:retired-agent');
        expect(daemons.m1.settings.conversationSearch.indexExternal.agents).toEqual(['acme.archive']);
    });

    it('offers retry when the machine cannot be reached', async () => {
        installDaemons({}, { unreachable: true });
        const screen = await renderSearchSettings();
        expect(screen.getTextContent()).toContain('conversationSearch.unreachable');
        expect(screen.findHostByTestId('search-settings-retry')).not.toBeNull();
        expect(screen.findHostByTestId('search-settings-index-external')).toBeNull();
    });

    it('respects the real memory-search feature decision while leaving standard search available', async () => {
        installDaemons({ enabled: true });
        storage.setState((state) => ({ settings: { ...state.settings, featureToggles: { 'memory.search': false } } }));
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-standard');
        expect(screen.findHostByTestId('search-settings-index-external')).toBeNull();
        expect(screen.findHostByTestId('search-settings-clear-index')).toBeNull();
    });

    it('keeps a late previous-machine read from replacing or writing the newly selected machine settings', async () => {
        const pending = createDeferred<void>();
        const daemons = installDaemons({ enabled: true, indexMode: 'deep' }, { readFirstAfter: pending.promise, second: { enabled: false, indexMode: 'hints', conversationSearch: { standardSearch: { enabled: false } } } });
        const screen = await renderSearchSettings();
        expect(screen.findHostByTestId('search-settings-standard')).toBeNull();
        await act(async () => storage.setState((state) => ({ settings: { ...state.settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory]: { serverIdentityId, machineId: 'm2' } },
        } })));
        await flushHookEffects();
        expect((await renderedControl(screen, 'search-settings-standard')).props.value).toBe(false);
        await act(async () => pending.resolve());
        await flushHookEffects();
        expect(screen.findHostByTestId('search-settings-standard')!.props.value).toBe(false);
        await toggle(screen, 'search-settings-standard');
        expect(daemons.m2.settings).toMatchObject({ enabled: false, indexMode: 'hints', conversationSearch: { standardSearch: { enabled: true } } });
        expect(daemons.m1.settings).toMatchObject({ enabled: true, indexMode: 'deep' });
    });
});
