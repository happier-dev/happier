import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySettingsV1Schema, type MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { SEARCH_SETTINGS } from './searchSettings';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const account = createProviderSettingsAccountHarness();
const homes = account.home;
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
await loadSyncSingletonForTests();
const [
    { TokenStorage }, { storage }, { settingsDefaults },
    { publishMachineContributionRegistryProjectionInvalidation },
    { clearDaemonMergedProjectionCacheForTests },
    { resolveFreshMachineAdministrationExecutionTarget },
] = await Promise.all([
    import('@/auth/storage/tokenStorage'), import('@/sync/domains/state/storageStore'), import('@/sync/domains/settings/settings'),
    import('@/sync/ops/machineContributionRegistryProjection'),
    import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
    import('@/sync/domains/machines/administration/useTargetSelection'),
]);
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
// Search settings never renders the vendor's DOM streaming renderer.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected Markdown reveal in Search settings'); },
}));

beforeEach(async () => {
    routeParams.value = {};
    await account.reset();
    const machines = ['m1', 'm2'].map((id) => createMachineFixture({ id, activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, displayName: id === 'm1' ? 'Studio' : 'Laptop',
    } }));
    ({ serverId } = await account.restore({
        serverIdentityId, accountId: 'search-account', currentAccount: true, machines,
        settings: { ...settingsDefaults, experiments: true, featureToggles: { 'memory.search': true } },
    }));
    await account.selectMachine(serverId, 'm1', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory);
    clearDaemonMergedProjectionCacheForTests();
    expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: 'm1' })).not.toBeNull();
    // Cleanup restores the canonical modal mock between cases. Rebind its
    // external confirmation handler without replacing any UI owner.
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.confirm).mockImplementation((...args) => modalConfirm(...args));
    // Flush UI delays without advancing wall-clock Machine presence past its grace.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
    standardCleanup();
    machineRpcSpy.mockReset();
    modalConfirm.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await account.reset();
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
    projectionFailure?: 'error' | 'unsupported';
    clearFailure?: 'throw' | 'refused';
}> = {}) {
    const daemons: Record<string, Daemon> = {
        m1: { settings: MemorySettingsV1Schema.parse({ v: 1, ...initial }), cleared: 0, statusReads: 0 },
        m2: { settings: MemorySettingsV1Schema.parse({ v: 1, ...options.second }), cleared: 0, statusReads: 0 },
    };
    machineRpcSpy.mockImplementation(async (params: RpcRequest) => {
        if (options.unreachable) throw new Error('unreachable');
        const daemon = daemons[params.machineId];
        if (!daemon || (params.serverId !== serverId && params.serverId !== serverIdentityId)) throw new Error('unexpected target');
        if (params.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) {
            if (params.machineId === 'm1') await options.readFirstAfter;
            return daemon.settings;
        }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_SET) {
            daemon.settings = MemorySettingsV1Schema.parse(params.payload);
            return daemon.settings;
        }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_STATUS) { daemon.statusReads += 1; return null; }
        if (params.method === RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX) {
            if (options.clearFailure === 'throw') throw new Error('clear failed');
            if (options.clearFailure === 'refused') return { ok: false, errorCode: 'memory_clear_index_failed' };
            daemon.cleared += 1;
            return { ok: true };
        }
        if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            await options.readProjectionAfter;
            if (options.projectionFailure === 'unsupported') return { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
            if (options.projectionFailure === 'error') throw new Error('projection failed');
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
    await vi.waitFor(async () => {
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId(testID)).not.toBeNull();
    });
    const control = screen.findHostByTestId(testID);
    expect(control).not.toBeNull();
    return control!;
}

async function toggle(screen: SearchSettingsScreen, testID: string) {
    const control = await renderedControl(screen, testID);
    await act(async () => control.props.onValueChange(!control.props.value));
    await flushHookEffects({ runOnlyPendingTimers: true });
}

function installActionSettings(actionsSettingsV1: unknown = { v: 1 }) {
    homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: { actionsSettingsV1 } } } });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    storage.setState((state) => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse(actionsSettingsV1) } }));
}

async function startClear(screen: SearchSettingsScreen) {
    await enabledClearControl(screen);
    await screen.pressByTestIdAsync('search-settings-clear-index');
}

async function settledClear(screen: SearchSettingsScreen) {
    await vi.waitFor(async () => {
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('search-settings-clear-approval')).toBeNull();
        expect(screen.findHostByTestId('search-settings-clear-index')?.props.accessibilityState?.busy).toBe(false);
    });
}

async function enabledClearControl(screen: SearchSettingsScreen) {
    await vi.waitFor(async () => {
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('search-settings-clear-index')?.props.disabled).toBe(false);
    });
    return screen.findHostByTestId('search-settings-clear-index')!;
}

async function pendingClearApproval() {
    await vi.waitFor(async () => {
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(homes.artifacts(serverId).list()).toHaveLength(1);
    });
    const artifactId = homes.artifacts(serverId).list()[0]!.id;
    const request = StoredApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId)!));
    expect(request).toMatchObject({ status: 'open', actionId: 'memory.clear_index', actionArgs: { machineId: 'm1' },
        executionOriginV1: { serverId: serverIdentityId, accountId: 'search-account', surface: 'ui' } });
    return artifactId;
}

async function decideClear(artifactId: string, decision: 'approve' | 'reject') {
    const { createDefaultActionExecutor, isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { approvalArtifactBodyMatchesHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const { writeApprovalRequestArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { clearDaemonMemoryIndex } = await import('@/sync/domains/memory/clearDaemonMemoryIndex');
    // Explicit Ask-first Machine effects replay at their exact daemon. Model that
    // HTTP boundary with the real executor, strict envelopes and Artifact CAS.
    homes.answer(serverId, '/v1/machines', { body: ['m1', 'm2'].map(id =>
        createPlainMachineRowFixture({ id, accountId: 'search-account' })) });
    const captured = await captureLazyActionAccountContext(serverId);
    const read = (id: string) => captured.fetchArtifact(id);
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
        approvalsGet: async ({ artifactId }) => {
            const artifact = await read(artifactId);
            const matched = artifact?.header && typeof artifact.body === 'string'
                ? approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body) : null;
            return matched?.family === 'built_in' ? matched.request : null;
        },
        approvalsUpdate: ({ artifactId, request }) => writeApprovalRequestArtifact({ artifactId, request, read,
            write: (basis, header, body) => captured.updateArtifact(artifactId, header, body, basis) }),
        isApprovalExecutionOriginCurrent: async ({ origin }) => isApprovalExecutionOriginCurrentForAccountContext({
            origin, accountServerId: captured.serverId, accountId: captured.accountId,
        }),
        daemonMemoryClearIndex: async ({ machineId, signal }) => {
            await clearDaemonMemoryIndex({ machineId, serverId: serverIdentityId, accountId: captured.accountId, signal });
            return { ok: true };
        },
    }));
    homes.answer(serverId, 'POST /v1/actions/approval.request.decide', { select: async input => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        expect(envelope.target).toEqual({ kind: 'machine', machineId: 'm1' });
        const execution = await receiver.execute('approval.request.decide', envelope.input, {
            surface: 'ui', authority: 'present_user', serverId: serverIdentityId, serverIdentityId,
            runtimeAccountId: captured.accountId, actionRequestId: envelope.requestId,
        });
        return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
            requestId: envelope.requestId, execution }) };
    } });
    let result: unknown;
    try {
        await act(async () => { result = await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision },
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'search-account' }); });
    } finally { captured.dispose(); }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await flushHookEffects({ runOnlyPendingTimers: true });
}

describe('SearchSettingsView', () => {
    it.each(['parked', 'remounted'] as const)('reads the selected machine again after navigating away and returning to Search (%s)', lifecycle => withPopoverWebGlobals(async () => {
        const daemons = installDaemons({ enabled: true, indexMode: 'deep' });
        const { SearchSettingsView } = await import('./SearchSettingsView');
        const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
        const page = (visible: boolean) => React.createElement(React.Fragment, null,
            !visible && lifecycle === 'remounted' ? null
                : React.createElement(RetainedPanelSurface, { isActive: visible, suspendWhenHidden: true,
                    children: React.createElement(SearchSettingsView) }));
        const screen = await renderScreen(page(true), { flushOptions: { runOnlyPendingTimers: true } });
        await renderedControl(screen, 'search-settings-standard');
        await screen.update(page(false));
        // A Home refresh/presence update may settle while this tab is parked.
        await act(async () => { storage.setState(state => ({
            machines: Object.fromEntries(Object.values(state.machines).map(machine => [machine.id, { ...machine }])),
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverIdentityId]: 'loading' },
        })); });
        await screen.update(page(true));
        await screen.pressByTestIdAsync('search-settings-target.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        await screen.pressByTestIdAsync('search-settings-target.picker-option:m1');
        expect((await renderedControl(screen, 'search-settings-standard')).props.value).toBe(true);
        await enabledClearControl(screen);
        await toggle(screen, 'search-settings-standard');
        expect(daemons.m1.settings.conversationSearch.standardSearch.enabled).toBe(false);
        expect(daemons.m2.settings.conversationSearch.standardSearch.enabled).toBe(true);
    }));

    it('reads the selected online machine while its scoped inventory refreshes and exposes the search controls', () => withPopoverWebGlobals(async () => {
        const daemons = installDaemons({ enabled: true, indexMode: 'deep' });
        await account.selectMachine(serverId, null, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory);
        // A refresh retains the admitted Home rows while socket presence has
        // already replaced the active display objects for those same machines.
        storage.setState((state) => ({
            machines: Object.fromEntries(Object.values(state.machines).map(machine => [machine.id, { ...machine }])),
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverIdentityId]: 'loading' },
        }));
        const screen = await renderSearchSettings();
        expect(screen.findHostByTestId('search-settings-standard')).toBeNull();

        await screen.pressByTestIdAsync('search-settings-target.chip');
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        const option = screen.findHostByTestId('search-settings-target.picker-option:m1');
        expect(option).not.toBeNull();
        expect(option!.props.disabled ?? option!.props.accessibilityState?.disabled ?? option!.props['aria-disabled']).not.toBe(true);
        await screen.pressByTestIdAsync('search-settings-target.picker-option:m1');
        expect(storage.getState().settings.machineAdministrationTargetsLocalV1[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory])
            .toEqual({ serverIdentityId, machineId: 'm1' });
        expect((await renderedControl(screen, 'search-settings-standard')).props.value).toBe(true);
        await enabledClearControl(screen);
        expect(machineRpcSpy.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET)
            .map(([request]) => request)).toContainEqual(expect.objectContaining({ machineId: 'm1', serverId }));
        await toggle(screen, 'search-settings-standard');
        expect(daemons.m1.settings.conversationSearch.standardSearch.enabled).toBe(false);
        expect(daemons.m2.settings.conversationSearch.standardSearch.enabled).toBe(true);
    }));

    it.each(['error', 'unsupported'] as const)('ends loading after a terminal %s Agent projection and offers recovery', async (projectionFailure) => {
        const held = createDeferred<void>();
        const options: { readProjectionAfter: PromiseLike<void>; projectionFailure?: 'error' | 'unsupported' } = { readProjectionAfter: held.promise, projectionFailure };
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true } } }, options);
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-agents-loading');
        await act(async () => held.resolve());
        await renderedControl(screen, `search-settings-agents-${projectionFailure}`);
        expect(screen.findHostByTestId('search-settings-agents-loading')).toBeNull();
        expect(screen.findHostByTestId('search-settings-agents-empty')).toBeNull();
        if (projectionFailure === 'error') {
            options.projectionFailure = undefined;
            await screen.pressByTestIdAsync('search-settings-agents-retry');
            await renderedControl(screen, 'search-settings-agent:acme.archive');
            expect(screen.findHostByTestId('search-settings-agents-error')).toBeNull();
        } else expect(screen.getTextContent()).toContain('conversationSearch.updateRequired');
    });

    it('keeps the machine chooser in the page under phone title chrome, where the page says which machine it needs', async () => {
        installDaemons({});
        const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');
        const { SearchSettingsView } = await import('./SearchSettingsView');
        const screen = await renderScreen(
            React.createElement(NavigationTitleChromeProvider, { showsTitle: true, children: React.createElement(SearchSettingsView) }),
            { flushOptions: { runOnlyPendingTimers: true } },
        );
        await renderedControl(screen, 'search-settings-target.chip');
    });

    it('keeps same-scope Agent labels when a refresh fails and still offers retry', async () => {
        const options: { projectionFailure?: 'error' } = {};
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true } } }, options);
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-agent:acme.archive');
        options.projectionFailure = 'error';
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: 'm1', serverId }, 'authority'));
        await renderedControl(screen, 'search-settings-agents-error');
        expect(screen.findHostByTestId('search-settings-agent:acme.archive')).not.toBeNull();
        expect(screen.findHostByTestId('search-settings-agents-retry')).not.toBeNull();
    });
    it('shows a loading state, not an Agent row, until the machine projection arrives', async () => {
        const held = createDeferred<void>();
        // A stored choice is not yet known to be retired: until the machine answers it is not drawn as a bare id.
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: ['retired-agent'] } } }, { readProjectionAfter: held.promise });
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-index-external');
        expect(screen.findHostByTestId('search-settings-agents-loading')).not.toBeNull();
        expect(screen.findHostByTestId('search-settings-agents-empty')).toBeNull();
        expect(screen.findHostByTestId('search-settings-agent:acme.archive')).toBeNull();
        expect(screen.findHostByTestId('search-settings-agent:retired-agent')).toBeNull();
        await act(async () => { held.resolve(); });
        await renderedControl(screen, 'search-settings-agent:acme.archive');
        expect(screen.findHostByTestId('search-settings-agent:retired-agent')).not.toBeNull();
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

    it('says nothing is indexed while every Agent is off, and goes back to the usual line once one is on', async () => {
        installDaemons({ enabled: true, conversationSearch: { indexExternal: { enabled: true, agents: [] } } });
        const screen = await renderSearchSettings();
        await renderedControl(screen, 'search-settings-agent:acme.archive');
        expect(screen.getTextContent()).toContain('conversationSearch.agentsNoneOn');
        expect(screen.getTextContent()).not.toContain('conversationSearch.agentsDescription');
        await toggle(screen, 'search-settings-agent:acme.archive');
        expect(screen.getTextContent()).toContain('conversationSearch.agentsDescription');
        expect(screen.getTextContent()).not.toContain('conversationSearch.agentsNoneOn');
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

    it.each([false, true])('uses canonical approval before clearing (explicit requirement: %s)', async (explicit) => {
        const daemons = installDaemons({ enabled: true });
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockReturnValue(confirmation.promise);
        installActionSettings(explicit ? { v: 1, approvalWaivedSurfaces: { 'memory.clear_index': ['ui'] },
            actions: { 'memory.clear_index': { approvalRequiredSurfaces: ['ui'] } } } : { v: 1 });
        const screen = await renderSearchSettings();
        await startClear(screen);
        const artifactId = explicit ? await pendingClearApproval() : null;
        if (!explicit) await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledTimes(1));
        expect(daemons.m1.cleared).toBe(0);
        if (explicit) {
            expect(screen.findHostByTestId('search-settings-clear-approval')).not.toBeNull();
            expect(modalConfirm).not.toHaveBeenCalled();
        } else expect(homes.artifacts(serverId).list()).toEqual([]);
        const readsBefore = daemons.m1.statusReads;
        // Changing the page's selected machine cannot retarget admitted custody.
        await act(async () => storage.setState((state) => ({ settings: { ...state.settings,
            machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.memory]: { serverIdentityId, machineId: 'm2' } },
        } })));
        await flushHookEffects({ runOnlyPendingTimers: true });
        if (artifactId) await decideClear(artifactId, 'approve');
        else await act(async () => confirmation.resolve(true));
        await settledClear(screen);
        expect(daemons.m1.cleared).toBe(1);
        expect(daemons.m1.statusReads).toBe(readsBefore + 1);
        expect(daemons.m2.cleared).toBe(0);
        expect(machineRpcSpy.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX)
            .map(([request]) => request)).toEqual([expect.objectContaining({
                machineId: 'm1', serverId: serverIdentityId, accountId: 'search-account', preferScoped: true,
            })]);
    });

    it('honours a UI approval waiver and refreshes status without a private confirmation', async () => {
        const daemons = installDaemons({ enabled: true });
        installActionSettings({ v: 1, approvalWaivedSurfaces: { 'memory.clear_index': ['ui'] } });
        const screen = await renderSearchSettings();
        await enabledClearControl(screen);
        const readsBefore = daemons.m1.statusReads;
        await screen.pressByTestIdAsync('search-settings-clear-index');
        await settledClear(screen);
        expect(daemons.m1.cleared).toBe(1);
        expect(daemons.m1.statusReads).toBe(readsBefore + 1);
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it('explains why the Account Action policy refused to clear the index', async () => {
        const daemons = installDaemons({ enabled: true });
        installActionSettings({ v: 1, actions: { 'memory.clear_index': { enabled: false } } });
        const screen = await renderSearchSettings();
        const { Modal } = await import('@/modal');
        await enabledClearControl(screen);
        const readsBefore = daemons.m1.statusReads;
        await screen.pressByTestIdAsync('search-settings-clear-index');
        await settledClear(screen);
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'actionConfirmations.turnedOffUnnamedMessage');
        expect(daemons.m1.cleared).toBe(0);
        expect(daemons.m1.statusReads).toBe(readsBefore);
    });

    it('does not clear or refresh after canonical approval is rejected', async () => {
        const daemons = installDaemons({ enabled: true });
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockReturnValue(confirmation.promise);
        installActionSettings();
        const screen = await renderSearchSettings();
        await startClear(screen);
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledTimes(1));
        const readsBefore = daemons.m1.statusReads;
        await act(async () => confirmation.resolve(false));
        await settledClear(screen);
        expect(daemons.m1.cleared).toBe(0);
        expect(daemons.m1.statusReads).toBe(readsBefore);
        expect(homes.artifacts(serverId).list()).toEqual([]);
    });

    it.each(['throw', 'refused'] as const)('keeps %s clear failure presentation without refreshing an unacknowledged clear', async (clearFailure) => {
        const daemons = installDaemons({ enabled: true }, { clearFailure });
        installActionSettings({ v: 1, approvalWaivedSurfaces: { 'memory.clear_index': ['ui'] } });
        const screen = await renderSearchSettings();
        await enabledClearControl(screen);
        const readsBefore = daemons.m1.statusReads;
        const { Modal } = await import('@/modal');
        await screen.pressByTestIdAsync('search-settings-clear-index');
        await settledClear(screen);
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'conversationSearch.clearFailed');
        expect(daemons.m1.cleared).toBe(0);
        expect(daemons.m1.statusReads).toBe(readsBefore);
    });

    it('withdraws the original clear continuation when its Account retires during approval', async () => {
        const daemons = installDaemons({ enabled: true });
        const confirmation = createDeferred<boolean>();
        modalConfirm.mockReturnValue(confirmation.promise);
        installActionSettings();
        const screen = await renderSearchSettings();
        await startClear(screen);
        await vi.waitFor(() => expect(modalConfirm).toHaveBeenCalledTimes(1));
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        await act(async () => { await TokenStorage.removeCredentialsForServerUrl(getServerProfileById(serverId)!.serverUrl, { serverId }); });
        await act(async () => confirmation.resolve(true));
        await vi.waitFor(async () => {
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(screen.findHostByTestId('search-settings-clear-approval')).toBeNull();
        });
        expect(daemons.m1.cleared).toBe(0);
        expect(daemons.m2.cleared).toBe(0);
        expect(screen.findHostByTestId('search-settings-clear-approval')).toBeNull();
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

    it('keeps the first row describing itself, with its switch in place but disabled, while the machine is still answering', async () => {
        const pending = createDeferred<void>();
        installDaemons({ enabled: true }, { readFirstAfter: pending.promise });
        const screen = await renderSearchSettings();
        const row = screen.findByProps({ testID: 'search-settings-standard-item', title: SEARCH_SETTINGS.settings.standardSearch.titleKey });
        // The setting keeps saying what it does, and its switch holds its place so the row does not jump once
        // the value arrives. Until then it is disabled and cannot write defaults over the machine.
        expect(row.props.subtitle).toBe(SEARCH_SETTINGS.settings.standardSearch.descriptionKey);
        expect(row.props.loading).toBeFalsy();
        expect(screen.findHostByTestId('search-settings-standard')).toBeNull();
        const placeholder = screen.findHostByTestId('search-settings-standard-pending');
        expect(placeholder).not.toBeNull();
        expect(placeholder!.props.disabled).toBe(true);
        expect(placeholder!.props.onValueChange).toBeFalsy();
        await act(async () => pending.resolve());
        await flushHookEffects();
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
