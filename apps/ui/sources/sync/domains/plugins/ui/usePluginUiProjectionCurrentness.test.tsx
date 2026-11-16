import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AccountPetListResponseV1Schema} from '@happier-dev/protocol/pets/accountLibrary';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { AutomationDefinitionListResponseSchema} from '@happier-dev/protocol/automations/automationApiV3';
import { CurrentCursorResponseSchema} from '@happier-dev/protocol/changes';
import { DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { buildDeferredDaemonProjectionSections } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readConnectedAccountPurposeSetupDeclaration } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { RpcError } from '@/sync/runtime/rpcErrors';

import { createDeferred } from '@/dev/testkit';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

const projectionRuntime = vi.hoisted(() => ({
    describe: vi.fn<(machineId: string, options?: unknown) => Promise<unknown>>(),
    targeted: vi.fn<(machineId: string, options?: unknown) => Promise<unknown>>(),
    pendingReplies: new Map<() => void, Promise<void>>(),
}));
const paletteRoute = vi.hoisted(() => ({ segments: [] as string[] }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ segments: () => paletteRoute.segments }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const { waitForNetworkResponseForTests } = await import('@/dev/testkit/mocks/runtimeFetch');
    return createServerScopedMachineRpcBoundaryMock((params) => {
        // Fetch refuses an already-cancelled request before any external dispatch.
        params.signal?.throwIfAborted();
        const read = params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projectionRuntime.describe
            : params.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
                ? projectionRuntime.targeted
                : null;
        if (!read) throw new Error(`Unexpected currentness fixture RPC: ${params.method}`);
        // Pending external replies belong to the test Home transport. A case
        // may deliver a late answer, but disposing the fixture must settle
        // unanswered reads rather than leaking them into the next Account.
        let disconnect!: () => void;
        const reply = new Promise<unknown>((resolve, reject) => {
            disconnect = () => reject(new Error('Test projection Home transport disconnected'));
            void waitForNetworkResponseForTests(Promise.resolve(read(params.machineId, params)), params.signal).then(resolve, reject);
        });
        const settled = reply.then(
            () => { projectionRuntime.pendingReplies.delete(disconnect); },
            () => { projectionRuntime.pendingReplies.delete(disconnect); },
        );
        projectionRuntime.pendingReplies.set(disconnect, settled);
        return reply;
    });
});

const serverIdentityId = 'srv_plugin_ui_currentness';
const harness = createHomeGovernanceHarness();
// Sync's real pending-outbox bootstrap requires the browser's transactional
// record store, independently of the smaller SecureStore custody boundary.
const deviceIndexedDB = new IDBFactory();
vi.stubGlobal('indexedDB', deviceIndexedDB);
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homeId: string;
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { FeedResponseSchema } = await import('@/sync/domains/social/feedTypes');
const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
const { captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');
const { getPreferredLanguage } = await import('@/text');
const { resolveNativeReactNativeHostRuntimeIdentity } = await import('@/components/plugins/reactNative/hostRuntimeIdentity');
const { resolveHostedWebFrameCapability } = await import('@/components/plugins/hostedWeb/hostedWebFrameCapability');
const { getMachineContributionRegistryProjectionRevision, publishMachineContributionRegistryProjectionInvalidation, publishMachineContributionRegistryProjectionRefresh } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');

const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
} = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { PluginPageLaunchInputScope } = await import('@/components/plugins/pages/pluginPageNavigation');
const {
    clearPluginAccountAvailabilityProjection,
    readPluginAccountAvailability,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
} = await import('@/sync/domains/plugins/availability/projection');
const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
const {
    forgetPluginUiProjectionAdmissionSnapshots,
} = await import('./projectionWarmCache');
const {
    resolvePluginUiClientExecutablePlatform,
    resolvePluginUiProjectionPlatform,
    usePluginUiProjectionCurrentness,
} = await import('./usePluginUiProjectionCurrentness');
const { unionPluginUiProjections } = await import('./projectionUnion');
const { AppShellPluginUiProjectionProvider, useAppShellPluginUiProjection } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { PluginEventAutomationComposerContent } = await import('@/components/automations/editor/PluginEventAutomationComposerContent');
const { PluginEventAutomationEditor } = await import('@/components/automations/editor/PluginEventAutomationEditor');
const { usePluginEventAutomationComposer } = await import('@/components/automations/editor/usePluginEventAutomationComposer');

function setMachine(input: { active?: boolean; daemonStateVersion?: number; daemonState?: Readonly<Record<string, unknown>> }) {
    const current = storage.getState().machines['machine-1'];
    const activity = current ? readMachineActivity(current) : null;
    // The presence owner correctly keeps an offline observation on equal
    // timestamps. A resumed heartbeat must actually be newer; untimed initial
    // rows still let the idle fixture cross 180 seconds without fake liveness.
    const activeAt = input.active === true && activity?.active === false
        ? Math.max(Date.now(), (activity.activeAt ?? 0) + 1)
        : activity?.activeAt ?? 0;
    storage.getState().applyMachines([createMachineFixture({ ...current, ...input, id: 'machine-1', activeAt })], true, { sourceServerId: connection?.home.id });
}

function answerCurrentMachineCensus() {
    const machine = storage.getState().machines['machine-1'];
    const accountId = captureActiveServerAccountScopeLifetime()?.scope.accountId;
    if (!machine || !accountId) throw new Error('Machine census fixture requires a current Account and Machine');
    harness.answer(homeId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machine.id, accountId, machine })] });
}

async function switchAccount(accountId: string) {
    const machine = storage.getState().machines['machine-1'];
    const endpointStatus = storage.getState().endpointStatus;
    await connection?.dispose();
    await harness.switchAccount(homeId, accountId);
    connection = await restoreCurrentnessAccount(accountId);
    storage.setState({ endpointStatus });
    setMachine({ active: machine?.active ?? true, daemonStateVersion: machine?.daemonStateVersion ?? 1 });
}

async function restoreCurrentnessAccount(accountId: string) {
    const home = harness.findByServerUrl('https://relay.example.test');
    if (!home?.token || home.accountId !== accountId) throw new Error('Currentness fixture Home has no matching Account credential');
    harness.answer(home.serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ ...profileDefaults, id: accountId }) });
    // The prepared Socket HTTP path and Home-scoped readers must observe the
    // same server answers, not a second transport that returns bootstrap 404s.
    const restored = await restoreServerAccountForTest({
        serverUrl: home.serverUrl,
        serverIdentityId: serverIdentityId,
        accountId,
        request: harness.request,
    });
    // Retain the cleanup handle even if readiness fails before setup returns.
    connection = restored;
    await waitForHomeGovernance(() => {
        expect(storage.getState().profileScope?.accountId).toBe(accountId);
        expect(storage.getState().profile.id).toBe(accountId);
        expect(storage.getState().isDataReady).toBe(true);
    });
    return restored;
}

async function answerBootstrap() {
    const features = createRootLayoutFeaturesResponse();
    const homeFeatures = FeaturesResponseSchema.parse({
        ...features,
        capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId } },
    });
    harness.answer(homeId, '/v1/features', { body: homeFeatures });
    harness.answer(homeId, '/v1/features/authenticated', { body: homeFeatures });
    harness.answer(homeId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    harness.answer(homeId, '/v2/cursor', { body: CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }) });
    const emptySessions = V2SessionListResponseSchema.parse({ sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
    harness.answer(homeId, '/v2/sessions/active?limit=500', { body: emptySessions });
    harness.answer(homeId, '/v2/sessions?includeAttention=true&limit=50', { body: emptySessions });
    harness.answer(homeId, '/v2/sessions/metadata-upgrades', { body: { sessionIds: [] } });
    harness.answer(homeId, '/v1/machines', { body: [] });
    harness.answer(homeId, '/v1/account/pets', { body: AccountPetListResponseV1Schema.parse({ ok: true, pets: [] }) });
    harness.answer(homeId, '/v1/kv?prefix=todo.&limit=1000', { body: { items: [] } });
    harness.answer(homeId, '/v1/feed?limit=100', { body: FeedResponseSchema.parse({ items: [], hasMore: false }) });
    harness.answer(homeId, '/v3/automations?limit=100', { body: AutomationDefinitionListResponseSchema.parse({ automations: [], nextCursor: null }) });
    for (const actionId of ['account.plugins.availability.materializations.read', 'account.plugins.availability.intents.list'] as const) {
        const path = PluginAvailabilityActionHttpPathsV1[actionId];
        const response = createEmptyAccountBootstrapHttpResponse(path, { method: 'POST' });
        if (!response) throw new Error('Missing canonical Plugin Account bootstrap response');
        harness.answer(homeId, `POST ${path}`, { body: await response.json() });
    }
}

async function assertProjectionFixtureReady() {
    const state = storage.getState();
    const machine = state.machines['machine-1'];
    const lifetime = captureActiveServerAccountScopeLifetime();
    const nativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
    const hostedWebFrameCapability = await resolveHostedWebFrameCapability();
    const request = DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
        machineId: 'machine-1',
        locale: getPreferredLanguage(),
        ...(nativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity: nativeHostRuntimeIdentity } : {}),
        ...(hostedWebFrameCapability ? { hostedWebFrameCapability } : {}),
    });
    const facts = {
        endpointStatus: state.endpointStatus,
        machinePresent: Boolean(machine),
        machineOnline: machine ? isMachineOnline(machine) : false,
        accountScope: lifetime?.scope ?? null,
        accountCurrent: lifetime?.isCurrent() ?? false,
        targetHomeMatches: lifetime ? areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverIdentityId) : false,
        platform: resolvePluginUiProjectionPlatform(),
        clientPlatform: resolvePluginUiClientExecutablePlatform(),
        nativeHostRuntimeIdentity,
        hostedWebFrameCapability,
        requestSchemaValid: request.success,
    };
    expect(facts, `Projection fixture pretransport qualification: ${JSON.stringify(facts)}`).toMatchObject({
        endpointStatus: 'online',
        machinePresent: true,
        machineOnline: true,
        accountScope: { accountId: 'account-a' },
        accountCurrent: true,
        targetHomeMatches: true,
        requestSchemaValid: true,
    });
}

function invalidateProjection(reason: 'refresh' | 'authority' = 'authority') {
    publishMachineContributionRegistryProjectionInvalidation({ serverId: serverIdentityId, machineId: 'machine-1' }, reason);
}

function projection(title: string) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        // The daemon generation is intentionally unchanged across Accounts:
        // Account currentness, not a changed generation, must fence A's data.
        generation: 41,
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.preview': {
                        id: 'translations:acme.preview',
                        pluginId: 'acme.preview',
                        occurrenceId: 'occurrence-preview',
                        contributionKind: 'translations',
                        locales: ['en'],
                        bundles: { en: { title } },
                    },
                },
            },
        },
    });
}

function supportedProjection(title: string) {
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1,
        projection: projection(title),
    });
}

describe('usePluginUiProjectionCurrentness', () => {
    beforeEach(async () => {
        paletteRoute.segments = [];
        vi.stubGlobal('indexedDB', deviceIndexedDB);
        await clearBrowserRecords();
        // Nothing reads or writes device custody until its at-rest key
        // resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        retireActiveServerAccountScopeLifetime();
        // The one per-machine projection owner is module state shared by
        // every reader; each case starts from an empty owner.
        clearDaemonMergedProjectionCacheForTests();
        // The retained admission snapshot is real device custody, so it would
        // otherwise leak between cases in this module.
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: serverIdentityId, accountId: 'account-a' });
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: serverIdentityId, accountId: 'account-b' });
        await harness.reset();
        await loadSyncSingletonForTests();
        homeId = await harness.addHome({ name: 'Projection currentness', serverUrl: 'https://relay.example.test', serverIdentityId: serverIdentityId, accountId: 'account-a', active: false });
        await answerBootstrap();
        connection = await restoreCurrentnessAccount('account-a');
        storage.setState({ endpointStatus: 'online' });
        setMachine({ active: true, daemonStateVersion: 1 });
        await assertProjectionFixtureReady();
        projectionRuntime.describe.mockReset();
        projectionRuntime.targeted.mockReset();
    });

    afterEach(async () => {
        standardCleanup();
        retireActiveServerAccountScopeLifetime();
        await connection?.dispose();
        connection = null;
        const pendingReplies = [...projectionRuntime.pendingReplies];
        for (const [disconnect] of pendingReplies) disconnect();
        await Promise.all(pendingReplies.map(([, settled]) => settled));
        await flushHookEffects();
        await harness.reset();
        await clearBrowserRecords();
        storage.setState(storage.getInitialState(), true);
        delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    it.each([false, true])('settles scoped Search independently of slow full demand (concurrent full: %s)', async concurrentFull => {
        const { buildPluginSearchProviderSections } = await import('@/components/appShell/search/pluginSearchProviderSections');
        const { PLUGIN_SEARCH_SECTIONS, useScopedPluginUiProjection } = await import('@/components/plugins/projection/useScopedPluginUiProjection');
        const { useSelectionListDynamicSections } = await import('@/components/ui/selectionList/useSelectionListDynamicSections');
        const { synthesizeSelectionListRenderPlan } = await import('@/components/ui/selectionList/SelectionListRenderPlan');
        const { widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const pluginId = 'qa.journey-machine-search';
        const occurrenceId = `${pluginId}:115`;
        const executionOrigin = { serverIdentityId, sourceRef: { machineId: 'machine-1', pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: '/tmp/journey-machine-search' } } };
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'c'.repeat(64), projection: { v: 2, generation: 115,
                installedPackagesById: { [pluginId]: { ...widgetInstalledPackage(pluginId, 'QA Machine Search'),
                    version: '1.0.0', occurrenceId, executionOrigin } },
                actionsById: { [`${pluginId}/query`]: { id: 'query', pluginId, occurrenceId, executionOrigin,
                    title: 'QA Machine Search', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                    [`searchProvider:${pluginId}:fixture-search`]: { id: `searchProvider:${pluginId}:fixture-search`,
                        pluginId, occurrenceId, contributionKind: 'searchProvider', descriptorId: 'fixture-search',
                        identity: { pluginId, localId: 'fixture-search' }, action: { pluginId, localId: 'query' } },
                } } },
                settingsById: {}, agentsById: {},
                // Same unrelated-contribution scale as DESCRIBE-FANOUT. None
                // of these bodies is needed to render or invoke Search.
                resourcesById: Object.fromEntries(Array.from({ length: 512 }, (_, index) => [
                    `acme.review/unused-${index}`,
                    { id: `unused-${index}`, pluginId: 'acme.review', resourceKind: 'config', scope: 'global', contentType: 'application/json' },
                ])),
            },
        });
        const manifestReady = createDeferred<void>();
        const fullPageReady = createDeferred<void>();
        const fullPageRequested = createDeferred<void>();
        let fullRead: ReturnType<typeof loadDaemonMergedProjectionCacheEntry> | undefined;
        let fullSettled = false;
        let manifests = 0;
        let deferred = buildDeferredDaemonProjectionSections(response);
        const sectionDigests = new Set<string>();
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            // Only full discovery reads sections; a named selection carries none.
            const sectionRead = request.selection === undefined ? request.sectionRead : undefined;
            if (!sectionRead) {
                manifests += 1;
                await manifestReady.promise;
                return deferred.manifest;
            }
            if (concurrentFull && [sectionRead.digest, ...sectionRead.includeDigests ?? []]
                .includes(deferred.manifest.sections.actionsById!)) {
                fullPageRequested.resolve();
                await fullPageReady.promise;
            }
            sectionDigests.add(sectionRead.digest);
            for (const digest of sectionRead.includeDigests ?? []) sectionDigests.add(digest);
            return deferred.read(sectionRead.digest, sectionRead.offset,
                sectionRead.includeDigests);
        });
        let enabled = false;
        const rendered = await renderHook(() => {
            const current = useScopedPluginUiProjection({ machineId: 'machine-1', serverId: serverIdentityId, enabled, sections: PLUGIN_SEARCH_SECTIONS });
            // Machine Search consumes this hook directly; an AppShell union
            // would add origin facts absent from the actual selected path.
            const sections = buildPluginSearchProviderSections({ projection: current.pluginUiProjection,
                scopedLaunchFacts: { machineId: 'machine-1', serverId: serverIdentityId,
                    interactionEnabled: current.interactionEnabled }, onCommitActivation: () => {},
                // External Action transport only; demand, hydration, admission and query dispatch remain real.
                execute: async (_machineId, call) => {
                    expect(call.qualifiedActionId).toBe(`${pluginId}/query`);
                    return { supported: true, result: { ok: true, result: { items: [{ id: 'match',
                        title: 'QA Machine Search: journey', command: { kind: 'executeAction', action: 'query' } }], truncated: false } } };
                },
            });
            const inputValue = enabled ? 'journey' : '';
            const dynamicSectionStates = useSelectionListDynamicSections({ dynamicSections: sections, inputValue });
            const renderPlan = synthesizeSelectionListRenderPlan({
                sections: sections.map(section => ({ kind: 'dynamic' as const, ...section })),
                inputValue, filterQuery: inputValue, dynamicSectionStates,
            });
            return { ...current, renderPlan };
        });
        try {
            // The palette mounts before a query creates scoped projection demand.
            expect(rendered.getCurrent().interactionEnabled).toBe(false);
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            enabled = true;
            await rendered.rerender();
            await waitForHomeGovernance(() => expect(manifests).toBe(1));
            // A delayed ACK and repeated renders must keep one admitted read.
            await rendered.rerender();
            await rendered.rerender();
            expect(rendered.getCurrent().phase).toBe('establishing');
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            if (concurrentFull) {
                const { PLUGIN_UI_SECTIONS } = await import('./projectionSections');
                fullRead = loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: serverIdentityId,
                    accountLifetime: rendered.getCurrent().accountLifetime, sections: PLUGIN_UI_SECTIONS, reuseFreshReady: true,
                }).then(entry => { fullSettled = true; return entry; });
            }
            manifestReady.resolve();
            if (concurrentFull) await fullPageRequested.promise;
            await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
            await waitForHomeGovernance(() => expect(rendered.getCurrent().renderPlan).toMatchObject([{
                id: `plugin-search:${pluginId}:fixture-search`,
                options: [{ label: 'QA Machine Search: journey' }],
            }]));
            // Base + installed package admission + Actions + plugin UI fit
            // one packed index and one packed body frame after the manifest.
            if (!concurrentFull) expect.soft(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            else {
                // The full catalogue has issued a page but cannot finish. Search
                // must publish current and a usable result without its reply.
                expect(fullSettled).toBe(false);
                // Search hydrates from the in-flight full describe's manifest.
                expect(manifests).toBe(1);
            }
            expect.soft(sectionDigests.has(deferred.manifest.sections.resourcesById!)).toBe(false);
            if (!concurrentFull) expect(sectionDigests.has(deferred.manifest.sections.actionsById!)).toBe(false);
            expect(sectionDigests.has(deferred.manifest.sections.searchProviders!)).toBe(true);
            expect(sectionDigests.has(deferred.manifest.sections.settingsById!)).toBe(false);
            expect(sectionDigests.has(deferred.manifest.sections.agentsById!)).toBe(false);
            if (fullRead) {
                fullPageReady.resolve();
                await fullRead;
            }
            const settledReads = projectionRuntime.describe.mock.calls.length;
            await rendered.rerender();
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
            // A real registry change still reaches the narrow reader and
            // withdraws the provider; quiet rerenders must not freeze facts.
            deferred = buildDeferredDaemonProjectionSections({
                ...response, projectionDigest: 'd'.repeat(64), projection: {
                    ...response.projection, generation: 116, familiesById: {
                        ...response.projection.familiesById, pluginUi: { family: 'pluginUi', entriesById: {} },
                    },
                },
            });
            await act(async () => invalidateProjection());
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().phase).toBe('current');
                expect(rendered.getCurrent().renderPlan).toEqual([]);
            });
            expect(projectionRuntime.describe.mock.calls.length - settledReads).toBeLessThanOrEqual(3);
            // One manifest per generation, with or without the concurrent full reader.
            expect(manifests).toBe(2);
        } finally {
            manifestReady.resolve(); fullPageReady.resolve();
            await rendered.unmount();
            if (fullRead) await fullRead;
        }
    });

    it.each([false, true])('settles multi-page scoped Search with delayed page ACKs (Browse and Composer: %s)', async neighbours => {
        const { PLUGIN_SEARCH_SECTIONS, useScopedPluginUiProjection } = await import('@/components/plugins/projection/useScopedPluginUiProjection');
        const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
        const { DAEMON_AGENT_CATALOG_SECTIONS } = await import('@/agents/backendCatalog/agentCatalogSections');
        const { PLUGIN_COMPOSER_PROJECTION_SECTIONS, usePluginExecutionOriginProjectionDemand } = await import('@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand');
        const { DAEMON_PROJECTION_SECTION_FRAME_BYTES, DaemonContributionRegistryProjectionSectionsResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { widgetInstalledPackage } = await import('@/dev/testkit/fixtures/pluginWidgetProjectionFixtures');
        const plugins = Array.from({ length: 77 }, (_, index) => `qa.paged-${index}`);
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'e'.repeat(64), projection: { v: 2, generation: 117,
                installedPackagesById: Object.fromEntries(plugins.map(pluginId => [pluginId,
                    { ...widgetInstalledPackage(pluginId, pluginId), occurrenceId: `${pluginId}:117` }])),
                actionsById: Object.fromEntries(plugins.flatMap(pluginId => Array.from({ length: 8 }, (_, index) => {
                    const id = `action-${index}`;
                    return [`${pluginId}/${id}`, { id, pluginId, occurrenceId: `${pluginId}:117`,
                        executionOrigin: { serverIdentityId, sourceRef: { machineId: 'machine-1', pluginId,
                            // Machine values stay inline in the index, so the narrow index pages too.
                            sourceCustody: { kind: 'development', registeredRootId: `/plugins/${pluginId}/${'x'.repeat(700)}` } } },
                        // Each provider's Action body spans more than one 48 KiB frame.
                        title: id, description: 'Action documentation '.repeat(index === 0 ? 2600 : 512), scopes: ['global'], surfaces: ['ui'],
                        placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true }];
                }))),
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(plugins.map(pluginId => [
                    `searchProvider:${pluginId}:search`, { id: `searchProvider:${pluginId}:search`, pluginId,
                        occurrenceId: `${pluginId}:117`, contributionKind: 'searchProvider', descriptorId: 'search',
                        identity: { pluginId, localId: 'search' }, action: { pluginId, localId: 'action-0' } }])) } },
            },
        });
        const snapshot = buildDeferredDaemonProjectionSections(response);
        const manifest = snapshot.manifest;
        const requests: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>[] = [];
        const replies: Array<ReturnType<typeof createDeferred<void>>> = [];
        const indexes = new Set(Object.values(manifest.sections));
        const starts = new Map<string, number>();
        let indexContinuations = 0;
        let bodyContinuations = 0;
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            // Only full discovery reads sections; a named selection carries none.
            const sectionRead = request.selection === undefined ? request.sectionRead : undefined;
            requests.push(request);
            const ack = createDeferred<void>();
            replies.push(ack);
            await ack.promise;
            if (!sectionRead) return manifest;
            const { digest, offset, includeDigests } = sectionRead;
            const key = `${digest}:${offset}`;
            starts.set(key, (starts.get(key) ?? 0) + 1);
            if (offset > 0) { if (indexes.has(digest)) indexContinuations += 1; else bodyContinuations += 1; }
            return snapshot.read(digest, offset, includeDigests);
        });
        // Derive a conservative page bound by traversing the actual demanded
        // indexes and every disclosed body without packing or shared reuse.
        const pageCount = (digest: string) => {
            let offset = 0;
            let count = 0;
            let text = '';
            for (;;) {
                const page = snapshot.read(digest, offset, []);
                if (!page) throw new Error('Missing fixture page');
                expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(DAEMON_PROJECTION_SECTION_FRAME_BYTES);
                count += 1; text += page.chunk;
                if (page.nextOffset === null) return { count, text };
                offset = page.nextOffset;
            }
        };
        const bodies = new Set<string>();
        let pageBound = 0;
        for (const digest of indexes) {
            const index = pageCount(digest);
            pageBound += index.count;
            const frame = DaemonContributionRegistryProjectionSectionsResponseSchema.parse(JSON.parse(index.text));
            for (const part of frame.parts) if (typeof part !== 'string') bodies.add(part.digest);
        }
        for (const digest of bodies) pageBound += pageCount(digest).count;
        // Advance the clock at each manually delivered ACK batch instead
        // of sleeping: every pending page has the observed ~10.35 s latency.
        const startedAtMs = Date.now();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(startedAtMs);
        const target = { machineId: 'machine-1', serverId: serverIdentityId };
        const rendered = await renderHook(() => ({
            search: useScopedPluginUiProjection({ ...target, sections: PLUGIN_SEARCH_SECTIONS }),
            passive: usePluginUiProjectionCurrentness({ ...target, load: false }),
            browse: useDaemonMergedProjectionInputs({ ...target, enabled: neighbours, sections: DAEMON_AGENT_CATALOG_SECTIONS }),
            composer: usePluginExecutionOriginProjectionDemand(neighbours
                ? { serverIdentityId, machineId: target.machineId } : null, { sections: PLUGIN_COMPOSER_PROJECTION_SECTIONS }),
        }));
        try {
            let released = 0;
            let rounds = 0;
            let phaseAtSixtySeconds: string | undefined;
            // Concurrent readers of one generation share its manifest: neighbours
            // hydrate their own sections from the in-flight describe.
            const manifestCount = 1;
            for (;;) {
                await flushHookEffects();
                const pending = replies.slice(released);
                if (!pending.length) break;
                expect(requests.length).toBeLessThanOrEqual(pageBound + manifestCount);
                // Re-render while ACKs are withheld: no retry or replacement
                // may restart these admitted page reads.
                const before = requests.length;
                await rendered.rerender();
                await flushHookEffects();
                expect(requests).toHaveLength(before);
                released = replies.length;
                rounds += 1;
                await act(async () => { await vi.advanceTimersByTimeAsync(10_350); });
                expect(requests).toHaveLength(before);
                if (phaseAtSixtySeconds === undefined && Date.now() - startedAtMs >= 60_000) {
                    phaseAtSixtySeconds = rendered.getCurrent().search.phase;
                }
                await act(async () => { for (const ack of pending) ack.resolve(); });
            }
            await waitForHomeGovernance(() => expect(rendered.getCurrent().search.phase).toBe('current'));
            expect(rendered.getCurrent().search.interactionEnabled).toBe(true);
            // Narrow Search hydrates exactly the providers' Actions, never the 616-Action catalogue.
            expect(Object.keys(rendered.getCurrent().search.pluginUiProjection?.actionsById ?? {})).toHaveLength(plugins.length);
            expect(requests.filter(request => request.selection !== undefined || !request.sectionRead)).toHaveLength(manifestCount);
            expect([...starts.values()].every(count => count === 1)).toBe(true);
            expect(indexContinuations).toBeGreaterThan(0);
            expect(bodyContinuations).toBeGreaterThan(0);
            if (neighbours) {
                expect(rendered.getCurrent().browse.phase).toBe('ready');
                expect(rendered.getCurrent().composer.phase).toBe('ready');
                expect(rendered.getCurrent().passive.phase).toBe('current');
            } else expect(rendered.getCurrent().passive.phase).toBe('establishing');
            console.info('SCOPED_PAGED_SETTLEMENT', JSON.stringify({ neighbours, plugins: plugins.length,
                actions: plugins.length * 8, manifests: manifestCount, requests: requests.length, pageBound,
                indexContinuations, bodyContinuations, ackRounds: rounds,
                simulatedElapsedMs: Date.now() - startedAtMs, phaseAtSixtySeconds }));
        } finally {
            for (const ack of replies) ack.resolve();
            await rendered.unmount();
            vi.useRealTimers();
        }
    });

    it('admits bundled Voice from a cold passive projection and honors a later empty family', async () => {
        const { PLUGIN_UI_SECTIONS } = await import('./usePluginUiProjectionCurrentness');
        const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const { createBundledConversationRuntimes } = await import('@/voice/registry/bundledConversationRuntimes');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const { reconcileAppShellProjectedClientExecutables, unloadAppShellProjectedClientExecutables } = await import('@/components/appShell/plugins/appShellClientExecutableActivation');
        const { createPluginUiExecutableModuleHost } = await import('@/components/plugins/reactNative/executableModuleHost');
        const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(candidate => candidate.declaration.id === 'realtime-codex');
        if (!entry) throw new Error('Missing bundled Codex Voice fixture');
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            ...supportedProjection('Cold presentation'), projectionDigest: 'd'.repeat(64),
            projection: { ...projection('Cold presentation'), familiesById: {
                ...projection('Cold presentation').familiesById,
                voiceProviders: { family: 'voiceProviders', entriesById: {
                    [entry.providerId]: { id: entry.providerId, pluginId: entry.pluginId, generation: 1,
                        occurrenceId: 'cold-codex-occurrence', contributionKey: entry.providerId, definition: entry.declaration },
                } },
            } },
        });
        const deferred = buildDeferredDaemonProjectionSections(response);
        const transferredDigests: string[] = [];
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Expected shared projection');
            if (!request.sectionRead) return deferred.manifest;
            if (request.sectionRead.offset === 0) transferredDigests.push(request.sectionRead.digest,
                ...request.sectionRead.includeDigests ?? []);
            return deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests);
        });
        const target = { machineId: 'machine-1', serverId: serverIdentityId,
            accountLifetime: captureActiveServerAccountScopeLifetime()! };
        const lease = createBundledConversationRuntimeHostLease();
        const runtimes = (await createBundledConversationRuntimes({ bundledEntries: [entry], host: lease.host }));
        const host = createPluginUiExecutableModuleHost();
        const registry = createDefaultVoiceProviderRegistry();
        // An Agent-only consumer can populate this Machine's shared cache
        // before the AppShell's passive observer mounts after a fresh load.
        expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: ['agentsById'] }))
            .toMatchObject({ kind: 'ready' });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({ ...target, load: false }));
        try {
            expect(rendered.getCurrent().phase).toBe('establishing');
            expect(registry.get(entry.providerId)?.providerId).toBe(entry.providerId);
            await act(async () => {
                expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS, reuseFreshReady: true }))
                    .toMatchObject({ kind: 'ready' });
            });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
            const readsBeforeVoice = projectionRuntime.describe.mock.calls.length;
            await reconcileAppShellProjectedClientExecutables({ projection: null, platform: 'web', voice: null,
                voiceProviderProjection: rendered.getCurrent().pluginUiProjection, executableHost: host });
            expect(registry.get(entry.providerId)?.providerId).toBe(entry.providerId);
            expect(transferredDigests.filter(digest => digest === deferred.manifest.sections['familiesById.voiceProviders']))
                .toHaveLength(1);
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(readsBeforeVoice);

            // A complete empty answer still withdraws the service; fetching
            // the family must not turn absence into a bundled fallback.
            const { normalizePluginUiProjection } = await import('./projection');
            const empty = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
                ...response.projection, generation: 2, familiesById: { voiceProviders: { family: 'voiceProviders', entriesById: {} } },
            }));
            await reconcileAppShellProjectedClientExecutables({ projection: null, platform: 'web', voice: null,
                voiceProviderProjection: empty, executableHost: host });
            expect(registry.get(entry.providerId)).toBeNull();
        } finally {
            await rendered.unmount();
            await unloadAppShellProjectedClientExecutables(host);
            await Promise.all(runtimes.map(runtime => runtime.dispose()));
            lease.revoke();
        }
    });

    it('establishes connected-account purpose setup with zero unrelated UI section reads', async () => {
        const purpose = { consumer: { pluginId: 'acme.preview', localId: 'deployment' }, purpose: 'cloud' };
        const service = { pluginId: 'acme.preview', localId: 'cloud-account' };
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'a'.repeat(64), projection: {
                ...projection('Unrelated presentation'),
                installedPackagesById: { 'acme.preview': { id: 'acme.preview', displayName: 'Preview', enabled: true,
                    source: { kind: 'bundled', locator: 'acme.preview' } } },
                resourcesById: { deployment: { id: 'deployment', pluginId: 'acme.preview', resourceKind: 'config', path: 'deployment.json',
                    connectedAccountPurposes: [{ purpose: 'cloud', serviceRefs: [service] }] } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(
                    Array.from({ length: 172 }, (_, index) => [`translations:acme.preview-${index}`, {
                        id: `translations:acme.preview-${index}`, pluginId: `acme.preview-${index}`,
                        occurrenceId: `preview-${index}`, contributionKind: 'translations', locales: ['en'],
                        bundles: { en: { title: `Unopened UI ${index}` } },
                    }]),
                ) } },
            },
        });
        const deferred = buildDeferredDaemonProjectionSections(response);
        let unrelatedReads = 0;
        const requests: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>[] = [];
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            requests.push(request);
            if (request.selection === 'connectedAccountAdmission') return response;
            if (request.selection !== undefined) throw new Error('Purpose setup must use shared full-discovery sections');
            if (!request.sectionRead) return deferred.manifest;
            const uiDigest = deferred.manifest.sections['familiesById.pluginUi'];
            if (request.sectionRead.digest === uiDigest || request.sectionRead.includeDigests?.includes(uiDigest!)) unrelatedReads += 1;
            return deferred.read(request.sectionRead.digest, request.sectionRead.offset, request.sectionRead.includeDigests);
        });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1', serverId: serverIdentityId, includeConnectedAccountPurposes: true,
        }));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
            const scope = captureActiveServerAccountScopeLifetime()!.scope;
            expect(readConnectedAccountPurposeSetupDeclaration({ scope, machineId: 'machine-1', purpose }, scope,
                rendered.getCurrent())).toMatchObject({ consumerKind: 'resource', serviceRefs: [service] });
            expect(unrelatedReads).toBe(0);
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ selection: 'connectedAccountAdmission' });
            // Opening actual UI later still acquires its missing family through
            // the same loader; narrow setup never claims that family is empty.
            const ui = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1', serverId: serverIdentityId,
            }));
            try {
                await waitForHomeGovernance(() => expect(ui.getCurrent().phase).toBe('current'));
                expect(ui.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview-0']?.bundles)
                    .toEqual({ en: { title: 'Unopened UI 0' } });
                expect(unrelatedReads).toBeGreaterThan(0);
                expect(rendered.getCurrent().phase).toBe('current');
            } finally { await ui.unmount(); }
        } finally { await rendered.unmount(); }
    });

    it.each(['hetzner', 'cua'] as const)('resolves the real %s provisioner purpose after merging Account declarations', async provider => {
        const { PLUGIN_MANIFEST } = provider === 'cua'
            ? await import('@happier-dev/plugins-machine-cua/manifest')
            : await import('@happier-dev/plugins-machine-hetzner/manifest');
        const { useScopedPluginUiProjection } = await import('@/components/plugins/projection/useScopedPluginUiProjection');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = createRootLayoutFeaturesResponse({ features: { plugins: { enabled: true,
            ui: { enabled: true, hostedWeb: { enabled: false }, reactNativeBundles: { enabled: true } } } },
            capabilities: { serverIdentity: { serverIdentityId } } });
        harness.answer(homeId, '/v1/features', { body: features });
        harness.answer(homeId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId: serverIdentityId, snapshot: { status: 'ready', features } });
        const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } =
            await import('@/sync/domains/plugins/availability/projection');
        const accountScope = captureActiveServerAccountScopeLifetime()!.scope;
        const { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginPortableReleaseManifestV1Schema } =
            await import('@happier-dev/protocol/plugins/availability');
        const { createPackageAssetArchiveV1, readDeclaredPackageAssetsV1 } =
            await import('@happier-dev/protocol/plugins/availability');
        const declaredAssets = readDeclaredPackageAssetsV1(PLUGIN_MANIFEST);
        if (!declaredAssets) throw new Error('Expected admitted packaged assets');
        const archive = createPackageAssetArchiveV1({ manifest: PLUGIN_MANIFEST,
            files: declaredAssets.map(asset => ({ path: asset.path, bytes: new Uint8Array([1]) })) });
        if (!archive) throw new Error('Expected produced package archive');
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version,
                enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'purpose-fixture' },
            release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST),
                collectionContracts: [], uiSlots: [],
                packageAssetArchive: archive.descriptor },
            uiArtifacts: [], packageAssets: [],
        });
        replacePluginAccountAvailabilityProjection({ scope: accountScope, snapshot: {
            availabilityCursor: 1, intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }], materializations: [], snapshots: [] } });
        const accountReader = readPluginAccountAvailability(accountScope);
        expect(await accountReader.ensureCurrentAccountExecution(PLUGIN_MANIFEST.id)).toMatchObject({ kind: 'available' });
        expect(accountReader.readAccountUiProjection()).not.toBeNull();
        const { createLoadedMachineProvisionerFixture } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/machineProvisioners.testkit.ts', import.meta.url).href);
        const { normalizePluginManifestV2 } = await import(new URL('../../../../../../cli/src/plugins/manifest/normalize.ts', import.meta.url).href);
        const { projectLoadedPluginContributes } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/fullProjection.ts', import.meta.url).href);
        const { createResolvedContributionRegistry } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
        const { createPluginRuntimeOccurrenceId } = await import(new URL('../../../../../../cli/src/plugins/runtime/runtimeSlots.ts', import.meta.url).href);
        const { buildPluginConnectedAccountAdmissionProjectionV2 } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/projection/v2.ts', import.meta.url).href);
        const { projectConnectedServiceRegistryEntries } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
        const { buildConnectedServicesIndexModel } = await import('@/components/settings/connectedServices/model/buildConnectedServicesIndexModel');
        const { buildConnectedServiceSetupCatalog } = await import('@/components/settings/connectedServices/setup/buildConnectedServiceSetupCatalog');
        const pluginId = PLUGIN_MANIFEST.id;
        const loaded = { ...createLoadedMachineProvisionerFixture(pluginId), manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) };
        const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }), occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) } });
        const produced = PluginProjectionV2Schema.parse(buildPluginConnectedAccountAdmissionProjectionV2({ registry, generation: 41 }));
        const projectionResponse = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'b'.repeat(64), projection: produced,
        });
        const requests: ReturnType<typeof DaemonContributionRegistryProjectionDescribeRequestSchema.parse>[] = [];
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            requests.push(request);
            expect(request).not.toHaveProperty('sections');
            return projectionResponse;
        });
        const rendered = await renderHook(() => useScopedPluginUiProjection({
            machineId: 'machine-1', serverId: serverIdentityId, includeConnectedAccountPurposes: true,
        }));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
            const runtime = rendered.getCurrent();
            expect(runtime.interactionEnabled).toBe(true);
            expect(runtime.accountLifetime?.isCurrent()).toBe(true);
            expect(runtime.connectedAccountProjection?.kind).toBe('ready');
            const scope = captureActiveServerAccountScopeLifetime()!.scope;
            const purpose = { consumer: { pluginId, localId: provider === 'cua' ? 'byoc' : 'hetzner' }, purpose: provider === 'cua' ? 'cloud-account' : 'cloud-api' };
            const service = { pluginId, localId: provider === 'cua' ? 'cloud-native' : 'hetzner-account' };
            expect(readConnectedAccountPurposeSetupDeclaration({ scope, machineId: 'machine-1', purpose }, scope, runtime))
                .toMatchObject({ consumerKind: 'machineProvisioner', serviceRefs: [service] });
            expect(readConnectedAccountPurposeSetupDeclaration({ scope, machineId: 'machine-1', purpose }, scope,
                { ...runtime, pluginUiProjection: { ...runtime.pluginUiProjection!, machineProvisionersById: {} } })).toBeNull();
            expect(runtime.connectedAccountProjection?.kind).toBe('ready');
            if (runtime.connectedAccountProjection?.kind !== 'ready') throw new Error('Expected account descriptor admission');
            const entries = projectConnectedServiceRegistryEntries({ scopeKey: 'hetzner-purpose', status: 'ready',
                descriptors: runtime.connectedAccountProjection.descriptors, conflicts: [], errorReason: null });
            const model = buildConnectedServicesIndexModel({ transport: 'advertised-v4', entries, qualifiedAccounts: [],
                qualifiedGroups: [], legacyServices: [], defaultAccountByServiceKey: {}, agentUses: [],
                resolveLabel: entry => typeof entry?.projectedTitle === 'string' ? entry.projectedTitle : entry?.projectedTitle?.fallback ?? '',
                resolveFallbackEntry: () => null, presentDiagnostics: () => ({ primary: null, supportDetails: null }), loadingLabel: 'Loading' });
            expect(buildConnectedServiceSetupCatalog(model)).toEqual(expect.arrayContaining([
                expect.objectContaining({ service }),
            ]));
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({ selection: 'connectedAccountAdmission' });
            expect(requests[0]).not.toHaveProperty('deferredSections');
            if (provider === 'cua') {
                // R120-E captured these request identities and the current/ready flags above.
                const captured = { machineId: '18402cb2-7a54-4137-b8f1-d30855fc102d', purpose,
                    scope: { serverId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
                        accountId: '783bba8a-e455-41b2-9bc0-50f18325cc45' } };
                expect(readConnectedAccountPurposeSetupDeclaration(captured, captured.scope,
                    { ...runtime, serverId: captured.scope.serverId, machineId: captured.machineId }))
                    .toMatchObject({ consumerKind: 'machineProvisioner', serviceRefs: [service] });
                expect(readConnectedAccountPurposeSetupDeclaration({ scope, machineId: 'machine-1',
                    purpose: { ...purpose, purpose: 'cua-account' } }, scope, runtime))
                    .toMatchObject({ consumerKind: 'machineProvisioner', serviceRefs: [{ pluginId, localId: 'cua-account' }] });
            }
            await act(async () => { setMachine({ active: false }); });
            await rendered.rerender();
            await flushHookEffects();
            expect(rendered.getCurrent().interactionEnabled).toBe(false);
            expect(accountReader.readAccountUiProjection()).not.toBeNull();
            expect(readConnectedAccountPurposeSetupDeclaration({ scope, machineId: 'machine-1', purpose }, scope,
                rendered.getCurrent())).toBeNull();
        } finally { await rendered.unmount(); }
    });

    it.each([true, false])('acquires cold Home Search Actions from installed Machines only while Search is presented (declaration known: %s)', async declarationKnown => {
        const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
        const { useUniversalSearchRuntime } = await import('@/components/appShell/search/UniversalSearchRuntimeContext');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const pluginId = 'qa.qar90s-r8';
        const sourceCustody = { kind: 'development' as const, registeredRootId: '/plugins/qar90s' };
        const executionOrigin = { serverIdentityId, sourceRef: { machineId: 'machine-1', pluginId, sourceCustody } };
        const action = { id: 'change', title: 'QAR90S change flower', scopes: ['global', 'session'],
            surfaces: ['ui', 'agent', 'cli'], placementBindings: ['commandPalette'], execution: { target: 'daemon' },
            dangerLevel: 'safe', inputSchema: { type: 'object', properties: { flower: { type: 'string' } }, required: ['flower'] },
            inputHints: { fields: [{ path: 'flower', title: 'Flower', widget: 'text', required: true }] } };
        const declaration = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: pluginId, version: '0.1.2',
            displayName: 'QAR90S', runtime: { apiVersion: 1 }, contributes: { actions: [action] } });
        const materialization = { serverIdentityId, machineId: 'machine-1', materializationId: 'qar90s-install', pluginId,
            version: '0.1.2', sourceClass: 'localPath' as const, portableRelease: false, uiArtifacts: [], enabled: true,
            trustState: 'trusted' as const, observedAt: 1, ...(declarationKnown ? { declaredManifest: declaration } : {}) };
        const nonContributor = { ...materialization, machineId: 'unrelated-machine', materializationId: 'unrelated-install',
            pluginId: 'qa.no-actions', declaredManifest: PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2,
                id: 'qa.no-actions', version: '0.1.2', displayName: 'No Actions', runtime: { apiVersion: 1 }, contributes: {} }) };
        const materializations = [materialization, nonContributor];
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: { availabilityCursor: 1,
            intentReads: [], materializations,
            snapshots: materializations.map(row => ({ serverIdentityId, machineId: row.machineId, materializations: [row] })) } });
        await publishMachineInventoryForTest(lifetime.scope, [storage.getState().machines['machine-1']!,
            createMachineFixture({ id: 'unrelated-machine', active: true, activeAt: Date.now() })]);
        const { inputSchema: _inputSchema, ...projectedAction } = action;
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projectionDigest: 'e'.repeat(64), projection: { v: 2, generation: 41,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'QAR90S', version: '0.1.2', enabled: true,
                    occurrenceId: 'qar90s:89', source: { kind: 'localPath', locator: '/plugins/qar90s' }, sourceCustody, executionOrigin } },
                actionsById: { [`${pluginId}/change`]: { ...projectedAction, pluginId, occurrenceId: 'qar90s:89', executionOrigin, available: true } } } });
        const deferred = buildDeferredDaemonProjectionSections(response);
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            // Only full discovery reads sections; a named selection carries none.
            const sectionRead = request.selection === undefined ? request.sectionRead : undefined;
            return sectionRead ? deferred.read(sectionRead.digest, sectionRead.offset,
                sectionRead.includeDigests) : deferred.manifest;
        });
        let search: ReturnType<typeof useUniversalSearchRuntime> | undefined;
        function Probe() { search = useUniversalSearchRuntime(); return null; }
        const view = () => <InjectedAuthProvider credentials={connection!.credentials}><AppShellPluginUiProjectionProvider>
            <CommandPaletteProvider><Probe /></CommandPaletteProvider>
        </AppShellPluginUiProjectionProvider></InjectedAuthProvider>;
        const rendered = await renderWithAppProviders(view());
        try {
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            paletteRoute.segments = ['search'];
            await rendered.update(view());
            await vi.waitFor(() => expect(search?.buildCommands().filter(command => command.id.startsWith('plugin-action:'))
                .map(command => command.title)).toContain('QAR90S change flower'));
            expect(new Set(projectionRuntime.describe.mock.calls.map(([machineId]) => machineId))).toEqual(new Set(['machine-1']));
            paletteRoute.segments = [];
            await rendered.update(view());
            const reads = projectionRuntime.describe.mock.calls.length;
            await act(async () => invalidateProjection());
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(reads);
        } finally { await rendered.unmount(); }
    });

    it('acquires the cold Connected services catalog without requiring an already admitted app-shell Machine', async () => {
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-machine-hetzner/manifest');
        const { createLoadedMachineProvisionerFixture } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/machineProvisioners.testkit.ts', import.meta.url).href);
        const { normalizePluginManifestV2 } = await import(new URL('../../../../../../cli/src/plugins/manifest/normalize.ts', import.meta.url).href);
        const { projectLoadedPluginContributes } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/fullProjection.ts', import.meta.url).href);
        const { createResolvedContributionRegistry } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
        const { createPluginRuntimeOccurrenceId } = await import(new URL('../../../../../../cli/src/plugins/runtime/runtimeSlots.ts', import.meta.url).href);
        const { buildPluginProjectionV2 } = await import(new URL('../../../../../../cli/src/plugins/projection/registry/projection/v2.ts', import.meta.url).href);
        const { useConnectedServicesIndex } = await import('@/components/settings/connectedServices/model/useConnectedServicesIndex');
        const { buildConnectedServiceSetupCatalog } = await import('@/components/settings/connectedServices/setup/buildConnectedServiceSetupCatalog');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { useMachineAdministrationTargetSelection } = await import('@/sync/domains/machines/administration/useTargetSelection');
        const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId }, connectedServices: {
                credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 },
            } } });
        harness.answer(homeId, '/v1/features', { body: features });
        harness.answer(homeId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId: serverIdentityId, snapshot: { status: 'ready', features } });
        const machine = storage.getState().machines['machine-1']!;
        // The live C Home has multiple Machines. A single-Machine union exposes
        // an incidental target even before acquisition and cannot reproduce this deadlock.
        await publishMachineInventoryForTest({ serverId: serverIdentityId, accountId: 'account-a' }, [
            machine, createMachineFixture({ id: 'machine-neighbor', active: true, activeAt: Date.now() }),
        ]);
        const pluginId = PLUGIN_MANIFEST.id;
        const loaded = { ...createLoadedMachineProvisionerFixture(pluginId), manifest: normalizePluginManifestV2(PLUGIN_MANIFEST),
            sourceSpec: { kind: 'path' as const, locator: '/plugins/hetzner', resolvedVersion: PLUGIN_MANIFEST.version,
                trustPolicy: 'local_trusted' as const, installPolicy: 'copy' as const } };
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const sourceCustody = { kind: 'development' as const, registeredRootId: loaded.pluginRootPath };
        const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: 'machine-1', pluginId, sourceCustody } });
        const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party',
        }), occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projectionDigest: 'b'.repeat(64), projection: buildPluginProjectionV2({ registry, generation: 41,
                pluginExecutionOriginsByPluginId: { [pluginId]: executionOrigin },
                pluginFinalPolicyCurrentRuntimesById: new Map([[pluginId, { occurrenceId, sourceCustody,
                    desiredOccurrenceId: occurrenceId, appliedOccurrenceId: occurrenceId, applied: true, selectedAccess: [] }]]),
            }) });
        expect(response.projection?.installedPackagesById[pluginId]).toMatchObject({
            version: PLUGIN_MANIFEST.version, occurrenceId, sourceCustody, executionOrigin,
        });
        const deferred = buildDeferredDaemonProjectionSections(response);
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Expected catalog discovery');
            return request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
        });
        harness.answer(homeId, '/v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'absent' } });
        let index: ReturnType<typeof useConnectedServicesIndex> | undefined;
        let selection: ReturnType<typeof useMachineAdministrationTargetSelection> | undefined;
        function Catalog({ demand }: Readonly<{ demand: boolean }>) {
            selection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts, {
                enabled: demand, initialTarget: { serverIdentityId, machineId: 'machine-1' },
            });
            index = useConnectedServicesIndex({ agents: demand ? 'load' : 'cached', targetSelection: selection }); return null;
        }
        const catalog = (demand: boolean) => <AppShellPluginUiProjectionProvider><Catalog demand={demand} /></AppShellPluginUiProjectionProvider>;
        const screen = await renderWithAppProviders(catalog(false));
        try {
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            expect(index?.appShellProjection.machineId).toBeNull();
            await screen.update(catalog(true));
            await waitForHomeGovernance(() => expect(selection?.canExecute, JSON.stringify(selection?.state)).toBe(true));
            expect(index?.transport).toBe('advertised-v4');
            await waitForHomeGovernance(() => expect(index && buildConnectedServiceSetupCatalog(index.indexModel),
                JSON.stringify({ reads: projectionRuntime.describe.mock.calls.length, transport: index?.transport,
                    registry: index?.registrySnapshot.status,
                    entry: index?.registrySnapshot.entries.filter(e => e.service?.pluginId === pluginId).map(e => ({
                        status: e.projectionStatus, availability: e.availability, executable: e.executable })),
                    shell: {phase: index?.appShellProjection.phase, machineId:index?.appShellProjection.machineId} }))
                .toEqual(expect.arrayContaining([expect.objectContaining({ service: { pluginId, localId: 'hetzner-account' }, canAdd: true })])));
            // Answered descriptors do not admit unrelated, still-unrequested UI.
            expect(index?.appShellProjection.phase).toBe('establishing');
            const reads = projectionRuntime.describe.mock.calls.length;
            await screen.update(catalog(false));
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(reads);
        } finally { vi.useRealTimers(); await screen.unmount(); }
    });

    it('publishes a selected Machine daemon-only descriptor into the real cold Connect More catalog', async () => {
        const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { useConnectedServicesIndex } = await import('@/components/settings/connectedServices/model/useConnectedServicesIndex');
        const { buildConnectedServiceSetupCatalog } = await import('@/components/settings/connectedServices/setup/buildConnectedServiceSetupCatalog');
        const { ConnectedServiceSetupPanel } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupPanel');
        const { pressTestInstanceAsync } = await import('@/dev/testkit/render/renderScreen');
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId }, connectedServices: {
            credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 },
        } } });
        harness.answer(homeId, '/v1/features', { body: features });
        harness.answer(homeId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId: serverIdentityId, snapshot: { status: 'ready', features } });
        const machine = storage.getState().machines['machine-1']!;
        await publishMachineInventoryForTest({ serverId: serverIdentityId, accountId: 'account-a' }, [
            machine, createMachineFixture({ id: 'machine-neighbor', active: true, activeAt: Date.now() }),
        ]);
        const service = { pluginId: 'qa.finish-e-cli-secret-configuration', localId: 'fixture' } as const;
        const descriptor = {
            id: 'fixture', serviceId: 'fixture', pluginId: service.pluginId,
            title: 'FINISH-E-CLI disposable configuration', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'fixture', modes: [{ id: 'fixture', kind: 'manual', title: 'Disposable fixture',
                outcomeReconciliation: 'none', fields: [{ id: 'label', title: 'Fixture label', schema: { type: 'string' }, secret: false }],
                configuration: { scope: 'service', changeBehavior: 'refresh', fields: [{ id: 'dummy-secret', title: 'E6 dummy Secret',
                    schema: { type: 'string' }, secret: true, required: false }] } }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projectionDigest: 'f'.repeat(64), projection: PluginProjectionV2Schema.parse({ v: 2, generation: 71, agentsById: {},
                familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'qa.finish-e-cli-secret-configuration/fixture': descriptor } } },
            }) });
        const deferred = buildDeferredDaemonProjectionSections(response);
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Expected full catalog projection');
            return request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
        });
        harness.answer(homeId, '/v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'absent' } });
        let index: ReturnType<typeof useConnectedServicesIndex> | undefined;
        let targetSelection: unknown;
        function Catalog() {
            index = useConnectedServicesIndex({ agents: 'load' });
            targetSelection = (index as unknown as { targetSelection?: unknown }).targetSelection;
            const catalog = buildConnectedServiceSetupCatalog(index.indexModel);
            return <>
                <ConnectedServiceSetupPanel target={{ kind: 'catalog' }} catalog={catalog} onTargetChange={() => {}}
                    onClose={() => {}} onConnected={() => {}} targetSelection={targetSelection as never} chrome="frame" />
            </>;
        }
        const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Catalog /></AppShellPluginUiProjectionProvider>);
        try {
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            await pressTestInstanceAsync(screen.tree.root.findByProps({ testID: 'connected-service-setup-target.chip' }), 'choose catalog Machine');
            await waitForHomeGovernance(() => expect(() => screen.tree.root.findByProps({ testID: 'connected-service-setup-target.picker-option:machine-1' })).not.toThrow());
            await pressTestInstanceAsync(screen.tree.root.findByProps({ testID: 'connected-service-setup-target.picker-option:machine-1' }), 'select fixture Machine');
            await waitForHomeGovernance(() => expect(index && buildConnectedServiceSetupCatalog(index.indexModel), JSON.stringify({
                reads: projectionRuntime.describe.mock.calls.length,
                registry: index?.registrySnapshot.status,
                entries: index?.registrySnapshot.entries.filter(entry => entry.service?.pluginId === service.pluginId),
            })).toEqual(expect.arrayContaining([expect.objectContaining({ service, canAdd: true })])));
            expect(projectionRuntime.describe.mock.calls.some(([machineId]) => machineId === 'machine-1')).toBe(true);
            expect(index?.registrySnapshot.entries.find(entry => entry.service?.pluginId === service.pluginId)?.projectedDescriptor)
                .toMatchObject({ sourceKind: 'installed', availability: { state: 'available' } });
        } finally { await screen.unmount(); }
    });

    it('publishes one exact Home Machine inventory through device-local and portable aliases', async () => {
        if (!connection) throw new Error('The real focused Home was not restored');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('The real Account lifetime was not admitted');
        await (await import('@/sync/sync')).sync.refreshPluginAccountAvailability();
        expect(readPluginAccountAvailability(lifetime.scope).readMaterializations()).toMatchObject({
            kind: 'available', availabilityCursor: 0,
        });
        expect(connection.home.id).not.toBe(serverIdentityId);
        // A complete Home list may settle before a later Machine event uses
        // this device's equivalent local profile id. Both are the same owner.
        storage.getState().applyMachines([], true, { sourceServerId: serverIdentityId });
        setMachine({ active: true, daemonStateVersion: 2 });
        expect(storage.getState().machines['machine-1']?.active).toBe(true);
        for (const serverId of [serverIdentityId, connection.home.id]) {
            const machine = resolveServerScopedMachine(storage.getState(), serverId, 'machine-1');
            expect(machine, JSON.stringify({
                requestedHome: serverId,
                scopedInventory: Object.fromEntries(Object.entries(storage.getState().machineListByServerId)
                    .map(([home, machines]) => [home, machines?.map((entry) => entry.id)])),
                statuses: storage.getState().machineListStatusByServerId,
            })).toMatchObject({ id: 'machine-1', active: true, daemonStateVersion: 2 });
            expect(machine && isMachineOnline(machine)).toBe(true);
        }
    });

    it('retires legacy aliases of the disconnected Home Machine inventory without clearing another Home', async () => {
        if (!connection) throw new Error('The real focused Home was not restored');
        const focusedConnection = connection;
        const legacyHomeId = focusedConnection.home.id;
        expect(legacyHomeId).not.toBe(serverIdentityId);
        expect(areServerProfileIdentifiersEquivalent(legacyHomeId, serverIdentityId)).toBe(true);
        const otherIdentityId = 'srv_machine_inventory_reset_neighbor';
        const otherHomeId = await harness.addHome({
            name: 'Retained Machine inventory neighbor',
            serverUrl: 'https://machine-inventory-neighbor.example.test',
            serverIdentityId: otherIdentityId,
            accountId: 'account-b',
            active: false,
        });
        const freshMachine = createMachineFixture({ id: 'machine-1', activeAt: 0, daemonStateVersion: 2 });
        const legacyMachine = createMachineFixture({ id: 'machine-1', activeAt: 0, daemonStateVersion: 1 });
        const otherMachine = createMachineFixture({ id: 'machine-1', activeAt: 0, daemonStateVersion: 7 });
        storage.getState().applyMachines([freshMachine], true, { sourceServerId: serverIdentityId });
        storage.getState().applyMachines([otherMachine], true, { sourceServerId: otherHomeId });

        // Prospective predecessor input: ../0.2 HEAD 37a6541578749067b49d4579be8c752c9591b8c8
        // store/domains/machines.ts:342–368 (and this writer before normalization)
        // writes full Machine arrays and idle status under the caller's literal
        // local profile id. Keep that already-existing cache shape beside the
        // fresh canonical write, so writer normalization alone cannot pass.
        const legacySnapshot = {
            machineListByServerId: { ...storage.getState().machineListByServerId, [legacyHomeId]: [legacyMachine] },
            machineListStatusByServerId: { ...storage.getState().machineListStatusByServerId, [legacyHomeId]: 'idle' },
        } satisfies Pick<ReturnType<typeof storage.getState>, 'machineListByServerId' | 'machineListStatusByServerId'>;
        storage.setState(legacySnapshot);
        expect(resolveServerScopedMachine(storage.getState(), serverIdentityId, 'machine-1')?.daemonStateVersion).toBe(2);
        expect(storage.getState().machineListByServerId[legacyHomeId]).toEqual([legacyMachine]);
        const otherInventory = Object.fromEntries(Object.entries(storage.getState().machineListByServerId)
            .filter(([key]) => areServerProfileIdentifiersEquivalent(key, otherIdentityId)));
        const otherStatuses = Object.fromEntries(Object.entries(storage.getState().machineListStatusByServerId)
            .filter(([key]) => areServerProfileIdentifiersEquivalent(key, otherIdentityId)));
        expect(resolveServerScopedMachine(storage.getState(), otherIdentityId, 'machine-1')?.daemonStateVersion).toBe(7);

        // dispose invokes the real connectionManager disconnect -> public Sync
        // disconnect -> outgoing applied-Home reset, not a mocked reset helper.
        await act(async () => { await focusedConnection.dispose(); });
        connection = null;
        const state = storage.getState();
        expect(resolveServerScopedMachine(state, serverIdentityId, 'machine-1')).toBeNull();
        expect(Object.keys(state.machineListByServerId)
            .filter((key) => areServerProfileIdentifiersEquivalent(key, serverIdentityId))).toEqual([]);
        expect(Object.keys(state.machineListStatusByServerId)
            .filter((key) => areServerProfileIdentifiersEquivalent(key, serverIdentityId))).toEqual([]);
        expect(Object.fromEntries(Object.entries(state.machineListByServerId)
            .filter(([key]) => areServerProfileIdentifiersEquivalent(key, otherIdentityId)))).toEqual(otherInventory);
        expect(Object.fromEntries(Object.entries(state.machineListStatusByServerId)
            .filter(([key]) => areServerProfileIdentifiersEquivalent(key, otherIdentityId)))).toEqual(otherStatuses);
        expect(resolveServerScopedMachine(state, otherIdentityId, 'machine-1')?.daemonStateVersion).toBe(7);
    });

  it('uses the canonical local-service resolver for Tauri desktop projection surfaces', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };

    expect(resolvePluginUiProjectionPlatform()).toBe('desktop');
  });

  it('maps the desktop projection surface to the shared web client executable target', () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: () => undefined };

    expect(resolvePluginUiClientExecutablePlatform()).toBe('web');
  });

    it('boots a fresh process from retained device custody when every daemon is unreachable', async () => {
        // Warm run: the server is reachable and the daemon answers once. This
        // is the only moment admission currentness is confirmed.
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();

        // Cold process: laptop asleep, phone on cellular. The Account server
        // still answers, every daemon is unreachable, and nothing may reach
        // for one.
        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });

        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().interactionEnabled).toBe(false);
        expect(cold.getCurrent().pluginBrowserProjection).toBeNull();
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
        expect(projectionRuntime.describe).not.toHaveBeenCalled();
        await cold.unmount();

        // Falsification: empty the device custody for this exact Account and
        // the same cold process must fail closed instead of presenting a
        // fabricated catalog.
        forgetPluginUiProjectionAdmissionSnapshots({ serverId: serverIdentityId, accountId: 'account-a' });
        const emptied = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(emptied.getCurrent()).toMatchObject({ phase: 'unavailable', unavailableReasonCode: 'plugin_machine_unreachable' });
        expect(emptied.getCurrent().pluginUiProjection).toBeNull();
        expect(projectionRuntime.describe).not.toHaveBeenCalled();
    });

    it('restores retained custody when a fresh process only learns the daemon is unreachable after its first describe', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        // Laptop asleep: the Account server still reports the machine online
        // from its last heartbeat, so the fresh process does reach for a daemon
        // and only learns it is unreachable afterwards. Nothing was ever
        // confirmed in this process, so there is no in-process snapshot to keep.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockRejectedValue(new Error('daemon unreachable'));
        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(cold.getCurrent()).toMatchObject({ phase: 'retainedOffline', unavailableReasonCode: 'plugin_daemon_unavailable', interactionEnabled: false });

        setMachine({ active: false });
        await act(async () => {
            await cold.rerender();
        });
        await flushHookEffects();

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().interactionEnabled).toBe(false);
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
    });

    it('never reports unavailable while the Home credential binding is still resolving', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();

        // The credential read has not answered on the first render. That is no
        // verdict about the Machine, so a consumer must not see a withdrawal
        // which the very next render retracts.
        setMachine({ active: false });
        const phases: string[] = [];
        const cold = await renderHook(() => {
            const current = usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            phases.push(current.phase);
            return current;
        });
        await flushHookEffects();

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(phases).not.toContain('unavailable');
        expect(phases[0]).toBe('establishing');
    });

    it('leaves a daemon-answered unavailable target unavailable when it later goes offline', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        // A daemon answered for this exact target and its answer was that the
        // machine cannot serve the projection at all. Device custody must not
        // overturn that answer when the machine subsequently drops offline.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(answered.getCurrent().phase).toBe('unavailable');

        setMachine({ active: false });
        await act(async () => {
            await answered.rerender();
        });
        await flushHookEffects();

        expect(answered.getCurrent().phase).toBe('unavailable');
        expect(answered.getCurrent().pluginUiProjection).toBeNull();
    });

    it('retires device custody on a definitive not-supported answer and keeps it through a transient failure', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        // A transport failure is not the daemon's answer. It must leave the
        // retained snapshot in device custody for the next process.
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockRejectedValue(new Error('RPC transport unavailable'));
        const transient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(transient.getCurrent()).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        await transient.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterTransient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(afterTransient.getCurrent().phase).toBe('retainedOffline');
        expect(afterTransient.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
        await afterTransient.unmount();

        // The daemon's own definitive answer is that this machine does not
        // serve the projection. That must survive a restart.
        setMachine({ active: true });
        invalidateProjection();
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockResolvedValue({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        const answered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(answered.getCurrent().phase).toBe('unavailable');
        await answered.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const afterDefinitive = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(afterDefinitive.getCurrent().phase).toBe('unavailable');
        expect(afterDefinitive.getCurrent().pluginUiProjection).toBeNull();
    });

    it('never retains a daemon-backed contribution family in the Account admission snapshot', async () => {
        const withComposerControl = projection('Retained catalog');
        projectionRuntime.describe.mockResolvedValueOnce({
            protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({
                ...withComposerControl,
                familiesById: {
                    ...withComposerControl.familiesById,
                    composerControls: {
                        family: 'composerControls',
                        entriesById: {
                            'acme.preview/add-issue': {
                                id: 'acme.preview/add-issue',
                                pluginId: 'acme.preview',
                                identity: { pluginId: 'acme.preview', localId: 'add-issue' },
                                occurrenceId: 'preview-generation-42',
                                definition: {
                                    id: 'add-issue',
                                    label: 'Add issue',
                                    icon: 'add',
                                    scopes: ['session'],
                                    interaction: {
                                        kind: 'attachmentPicker',
                                        attachment: 'issue',
                                        presentation: 'popover',
                                        layout: 'list',
                                    },
                                },
                            },
                        },
                    },
                },
            }),
        });
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        // The live projection does admit the Composer control, so the cold
        // assertion below discriminates retention from normalization.
        expect(warm.getCurrent().pluginUiProjection?.composerControlsById['acme.preview/add-issue']).toBeDefined();
        await warm.unmount();

        setMachine({ active: false });
        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementation(() => {
            throw new Error('a cold process must not need a daemon to mount');
        });
        const cold = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(cold.getCurrent().phase).toBe('retainedOffline');
        expect(cold.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeDefined();
        expect(cold.getCurrent().pluginUiProjection?.composerControlsById).toEqual({});
    });

    it('presents the retained catalog read-only while an online daemon refresh is still establishing', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Retained catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();
        clearDaemonMergedProjectionCacheForTests();

        projectionRuntime.describe.mockReset();
        projectionRuntime.describe.mockImplementationOnce(() => new Promise(() => {}));
        const renderedScopes: Array<Readonly<{
            accountCurrent: boolean;
            accountId: string | null;
            catalog: unknown;
            phase: ReturnType<typeof usePluginUiProjectionCurrentness>['phase'];
            interactionEnabled: boolean;
            browserProjection: unknown;
        }>> = [];
        const refreshing = await renderHook(() => {
            const currentness = usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            });
            renderedScopes.push({
                accountCurrent: currentness.accountLifetime?.isCurrent() === true,
                accountId: currentness.accountLifetime?.scope.accountId ?? null,
                catalog: currentness.pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles,
                phase: currentness.phase,
                interactionEnabled: currentness.interactionEnabled,
                browserProjection: currentness.pluginBrowserProjection,
            });
            return currentness;
        });
        await flushHookEffects();
        await waitForHomeGovernance(() => {
            expect(refreshing.getCurrent().accountLifetime?.isCurrent()).toBe(true);
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        });

        // The exact Home must finish native credential admission before any
        // device custody can be disclosed. Once admitted, its first frame
        // already has the read-only catalog; a later restoration effect must
        // not make this assertion pass retroactively.
        expect(renderedScopes[0]).toMatchObject({
            accountCurrent: false, accountId: null, catalog: undefined,
            interactionEnabled: false, browserProjection: null,
        });
        expect(renderedScopes.filter((frame) => !frame.accountCurrent).every((frame) => frame.catalog === undefined)).toBe(true);
        expect(renderedScopes.find((frame) => frame.accountCurrent)).toMatchObject({
            accountId: 'account-a', catalog: { en: { title: 'Retained catalog' } },
            phase: 'establishing', interactionEnabled: false, browserProjection: null,
        });
        expect(refreshing.getCurrent().phase).toBe('establishing');
        expect(refreshing.getCurrent().interactionEnabled).toBe(false);
        expect(refreshing.getCurrent().pluginBrowserProjection).toBeNull();
        expect(refreshing.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Retained catalog' },
        });
    });

    it('never retains a snapshot for another Account and supersedes the retained one once a daemon answers', async () => {
        projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Account A catalog'));
        const warm = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(warm.getCurrent().phase).toBe('current'));
        await warm.unmount();

        // Account B on the same server and the same machine must not reach
        // Account A's retained catalog.
        await act(async () => { await switchAccount('account-b'); });
        setMachine({ active: false });
        projectionRuntime.describe.mockReset();

        const otherAccount = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(otherAccount.getCurrent().phase).toBe('unavailable');
        expect(otherAccount.getCurrent().pluginUiProjection).toBeNull();
        await otherAccount.unmount();

        // Back on Account A the retained catalog is reusable, and the moment a
        // daemon answers it is superseded by live authority.
        await act(async () => { await switchAccount('account-a'); });
        const restored = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(restored.getCurrent().phase).toBe('retainedOffline');

        projectionRuntime.describe.mockResolvedValue(supportedProjection('Live catalog'));
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Restored Account has no admitted lifetime');
        // Account transport withdrawal invalidates retained presence. A new
        // Home ingress observes this exact Machine before live reads resume.
        const observePresence = captureMachinePresenceObservation(lifetime.scope);
        await act(async () => {
            setMachine({ active: true });
            await restored.rerender();
        });
        expect(restored.getCurrent().phase).toBe('retainedOffline');
        await act(async () => { observePresence(['machine-1']); });
        await waitForHomeGovernance(() => expect(restored.getCurrent().phase).toBe('current'));
        expect(restored.getCurrent().interactionEnabled).toBe(true);
        expect(restored.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Live catalog' },
        });
    });

    it('admits the first successful describe when the initial Machine census arrives before AppShell mounts', async () => {
        const machine = storage.getState().machines['machine-1']!;
        storage.setState({ machines: {}, machineListByServerId: {} });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('First live catalog'));
        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
            machineId: 'machine-1', serverId: serverIdentityId,
        })).resolves.toMatchObject({ kind: 'ready' });

        storage.getState().applyMachines([machine], true, { sourceServerId: connection!.home.id });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1', serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'First live catalog' },
        });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        await rendered.unmount();
    });

    it('reports a first describe as establishing instead of an empty unavailable projection', async () => {
        projectionRuntime.describe.mockImplementationOnce(() => new Promise(() => {}));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
    });

    it('keeps the live catalog current with forty mounted offline readers without republishing unchanged currentness', async () => {
        let renders = 0;
        let publications = 0;
        setMachine({ active: true, daemonStateVersion: 1, daemonState: {
            status: 'running', pid: 17, runtimeId: 'runtime-currentness', contributionRegistryProjectionRevision: 0,
        } });
        const offlineMachines = Array.from({ length: 40 }, (_, index) => createMachineFixture({
            id: `offline-${index}`, active: false, activeAt: 0,
        }));
        storage.getState().applyMachines(offlineMachines, false, { sourceServerId: connection!.home.id });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Live catalog'));
        const rendered = await renderHook(() => {
            renders += 1;
            // The reader count is fixed for this mounted test. Each reader
            // runs the real store/currentness owner, as AppShell's children do.
            const readers = [' machine-1 ', ...offlineMachines.map(machine => machine.id)].map(machineId => (
                usePluginUiProjectionCurrentness({ machineId, serverId: serverIdentityId })
            ));
            React.useEffect(() => { publications += 1; }, readers);
            return { readers, union: unionPluginUiProjections(readers.map(reader => ({
                ...reader, machineId: reader.machineId!,
                projection: reader.pluginUiProjection,
            }))) };
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().readers[0]?.phase).toBe('current'));
        expect(rendered.getCurrent().readers[0]?.machineId).toBe(' machine-1 ');
        expect(rendered.getCurrent().readers.slice(1).every(reader => reader.phase === 'unavailable')).toBe(true);
        expect(rendered.getCurrent().union).toMatchObject({ phase: 'current', interactionEnabled: true });
        expect(projectionRuntime.describe.mock.calls.map(([machineId]) => machineId)).toEqual(['machine-1']);
        const settledReaders = rendered.getCurrent().readers;
        const settledPublications = publications;
        await act(async () => {
            setMachine({ active: true, daemonStateVersion: 1 });
        });
        await flushHookEffects();
        expect(rendered.getCurrent().readers.every((reader, index) => reader === settledReaders[index])).toBe(true);
        expect(publications).toBe(settledPublications);
        const rendersBeforeTelemetry = renders;
        for (let index = 0; index < 10; index += 1) {
            await act(async () => {
                setMachine({ active: true, daemonStateVersion: index + 2, daemonState: {
                    status: 'running', pid: 17, runtimeId: 'runtime-currentness', contributionRegistryProjectionRevision: 0,
                    resources: { cpu: { usage: index / 10 } },
                } });
            });
            await flushHookEffects();
        }
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        expect(rendered.getCurrent().readers.every((reader, index) => reader === settledReaders[index])).toBe(true);
        expect({ renders: renders - rendersBeforeTelemetry, publications: publications - settledPublications }).toEqual({ renders: 0, publications: 0 });
        await rendered.unmount();
    });

    it.each(['single', 'plural'] as const)('keeps a settled Machine snapshot stable while a second %s reader binds its Home', async (kind) => {
        const { useMachineCliDetectionTarget, useMachineCliDetectionTargets } = await import('@/sync/domains/state/storage');
        const errors = vi.spyOn(console, 'error');
        let showSecond!: () => void;
        let firstTarget: ReturnType<typeof useMachineCliDetectionTarget> | null = null;
        let secondTarget: ReturnType<typeof useMachineCliDetectionTarget> | null = null;
        function FirstReader() {
            firstTarget = useMachineCliDetectionTarget('machine-1', serverIdentityId);
            return null;
        }
        function SecondReader() {
            secondTarget = useMachineCliDetectionTarget('machine-1', serverIdentityId);
            return null;
        }
        function FirstPluralReader() {
            firstTarget = useMachineCliDetectionTargets(['machine-1'])['machine-1'] ?? null;
            return null;
        }
        function PluralReader() {
            secondTarget = useMachineCliDetectionTargets(['machine-1'])['machine-1'] ?? null;
            return null;
        }
        function Readers() {
            const [second, setSecond] = React.useState(false);
            showSecond = () => setSecond(true);
            return <>{kind === 'single' ? <FirstReader /> : <FirstPluralReader />}{second ? kind === 'single' ? <SecondReader /> : <PluralReader /> : null}</>;
        }
        const rendered = await renderWithAppProviders(<Readers />);
        try {
            await waitForHomeGovernance(() => expect(firstTarget?.isOnline).toBe(true));
            const settled = firstTarget;
            await act(async () => { showSecond(); });
            await waitForHomeGovernance(() => expect(secondTarget?.isOnline).toBe(true));
            expect(firstTarget).toBe(settled);
            expect(errors.mock.calls.filter(args => String(args[0]).includes('getSnapshot'))).toEqual([]);
        } finally {
            await rendered.unmount();
            errors.mockRestore();
        }
    });

    // This existing store contract needs the real Home binding now used by presence.
    it('projects a stable requested currentness set without subscribing to unrelated machines', async () => {
        const { useMachineCliDetectionTargets } = await import('@/sync/domains/state/storage');
        const onlineMachine = createMachineFixture({ id: 'm1', active: true, activeAt: 0, daemonStateVersion: 1 });
        const offlineMachine = createMachineFixture({ id: 'm3', active: false, activeAt: 0, daemonStateVersion: 3 });
        await act(async () => {
            storage.getState().applyMachines([onlineMachine, offlineMachine], true, { sourceServerId: connection!.home.id });
        });
        const hook = await renderHook(() => useMachineCliDetectionTargets(['m3', 'm1', 'm3']));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({
                m1: { daemonStateVersion: 1, isOnline: true },
                m3: { daemonStateVersion: 3, isOnline: false },
            }));
            const firstTargets = hook.getCurrent();
            await act(async () => {
                storage.getState().applyMachines([createMachineFixture({ id: 'm2', active: true, activeAt: 0 })], false,
                    { sourceServerId: connection!.home.id });
            });
            expect(hook.getCurrent()).toBe(firstTargets);
            await act(async () => {
                storage.getState().applyMachines([{ ...offlineMachine, active: true, activeAt: Date.now(), daemonStateVersion: 4 }], false,
                    { sourceServerId: connection!.home.id });
            });
            expect(hook.getCurrent()).toEqual({
                m1: { daemonStateVersion: 1, isOnline: true },
                m3: { daemonStateVersion: 4, isOnline: true },
            });
            expect(hook.getCurrent()).not.toBe(firstTargets);
            expect(hook.getCurrent().m1).toBe(firstTargets.m1);
        } finally {
            await hook.unmount();
        }
    });

    it('reports an unreachable AppShell machine as unavailable even while installation declarations are unproven', async () => {
        const scope = storage.getState().profileScope!;
        const materialization = { serverIdentityId, machineId: 'machine-1', materializationId: 'preview-install',
            pluginId: 'acme.preview', version: '1.0.0', sourceClass: 'registryPackage' as const,
            portableRelease: true, uiArtifacts: [], enabled: true, trustState: 'trusted' as const, observedAt: 1 };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [],
            materializations: [materialization], snapshots: [{ serverIdentityId, machineId: 'machine-1', materializations: [materialization] }] } });
        setMachine({ active: false });
        const snapshot: { current: ReturnType<typeof useAppShellPluginUiProjection> | null } = { current: null };
        function Probe() { snapshot.current = useAppShellPluginUiProjection(); return null; }
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Probe /></AppShellPluginUiProjectionProvider>);
        try {
            await flushHookEffects();
            expect(snapshot.current?.phase).toBe('unavailable');
            expect(snapshot.current?.interactionEnabled).toBe(false);
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
        } finally { await rendered.unmount(); clearPluginAccountAvailabilityProjection(); }
    });

    it('retains the AppShell catalog identity across real Machine presence updates with installed declarations', async () => {
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const scope = storage.getState().profileScope!;
        const materialization = {
            serverIdentityId, machineId: 'machine-1', materializationId: 'preview-install',
            pluginId: 'acme.preview', version: '1.0.0', sourceClass: 'registryPackage' as const,
            portableRelease: true, uiArtifacts: [], enabled: true, trustState: 'trusted' as const,
            observedAt: 1,
        };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [materialization],
            snapshots: [{ serverIdentityId, machineId: 'machine-1', materializations: [materialization] }],
        } });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Stable catalog'));
        const snapshot: { current: ReturnType<typeof useAppShellPluginUiProjection> | null } = { current: null };
        function Probe() {
            usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            snapshot.current = useAppShellPluginUiProjection();
            return null;
        }
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Probe /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(() => {
            expect(snapshot.current?.phase).toBe('current');
            expect(snapshot.current?.pluginUiProjection?.installedPackagesById['acme.preview']?.version).toBe('1.0.0');
        });
        const settledProjection = snapshot.current!.pluginUiProjection;
        expect(settledProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({ en: { title: 'Stable catalog' } });
        await act(async () => {
            const machine = storage.getState().machines['machine-1']!;
            storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: connection!.home.id });
        });
        await flushHookEffects();
        expect(snapshot.current!.pluginUiProjection).toBe(settledProjection);
        const projectionWork = vi.spyOn(await import('./projectionUnion'), 'mergeInstalledPluginUiProjections');
        try {
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                    availabilityCursor: 2, intentReads: [], materializations: [materialization],
                    snapshots: [{ serverIdentityId, machineId: 'machine-1', materializations: [materialization] }],
                } });
            });
            await flushHookEffects();
            expect(snapshot.current!.pluginUiProjection).toBe(settledProjection);
            expect(projectionWork).not.toHaveBeenCalled();
        } finally { projectionWork.mockRestore(); }
        await rendered.unmount();
        clearPluginAccountAvailabilityProjection();
    });

    it('bounds stationary Home acquisition to distinct presented targets among 172 Machines', async () => {
        const ids = ['machine-1', ...Array.from({ length: 171 }, (_, index) => `machine-peer-${index}`)];
        const presentedIds = ids.slice(0, 2);
        const base = storage.getState().machines['machine-1']!;
        const daemonState = { status: 'running', pid: 17, runtimeId: 'fleet-runtime', contributionRegistryProjectionRevision: 0 };
        storage.getState().applyMachines(ids.map(id => createMachineFixture({ ...base, id, activeAt: 0,
            daemonStateVersion: 2, daemonState })), true,
            { sourceServerId: connection!.home.id });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected real fleet Account lifetime');
        captureMachinePresenceObservation(lifetime.scope)(ids);
        const materializations = ids.map(machineId => ({ serverIdentityId, machineId,
            materializationId: `installed-${machineId}`, pluginId: 'acme.preview', version: '1.0.0',
            sourceClass: 'registryPackage' as const, portableRelease: true, uiArtifacts: [], enabled: true,
            trustState: 'trusted' as const, observedAt: 1 }));
        const publishAvailability = (availabilityCursor: number) => {
            const reports = materializations.map(row => ({ ...row, observedAt: availabilityCursor + 1 }));
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor, intentReads: [], materializations: reports,
                snapshots: reports.map(row => ({ serverIdentityId, machineId: row.machineId, materializations: [row] })),
            } });
        };
        publishAvailability(0);
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Fleet catalog'));
        const snapshots = new Map<string, ReturnType<typeof usePluginUiProjectionCurrentness>>();
        const shell: { current: ReturnType<typeof useAppShellPluginUiProjection> | null } = { current: null };
        function ShellProbe() { shell.current = useAppShellPluginUiProjection(); return null; }
        function MachineProbe({ machineId }: { machineId: string }) {
            snapshots.set(machineId, usePluginUiProjectionCurrentness({ machineId, serverId: serverIdentityId }));
            return null;
        }
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <ShellProbe />
            {presentedIds.flatMap(machineId => [0, 1].map(reader => (
                <MachineProbe key={`${machineId}:${reader}`} machineId={machineId} />
            )))}
        </AppShellPluginUiProjectionProvider>);
        const stringify = vi.spyOn(JSON, 'stringify');
        const readDescriptors = Object.getOwnPropertyDescriptors;
        const strictWalks: { count: number; firstStack: string | null } = { count: 0, firstStack: null };
        // Observe the actual strict walker through its reflection boundary;
        // Vitest and other owners also inspect descriptors, independently.
        const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation(value => {
            const stack = new Error().stack ?? '';
            if (stack.includes('walkStrictPluginJsonValue')) {
                strictWalks.count++;
                strictWalks.firstStack ??= stack;
            }
            return readDescriptors(value);
        });
        const originEquality = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
        const originComparisons = vi.spyOn(originEquality, 'arePluginMachineExecutionOriginsEqual');
        const cacheSerializations = () => stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
            && (Object.hasOwn(value, `${serverIdentityId}:machine-1`)
                || ('translationBundleRefs' in value && 'translationBundles' in value))).length;
        try {
            await waitForHomeGovernance(() => {
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length);
                expect(presentedIds.every(id => snapshots.get(id)?.phase === 'current')).toBe(true);
                expect(shell.current?.phase).toBe('current');
            });
            const settled = new Map(snapshots);
            const revisions = new Map(ids.map(machineId => [machineId,
                getMachineContributionRegistryProjectionRevision({ machineId, serverId: serverIdentityId })]));
            stringify.mockClear(); strictWalks.count = 0; strictWalks.firstStack = null; originComparisons.mockClear();
            vi.useFakeTimers();
            const timers = installTimerCensus(stack => stack.includes('usePluginUiProjectionCurrentness.ts') ? 'projection' : null);
            try {
                const currentnessGets = () => harness.requests.filter(request => request.path === '/v1/account/encryption/currentness').length;
                const initialGets = currentnessGets();
                for (let minute = 0; minute < 3; minute++) {
                    await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1, turns: 2 });
                    expect(cacheSerializations()).toBe(0);
                    expect(strictWalks.count, strictWalks.firstStack ?? undefined).toBe(0);
                    expect(originComparisons).not.toHaveBeenCalled();
                }
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length);
                expect(currentnessGets()).toBe(initialGets);
                expect(timers.read().filter(timer => timer.consumer === 'projection')).toEqual([]);
                expect(vi.getTimerCount()).toBe(timers.read().length);
            } finally { timers.stop(); vi.useRealTimers(); }
            // Real store ingress, including advancing transport carriers and
            // observation clocks, must not manufacture projection invalidations.
            for (let arrival = 0; arrival < 24; arrival++) {
                await act(async () => {
                    storage.getState().applyMachines(ids.map(id => createMachineFixture({ ...base, id, activeAt: 0,
                        updatedAt: arrival + 2, daemonStateVersion: arrival + 3,
                        availability: { kind: 'available' },
                        daemonState: { ...daemonState, resources: { cpu: { usage: arrival / 24 } } },
                    })), false, { sourceServerId: connection!.home.id });
                    publishAvailability(arrival + 1);
                });
                await flushHookEffects();
            }
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length);
            expect(ids.every(machineId => getMachineContributionRegistryProjectionRevision({ machineId,
                serverId: serverIdentityId }) === revisions.get(machineId))).toBe(true);
            for (let arrival = 0; arrival < 157; arrival++) {
                await act(async () => { storage.setState(state => ({ sessions: { ...state.sessions } })); });
            }
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length);
            expect(ids.every(id => snapshots.get(id) === settled.get(id))).toBe(true);
            stringify.mockClear(); strictWalks.count = 0; strictWalks.firstStack = null; originComparisons.mockClear();
            projectionRuntime.describe.mockResolvedValue(supportedProjection('Changed Machine'));
            await act(async () => {
                const current = storage.getState().machines['machine-1']!;
                storage.getState().applyMachines([{ ...current, daemonStateVersion: current.daemonStateVersion + 1,
                    daemonState: { ...daemonState, contributionRegistryProjectionRevision: 1 },
                }], false, { sourceServerId: connection!.home.id });
            });
            await waitForHomeGovernance(() => {
                expect(snapshots.get('machine-1')?.pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                    .toEqual({ en: { title: 'Changed Machine' } });
            });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length + 1);
            // Positive control: a real changed projection still traverses its
            // new ingress and encodes exactly one retained cache replacement.
            expect(cacheSerializations()).toBe(1);
            expect(strictWalks.count).toBeGreaterThan(0);
            expect(ids.slice(1).every(id => snapshots.get(id) === settled.get(id))).toBe(true);
            await act(async () => { shell.current!.reloadConnectedAccountProjection(); });
            await flushHookEffects();
            // Explicit Retry revalidates the mounted targets, not the entire
            // Home census and not merely the AppShell observer's local key.
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(presentedIds.length * 2 + 1);
        } finally {
            stringify.mockRestore(); descriptors.mockRestore(); originComparisons.mockRestore();
            await rendered.unmount(); clearPluginAccountAvailabilityProjection();
        }
    });

    it('does no AppShell machine projection work for unrelated Account store publications', async () => {
        const catalog = (title: string) => {
            const base = projection(title);
            const row = base.familiesById.pluginUi!.entriesById['translations:acme.preview']!;
            return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
                ...base, familiesById: { pluginUi: { ...base.familiesById.pluginUi,
                    entriesById: Object.fromEntries(Array.from({ length: 66 }, (_, index) => {
                        const pluginId = index === 0 ? 'acme.preview' : `acme.preview-${index}`;
                        return [`translations:${pluginId}`, { ...row, id: `translations:${pluginId}`, pluginId }];
                    })),
                } },
            } });
        };
        projectionRuntime.describe.mockResolvedValue(catalog('Stable catalog'));
        const presence = await import('@/utils/sessions/machineUtils');
        const unions = await import('./projectionUnion');
        // Observe real computation without replacing internal domain decisions.
        const membershipWork = vi.spyOn(presence, 'isMachineOnline');
        const unionFactory = vi.spyOn(unions, 'createPluginUiProjectionUnionPublication');
        const snapshots: ReturnType<typeof useAppShellPluginUiProjection>[] = [];
        function Probe() {
            usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            snapshots.push(useAppShellPluginUiProjection());
            return null;
        }
        let typeDraft: (value: string) => void = () => { throw new Error('Editor is not mounted'); };
        function Editor() {
            const [draft, setDraft] = React.useState('');
            typeDraft = setDraft;
            return <AppShellPluginUiProjectionProvider><Probe />{draft}</AppShellPluginUiProjectionProvider>;
        }
        const rendered = await renderWithAppProviders(<Editor />);
        let restorePublications = () => {};
        try {
            await waitForHomeGovernance(() => expect(snapshots.at(-1)?.phase).toBe('current'));
            await flushHookEffects();
            const settled = snapshots.at(-1);
            expect(settled?.pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                .toEqual({ en: { title: 'Stable catalog' } });
            membershipWork.mockClear();
            const publicationWork = unionFactory.mock.results.flatMap(result => result.type === 'return'
                ? [vi.spyOn(result.value, 'publish')] : []);
            restorePublications = () => { for (const work of publicationWork) work.mockRestore(); };
            expect(publicationWork.length).toBeGreaterThan(0);
            const publications = snapshots.length;
            const describes = projectionRuntime.describe.mock.calls.length;
            for (let arrival = 0; arrival < 24; arrival++) {
                await act(async () => {
                    storage.setState(state => ({ sessions: { ...state.sessions } }));
                    storage.setState(state => ({ settings: { ...state.settings, showLineNumbers: !state.settings.showLineNumbers } }));
                    typeDraft(`draft ${arrival}`);
                });
                await flushHookEffects();
            }
            expect(snapshots.at(-1)).toBe(settled);
            // The editor renders its own child, so observe catalog publications
            // by identity; the real union/acquisition counts must stay zero.
            expect(new Set(snapshots.slice(publications - 1))).toEqual(new Set([settled]));
            for (const work of publicationWork) expect(work).not.toHaveBeenCalled();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(describes);
            expect(membershipWork).not.toHaveBeenCalled();
            projectionRuntime.describe.mockResolvedValue(catalog('Updated catalog'));
            await act(async () => { invalidateProjection(); });
            await waitForHomeGovernance(() => {
                expect(snapshots.at(-1)?.pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                    .toEqual({ en: { title: 'Updated catalog' } });
            });
        } finally {
            await rendered.unmount();
            membershipWork.mockRestore();
            restorePublications();
            unionFactory.mockRestore();
        }
    });

    it('keeps shared Triage facts quiet across cached qualified Session A to B to A mounts and publishes one real change', async () => {
        const { sessionAddressKey } = await import('@/sync/domains/session/sessionAddress');
        const { subscribeDaemonMergedProjectionSummary } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const unions = await import('./projectionUnion');
        const factory = vi.spyOn(unions, 'createPluginUiProjectionUnionPublication');
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Triage'));
        const sessionSnapshots = new Map<string, ReturnType<typeof usePluginUiProjectionCurrentness>>();
        const mounts: string[] = [];
        function SessionDemand({ sessionId }: { sessionId: string }) {
            sessionSnapshots.set(sessionId, usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId }));
            React.useEffect(() => { mounts.push(sessionId); }, [sessionId]);
            return null;
        }
        let renders = 0;
        let triage: ReturnType<typeof useAppShellPluginUiProjection>['pluginUiProjection'] = null;
        function Triage() {
            renders++;
            triage = useAppShellPluginUiProjection().pluginUiProjection;
            return null;
        }
        let selectSession: (sessionId: string) => void = () => { throw new Error('Session route is not mounted'); };
        function SessionRoute() {
            const [sessionId, setSessionId] = React.useState('session-a');
            selectSession = setSessionId;
            return <SessionDemand key={sessionAddressKey({ serverId: serverIdentityId, sessionId })} sessionId={sessionId} />;
        }
        const notifications = vi.fn();
        const unsubscribe = subscribeDaemonMergedProjectionSummary({ serverId: serverIdentityId, machineId: 'machine-1' }, notifications);
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Triage /><SessionRoute /></AppShellPluginUiProjectionProvider>);
        let restorePublications = () => {};
        try {
            await waitForHomeGovernance(() => expect(triage?.translationsByPluginId['acme.preview']?.bundles).toEqual({ en: { title: 'Triage' } }));
            await flushHookEffects();
            await act(async () => { selectSession('session-b'); });
            await flushHookEffects();
            await act(async () => { selectSession('session-a'); });
            await flushHookEffects();
            const settled = triage;
            const initialRenders = renders;
            const reads = projectionRuntime.describe.mock.calls.length;
            notifications.mockClear();
            const work = factory.mock.results.flatMap(result => result.type === 'return' ? [vi.spyOn(result.value, 'publish')] : []);
            restorePublications = () => { for (const publication of work) publication.mockRestore(); };
            expect(work.length).toBeGreaterThan(0);
            for (let repeat = 0; repeat < 12; repeat++) {
                await act(async () => { selectSession('session-b'); });
                await flushHookEffects();
                await act(async () => { selectSession('session-a'); });
                await flushHookEffects();
            }
            expect(mounts).toHaveLength(27);
            expect(sessionSnapshots.get('session-a')?.machineId).toBe('machine-1');
            expect(sessionSnapshots.get('session-b')?.serverId).toBe(serverIdentityId);
            expect(triage).toBe(settled);
            expect(notifications).toHaveBeenCalledTimes(0);
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(reads);
            for (const publication of work) expect(publication).toHaveBeenCalledTimes(0);
            expect(renders - initialRenders).toBe(0);
            projectionRuntime.describe.mockResolvedValue(supportedProjection('Changed Triage'));
            await act(async () => {
                await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-1', serverId: serverIdentityId,
                    accountLifetime: captureActiveServerAccountScopeLifetime(), reuseFreshReady: false });
            });
            await waitForHomeGovernance(() => expect(triage?.translationsByPluginId['acme.preview']?.bundles).toEqual({ en: { title: 'Changed Triage' } }));
            expect(notifications).toHaveBeenCalledTimes(1);
            expect(work.reduce((count, publication) => count + publication.mock.calls.length, 0)).toBe(1);
            expect(renders - initialRenders).toBe(1);
        } finally {
            unsubscribe();
            await rendered.unmount();
            restorePublications();
            factory.mockRestore();
        }
    });

    it('reports an answered unsupported projection as unavailable', async () => {
        projectionRuntime.describe.mockResolvedValueOnce({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'unavailable',
            pluginUiProjection: null,
            interactionEnabled: false,
            unavailableReasonCode: 'plugin_daemon_unsupported',
        });
    });

    it('keeps an invalid daemon response distinct from machine reachability and clears it on recovery', async () => {
        projectionRuntime.describe.mockResolvedValue({ supported: true, projection: { invalid: true } });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1', serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({
            phase: 'unavailable', interactionEnabled: false, unavailableReasonCode: 'plugin_daemon_invalid_response',
        });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Recovered catalog'));
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: serverIdentityId }, 'authority'); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        expect(rendered.getCurrent().unavailableReasonCode).toBeUndefined();
    });

    it('fails closed when the answer to an authority change is invalid, and keeps a refused refresh current', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Catalog'))
            .mockResolvedValueOnce({ supported: true, projection: { invalid: true } })
            .mockResolvedValueOnce(supportedProjection('Catalog'))
            .mockResolvedValueOnce({ supported: true, projection: { invalid: true } });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        // A new authority answered invalidly: the old projection admits nothing.
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: serverIdentityId }, 'authority'); });
        await waitForHomeGovernance(() => expect(projectionRuntime.describe).toHaveBeenCalledTimes(2));
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ interactionEnabled: false, unavailableReasonCode: 'plugin_daemon_invalid_response' });
        // Recovery, then a same-authority refresh that answers invalidly keeps the last-good projection.
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: serverIdentityId }, 'authority'); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: serverIdentityId }, 'refresh'); });
        await waitForHomeGovernance(() => expect(projectionRuntime.describe).toHaveBeenCalledTimes(4));
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });
    });

    it('fences a retired projection without updating another component during Account capture in render', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Account A'))
            .mockImplementationOnce(() => new Promise(() => {}));
        const snapshot: { current: ReturnType<typeof usePluginUiProjectionCurrentness> | null } = { current: null };
        function ProjectionOwner() {
            snapshot.current = usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            return null;
        }
        function AccountScopeReader(props: Readonly<{ capture: boolean }>) {
            if (props.capture) captureActiveServerAccountScopeLifetime();
            return null;
        }
        function AvailabilityObserver() {
            useActivePluginAccountAvailabilityReader();
            return null;
        }
        const accountA = storage.getState().profileScope!;
        replacePluginAccountAvailabilityProjection({
            scope: accountA,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        });
        const accountAReader = readPluginAccountAvailability(accountA);
        const surface = (capture: boolean) => <>
            <AccountScopeReader capture={capture} />
            <PluginPageLaunchInputScope target={{ kind: 'app' }} pluginUiProjection={null}>
                <ProjectionOwner />
                <AvailabilityObserver />
            </PluginPageLaunchInputScope>
        </>;
        const rendered = await renderWithAppProviders(surface(false));
        await waitForHomeGovernance(() => expect(snapshot.current?.interactionEnabled).toBe(true));

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            // A real credential replacement and Sync publication retire both
            // A's exact-Home projection and its active Account reader. A sibling
            // may then capture B during render without updating another owner.
            await act(async () => {
                await switchAccount('account-b');
                await rendered.update(surface(true));
            });

            await act(async () => {
                await (await import('@/sync/sync')).sync.refreshPluginAccountAvailability();
            });

            const accountB = captureActiveServerAccountScopeLifetime()?.scope;
            expect(accountB?.accountId).toBe('account-b');
            if (!accountB) throw new Error('The successor Account lifetime was not admitted');
            expect(readPluginAccountAvailability(accountB).readMaterializations()).toMatchObject({
                kind: 'available', availabilityCursor: 0,
            });
            expect(snapshot.current?.interactionEnabled).toBe(false);
            expect(snapshot.current?.connectedAccountProjection).toBeNull();
            expect(accountAReader.readMaterializations()).toEqual({
                kind: 'unavailable', code: 'account_availability_scope_mismatch',
            });
            expect(errors.mock.calls.filter((args) => args.some((value) => (
                typeof value === 'string' && value.includes('Cannot update a component')
            )))).toEqual([]);
            await rendered.unmount();
        } finally {
            errors.mockRestore();
            clearPluginAccountAvailabilityProjection();
        }
    });

    it('retires a same-server Account projection before the successor Account can become interactive', async () => {
        let resolveAccountB!: (value: ReturnType<typeof supportedProjection>) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Account A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveAccountB = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().phase).toBe('current');

        expect(rendered.getCurrent().connectedAccountProjection).toEqual({ kind: 'ready', descriptors: [] });

        await act(async () => { await switchAccount('account-b'); });

        // A selected surface can only expose Resource methods while this
        // projection is current. Account A's descriptor must therefore be
        // unavailable even though Account B uses the same server and machine.
        expect(rendered.getCurrent().pluginUiProjection?.generation).toBeNull();
        expect(rendered.getCurrent().pluginUiProjection?.surfacePlacementsById).toEqual({});
        expect(rendered.getCurrent().pluginBrowserProjection).toBeNull();
        expect(rendered.getCurrent().connectedAccountProjection).toBeNull();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).not.toBe('current');
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);


        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.generation).toBe(41);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account B' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
        expect(rendered.getCurrent().phase).toBe('current');
    });

    it('discards a late Account A re-description after retirement instead of republishing it into Account B', async () => {
        let resolveRetiredAccountA!: (value: unknown) => void;
        let resolveAccountB!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Account A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveRetiredAccountA = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveAccountB = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account A' },
        });

        // Account A starts a replacement describe, then retires before that
        // request returns. The replacement uses the same server, machine, and
        // daemon generation, so only the captured Account lifetime can fence it.
        await act(async () => {
            invalidateProjection();
        });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        await act(async () => { await switchAccount('account-b'); });
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'establishing',
            interactionEnabled: false,
        });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveRetiredAccountA(supportedProjection('Late Account A'));
        });
        await flushHookEffects();

        expect(rendered.getCurrent().phase).toBe('establishing');
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']).toBeUndefined();
        expect(rendered.getCurrent().connectedAccountProjection).toBeNull();

        await act(async () => {
            resolveAccountB(supportedProjection('Account B'));
        });
        await flushHookEffects();

        expect(rendered.getCurrent()).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
        });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Account B' },
        });
    });

    it('stays current through the supervisor\'s own teardown and re-reads on resume, while a real loss still withdraws', async () => {
        const { bindEndpointConnectivityStateToRealtimeStore } = await import('@/sync/runtime/connectivity/bindManagedConnectionStateToRealtimeStore');
        let publish: (state: Parameters<Parameters<Parameters<typeof bindEndpointConnectivityStateToRealtimeStore>[0]['subscribe']>[0]>[0]) => void = () => {};
        const detach = bindEndpointConnectivityStateToRealtimeStore({ subscribe: listener => { publish = listener; return () => {}; } });
        const state = (phase: 'online' | 'shutting_down' | 'connecting' | 'offline', lastConnectedAt: number) => ({ phase, reason: null, attempt: 0,
            nextRetryAt: null, lastConnectedAt, lastDisconnectedAt: null, lastErrorMessage: null });
        await act(async () => { publish(state('online', 1)); });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Before hide'));
        const phases: string[] = [];
        const rendered = await renderHook(() => {
            const value = usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            phases.push(value.phase);
            return value;
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().interactionEnabled).toBe(true));
        const settled = rendered.getCurrent().pluginUiProjection;
        phases.length = 0;
        const reads = projectionRuntime.describe.mock.calls.length;
        // Hide, then resume: the supervisor's teardown says nothing about the Home or its Machines.
        await act(async () => { publish(state('shutting_down', 1)); });
        await act(async () => { publish(state('connecting', 1)); });
        expect(phases.filter(phase => phase !== 'current')).toEqual([]);
        expect(projectionRuntime.describe.mock.calls.length).toBe(reads);
        await act(async () => { publish(state('online', 2)); });
        await waitForHomeGovernance(() => expect(projectionRuntime.describe.mock.calls.length).toBeGreaterThan(reads));
        expect(phases.filter(phase => phase !== 'current')).toEqual([]);
        expect(rendered.getCurrent().pluginUiProjection).toBe(settled);
        // A connection that dropped on its own is evidence: reconnecting withdraws, as does offline.
        await act(async () => { publish(state('connecting', 2)); });
        expect(rendered.getCurrent()).toMatchObject({ interactionEnabled: false, unavailableReasonCode: 'plugin_machine_unreachable' });
        await act(async () => { publish(state('online', 3)); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().interactionEnabled).toBe(true));
        await act(async () => { publish(state('shutting_down', 3)); publish(state('offline', 3)); });
        expect(rendered.getCurrent()).toMatchObject({ interactionEnabled: false, unavailableReasonCode: 'plugin_machine_unreachable' });
        detach();
        await rendered.unmount();
    });

    it('recovers a same-Home origin projection after transient Home loss only when its Machine is freshly observed', async () => {
        const { withdrawMachinePresenceForScope, resolveMachineReachability,
            clearMachineRequestReachabilityForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Recovered origin'));
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1', serverId: serverIdentityId,
        }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().interactionEnabled).toBe(true));
        const machine = storage.getState().machines['machine-1']!;
        expect(machine.active).toBe(true);

        await act(async () => {
            withdrawMachinePresenceForScope(scope);
            storage.setState({ endpointStatus: 'offline' });
        });
        expect(rendered.getCurrent()).toMatchObject({ interactionEnabled: false,
            unavailableReasonCode: 'plugin_machine_unreachable' });
        await act(async () => {
            storage.setState({ endpointStatus: 'online' });
            clearMachineRequestReachabilityForScope(scope);
            publishMachineContributionRegistryProjectionRefresh(serverIdentityId);
        });
        // The live failure's connected endpoint + active retained row does not
        // establish a fresh Machine observation after this device's outage.
        expect(storage.getState().machines['machine-1']).toBe(machine);
        expect(resolveMachineReachability(scope, machine)).toBe('unknown');
        expect(rendered.getCurrent()).toMatchObject({ interactionEnabled: false,
            unavailableReasonCode: 'plugin_machine_unreachable' });

        await act(async () => { observeMachinePresenceForTest({ ...scope, accountId: 'another-account' }, [machine.id]); });
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        // A genuine same-Home ingress uses this canonical witness after its row
        // publication. The witness push alone must re-admit the mounted reader.
        await act(async () => { observeMachinePresenceForTest(scope, [machine.id]); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent()).toMatchObject({
            phase: 'current', interactionEnabled: true,
        }));
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
            .toEqual({ en: { title: 'Recovered origin' } });
        await rendered.unmount();
    });

    it('replaces an equal-generation projection after reconnect and fences a late prior authority', async () => {
        let resolvePriorAuthority!: (value: unknown) => void;
        let resolveReconnectedAuthority!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Authority A'))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolvePriorAuthority = resolve;
            }))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveReconnectedAuthority = resolve;
            }));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority A' },
        });

        await act(async () => {
            invalidateProjection();
        });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

        await act(async () => {
            storage.setState({ endpointStatus: 'offline' });
            setMachine({ active: false });
        });
        await rendered.rerender();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).toBe('retainedOffline');

        // A socket reconnect advances every machine's projection revision
        // (`publishMachineContributionRegistryProjectionRefresh`), so the
        // one owner issues a fresh read instead of joining the prior flight.
        await act(async () => {
            storage.setState({ endpointStatus: 'online' });
            setMachine({ active: true });
            publishMachineContributionRegistryProjectionRefresh();
        });
        await rendered.rerender();
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);

        await act(async () => {
            resolveReconnectedAuthority(supportedProjection('Authority B'));
        });
        await flushHookEffects();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority B' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);

        await act(async () => {
            resolvePriorAuthority(supportedProjection('Late Authority A'));
        });
        await flushHookEffects();
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Authority B' },
        });
    });

    it.each([
        { sourceKind: 'bundled', demand: 'picker', presentation: 'chip', failed: false },
        { sourceKind: 'bundled', demand: 'event-picker', presentation: 'chip', failed: false },
        { sourceKind: 'bundled', demand: 'event-picker-selected', presentation: 'chip', failed: false },
        { sourceKind: 'bundled', demand: 'event-catalog-loading', presentation: 'chip', failed: false },
        { sourceKind: 'bundled', demand: 'event-catalog-ready', presentation: 'chip', failed: false },
        { sourceKind: 'development', demand: 'picker', presentation: 'section', failed: true },
        { sourceKind: 'development', demand: 'selected', presentation: 'chip', failed: false },
        { sourceKind: 'development', demand: 'selected-cold', presentation: 'chip', failed: false },
        { sourceKind: 'development', demand: 'project', presentation: 'chip', failed: false },
        { sourceKind: 'development', demand: 'project-missing', presentation: 'chip', failed: false },
    ] as const)('acquires a $sourceKind source through the real Run-on picker or selected target ($demand/$presentation, prior timeout: $failed)', async ({ sourceKind, demand, presentation, failed: priorFailure }) => {
        const projectDemand = demand === 'project' || demand === 'project-missing';
        const eventPicker = demand === 'event-picker' || demand === 'event-picker-selected';
        const eventCatalog = demand === 'event-catalog-loading' || demand === 'event-catalog-ready';
        const coldRead = demand === 'selected-cold';
        const unrelatedReply = coldRead || eventCatalog ? (await import('@/dev/testkit')).createDeferred<void>() : null;
        const unrelatedAbort = new AbortController();
        const projectReply = projectDemand ? (await import('@/dev/testkit')).createDeferred<void>() : null;
        const eventReply = eventPicker ? (await import('@/dev/testkit')).createDeferred<void>() : null;
        const catalogReply = demand === 'event-catalog-loading' ? createDeferred<void>() : null;
        const { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionOriginRef } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
        const { usePluginSurfaceExecutionOrigin } = await import('@/components/plugins/surfaces/pluginSurfaceExecutionOrigin');
        const { PluginMachineExecutionOriginSelectorView } = await import('@/components/settings/machines/PluginMachineExecutionOriginSelector');
        const { readObservedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { getPluginExecutionOriginCandidateOrigin, isPluginMachineExecutionOriginCandidateSelectable } = await import('@/sync/domains/machines/administration/pluginExecutionOrigin');
        const pluginId = 'acme.external-source';
        const sourceCustody = sourceKind === 'bundled'
            ? { kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/external-source' } }
            : { kind: 'development' as const, registeredRootId: 'external-root' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: 'machine-1', pluginId, sourceCustody } });
        const { DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const event = DaemonContributionRegistryProjectionAutomationEligibleEventV1Schema.parse({
            event: { id: `${pluginId}/changed`, identity: { pluginId, localId: 'changed' }, occurrenceId: 'external-occurrence',
                sourceCustody, title: 'Source changed', description: null,
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema: { type: 'object' },
                    setupActionRef: { pluginId, localId: 'setup' } } } },
            setupAction: { id: `${pluginId}/setup`, identity: { pluginId, localId: 'setup' }, occurrenceId: 'external-occurrence',
                title: 'Choose source', description: null, inputSchema: { type: 'object' }, inputHints: null },
            observationBinding: { executionOrigin, materializationRef: { machineId: 'machine-1', pluginId,
                materializationId: `daemon-selected:${pluginId}` } },
        });
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projectionDigest: 'a'.repeat(64),
            ...(eventCatalog ? { automationEligibleEvents: [event] } : {}),
            projection: { v: 2, generation: 1, installedPackagesById: demand === 'project-missing' ? {} : { [pluginId]: {
                id: pluginId, displayName: 'External source', version: '0.0.0', enabled: true,
                source: { kind: sourceKind === 'bundled' ? 'bundled' : 'localPath', locator: pluginId },
                occurrenceId: 'external-occurrence', sourceCustody, executionOrigin,
                executionTarget: { default: 'installation' },
            } }, settingsById: {}, agentsById: {} } });
        const deferred = buildDeferredDaemonProjectionSections(response);
        const peerMachineId = 'ready-peer';
        const peerOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: peerMachineId, pluginId, sourceCustody } });
        const peerResponse = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projectionDigest: 'a'.repeat(64),
            projection: { v: 2, generation: 1, installedPackagesById: { [pluginId]: {
                id: pluginId, displayName: 'External source', version: '0.0.0', enabled: true,
                source: { kind: sourceKind === 'bundled' ? 'bundled' : 'localPath', locator: pluginId },
                occurrenceId: 'ready-peer-occurrence', sourceCustody, executionOrigin: peerOrigin,
                executionTarget: { default: 'installation' },
            } }, settingsById: {}, agentsById: {} } });
        const peerDeferred = buildDeferredDaemonProjectionSections(peerResponse);
        const sectionQuestions: string[] = [];
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Account fixture must establish a lifetime');
        const scope = { machineId: 'machine-1', serverId: serverIdentityId, accountLifetime: lifetime };
        // Idle endpoint recovery may refetch the real census. These source
        // acquisition cases retain their external Machine, unlike presence-
        // withdrawal cases that intentionally separate census and store facts.
        answerCurrentMachineCensus();
        if (eventReply) {
            const machine = storage.getState().machines['machine-1']!;
            const peer = createMachineFixture({ ...machine, id: peerMachineId });
            storage.getState().applyMachines([peer], false, { sourceServerId: connection!.home.id });
            harness.answer(homeId, '/v1/machines', { body: [machine, peer].map(machine =>
                createPlainMachineRowFixture({ id: machine.id, accountId: lifetime.scope.accountId, machine })) });
        }
        const project = projectDemand ? (await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture')).createPluginProjectContextFixture({ id: 'cold-project',
            serverId: connection!.home.id, machineId: 'machine-1' }).target : undefined;
        let presented = !projectDemand;
        let restoreClock = () => {};
        if (priorFailure) {
            projectionRuntime.describe.mockRejectedValueOnce(Object.assign(new Error('Connection timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));
            const failed = await loadDaemonMergedProjectionCacheEntry({ ...scope, sections: [], shareRetryCadence: true });
            expect(failed).toMatchObject({ kind: 'error', reason: 'timeout', retryAttempt: 0 });
            if (failed?.kind !== 'error' || failed.retryAtMs === null) throw new Error('Expected a retryable transport failure');
            const now = vi.spyOn(Date, 'now').mockReturnValue(failed.retryAtMs + 1);
            restoreClock = () => now.mockRestore();
            expect(readObservedDaemonMergedProjectionCacheEntry({ ...scope, sections: [] })).toBe(failed);
        }
        projectionRuntime.describe.mockImplementation(async (readMachineId, options) => {
            if (projectReply) await projectReply.promise;
            if (eventReply && readMachineId !== peerMachineId) await eventReply.promise;
            if (catalogReply) await catalogReply.promise;
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Source acquisition must use the shared UI projection');
            if (request.sectionRead) {
                sectionQuestions.push(request.sectionRead.digest, ...request.sectionRead.includeDigests ?? []);
                if (coldRead || eventCatalog) {
                    if (request.sectionRead.digest === deferred.manifest.sections.settingsById) await unrelatedReply!.promise;
                    if (coldRead) await new Promise(resolve => setTimeout(resolve, 25));
                }
            }
            const selected = readMachineId === peerMachineId ? peerDeferred : deferred;
            return request.sectionRead ? selected.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests?.filter(digest => !(coldRead || eventCatalog) || digest !== deferred.manifest.sections.settingsById)) : selected.manifest;
        });
        const rawMaterializations = projectDemand ? [] : [{ serverIdentityId, machineId: 'machine-1',
                materializationId: `daemon-selected:${pluginId}`, pluginId, version: '0.0.0',
                sourceClass: sourceKind === 'bundled' ? 'bundledFirstParty' : 'localPath', portableRelease: false,
                enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] }];
        const { PluginAvailabilityMaterializationsReadActionOutputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema,
            PluginAccountAvailabilityIntentReadResponseV1Schema, PluginMachineMaterializationV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const materializations = rawMaterializations.map(value => PluginMachineMaterializationV1Schema.parse(value));
        if (eventReply) materializations.push(PluginMachineMaterializationV1Schema.parse({ ...rawMaterializations[0]!,
            machineId: peerMachineId }));
        // The first real AppShell demand may bootstrap Availability after this
        // fixture is installed. Its HTTP producer must describe the same rows.
        harness.answer(homeId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
            ...(catalogReply ? { respondAfter: catalogReply.promise } : {}),
            body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                snapshots: materializations.map(materialization => ({ serverIdentityId, machineId: materialization.machineId,
                    materializations: [materialization] })) }),
        });
        harness.answer(homeId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`, {
            ...(catalogReply ? { respondAfter: catalogReply.promise } : {}),
            body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                intentReads: materializations.length ? [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [],
                }) }] : [], failedPluginIds: [] }),
        });
        if (catalogReply) clearPluginAccountAvailabilityProjection();
        else replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations, snapshots: [],
        } });
        if (eventReply) {
            const { PLUGIN_UI_SECTIONS } = await import('./usePluginUiProjectionCurrentness');
            await loadDaemonMergedProjectionCacheEntry({ ...scope, machineId: peerMachineId, sections: PLUGIN_UI_SECTIONS });
        }
        if (demand === 'selected' || coldRead) {
            const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
            const settings = storage.getState().settings;
            storage.setState({ settings: { ...settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference(settings.machineAdministrationTargetsLocalV1, pluginId, executionOrigin) } });
        }
        let selection: ReturnType<typeof usePluginSurfaceExecutionOrigin>['selection'] | undefined;
        let execution: ReturnType<typeof usePluginSurfaceExecutionOrigin> | undefined;
        let eventComposer: ReturnType<typeof usePluginEventAutomationComposer> | undefined;
        const { publishDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const eventInputs = { ...publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse(response.projection),
            automationEligibleEvents: [event] }), registryDiagnostics: [] };
        function EventPicker() {
            eventComposer = usePluginEventAutomationComposer({ machineId: demand === 'event-picker-selected' ? 'machine-1' : null, serverId: homeId,
                projectionPhase: demand === 'event-picker-selected' ? 'ready' : 'loading',
                projectionInputs: demand === 'event-picker-selected' ? eventInputs : null,
                initialEventRef: event.event.identity });
            return <PluginEventAutomationComposerContent model={eventComposer} />;
        }
        function Picker() {
            if (eventCatalog) return <PluginEventAutomationEditor automationId="catalog-draft" clientId="event-draft"
                value={null} seed={null} authoringMachineId="machine-1" serverId={homeId}
                initialEventRef={event.event.identity}
                onComplete={() => {}} onCancel={() => {}} />;
            if (eventPicker) return <EventPicker />;
            const shell = useAppShellPluginUiProjection();
            execution = usePluginSurfaceExecutionOrigin({ pluginId, projection: shell.pluginUiProjection,
                enabled: presented, surfaceTarget: project });
            selection = execution.selection;
            return <PluginMachineExecutionOriginSelectorView selection={selection} presentation={presentation} testIDPrefix="source-acquisition" />;
        }
        const beforeOpen = projectionRuntime.describe.mock.calls.length;
        let unrelatedSettled = false;
        const unrelated = coldRead ? loadDaemonMergedProjectionCacheEntry({ ...scope, sections: ['settingsById'],
            signal: unrelatedAbort.signal }).finally(() => { unrelatedSettled = true; }) : null;
        const screen = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Picker /></AppShellPluginUiProjectionProvider>);
        const pickerControlId = eventPicker ? 'automation-event-watcher-picker'
            : `source-acquisition.${presentation === 'chip' ? 'chip' : 'current'}`;
        const togglePicker = () => act(async () => screen.tree.root.findAll(node => node.props.testID === pickerControlId
            && typeof node.props.onPress === 'function')[0]!.props.onPress());
        try {
            if (eventCatalog) {
                const { t } = await import('@/text');
                if (catalogReply) {
                    expect(readPluginAccountAvailability(lifetime.scope).readMaterializations())
                        .toMatchObject({ kind: 'unavailable', code: 'account_availability_not_loaded' });
                    expect(screen.tree.root.findAll(node => node.props.children === t('automations.form.trigger.eventCatalogUnavailable')))
                        .toHaveLength(0);
                    expect(screen.tree.root.findAll(node => node.props.children === t('automations.form.trigger.eventCatalogLoading')).length).toBeGreaterThan(0);
                    await act(async () => catalogReply.resolve());
                }
                await waitForHomeGovernance(() => expect(sectionQuestions).toContain(deferred.manifest.sections.automationEligibleEvents));
                await flushHookEffects();
                const eventPickerControl = screen.tree.root.findAll(node => node.props.testID === 'automation-event-picker'
                    && typeof node.props.onPress === 'function');
                expect(eventPickerControl.length).toBeGreaterThan(0);
                expect(sectionQuestions).not.toContain(deferred.manifest.sections.settingsById);
                expect(screen.tree.root.findAll(node => node.props.children === event.event.title).length).toBeGreaterThan(0);
                return;
            }
            if (projectDemand) {
                // The accepted checkout is not an Availability installation or
                // a supplied candidate. A closed Project must issue no reads.
                const { readCurrentAppShellPluginUiExecutionOriginCandidates } = await import('@/components/appShell/plugins/committedPluginUiProjection');
                await flushHookEffects();
                expect(readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId).establishingTargets
                    .some(target => target.machineId === 'machine-1')).toBe(false);
                vi.useFakeTimers();
                await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(beforeOpen);
                expect(selection?.selectedOrigin).toBeNull();
                vi.useRealTimers();
                expect(storage.getState().machines['machine-1'], 'Presented Project requires the fixture Machine census to retain its target').toBeDefined();
                await act(async () => { presented = true; });
                await screen.update(<AppShellPluginUiProjectionProvider><Picker /></AppShellPluginUiProjectionProvider>);
                await waitForHomeGovernance(() => expect(projectionRuntime.describe.mock.calls.length).toBeGreaterThan(beforeOpen));
                expect(execution?.loading).toBe(true);
                expect(selection?.canExecute).toBe(false);
                await act(async () => { projectReply!.resolve(); });
            }
            if (demand === 'picker' || eventPicker) {
                await waitForHomeGovernance(() => {
                    const candidates = eventPicker ? eventComposer?.watcherCandidates : selection?.candidates;
                    const machineIds = candidates?.map(candidate => getPluginMachineExecutionOriginRef(
                        getPluginExecutionOriginCandidateOrigin(candidate)).machineId);
                    if (eventPicker) expect(machineIds).toEqual(expect.arrayContaining(['machine-1', peerMachineId]));
                    else expect(candidates).toHaveLength(1);
                });
                if (demand === 'event-picker-selected') expect(eventComposer?.selectedEvent).toEqual(event);
                const coldCandidate = (eventPicker ? eventComposer?.watcherCandidates : selection?.candidates)?.find(candidate =>
                    getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).machineId === 'machine-1');
                expect(coldCandidate).toMatchObject({ validation: { kind: 'rejected',
                    reason: priorFailure ? 'daemon_unavailable' : 'source_not_ready' } });
                if (!priorFailure && !eventPicker) {
                    expect(selection?.loading).toBe(true);
                    const { resolvePluginMachineExecutionOriginPresentation } = await import('@/components/settings/machines/PluginMachineExecutionOriginSelector');
                    const { t } = await import('@/text');
                    expect(resolvePluginMachineExecutionOriginPresentation(selection!)).toMatchObject({
                        title: t('common.loading'), unavailable: false,
                    });
                }
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(beforeOpen);
                await togglePicker();
            }
            if (eventReply) {
                await flushHookEffects();
                expect(projectionRuntime.describe.mock.calls.slice(beforeOpen).map(([machineId]) => machineId))
                    .toContain('machine-1');
                // An establishing source can withdraw its candidate while its
                // describe is in flight; the open picker still owns that read.
                await act(async () => replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                    availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [],
                } }));
                await flushHookEffects();
                expect(eventComposer?.watcherCandidates.some(candidate =>
                    getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).machineId === 'machine-1')).toBe(false);
                await act(async () => eventReply.resolve());
            }
            await waitForHomeGovernance(() => {
                const entry = readObservedDaemonMergedProjectionCacheEntry({ ...scope, sections: [] });
                expect({ reads: projectionRuntime.describe.mock.calls.length - beforeOpen, phase: entry?.kind,
                    reason: entry?.kind === 'error' ? entry.reason : null,
                    rejection: entry?.deferredHydrationRejection }).toMatchObject({ phase: 'ready', reason: null });
            });
            if (eventPicker) {
                await waitForHomeGovernance(() => expect(eventComposer?.watcherFailures?.map(failure => failure.reason))
                    .toEqual(demand === 'event-picker-selected' ? ['stale'] : []));
                expect(eventComposer?.watcherCandidates).toContainEqual(expect.objectContaining({
                    source: expect.objectContaining({ origin: executionOrigin }), validation: { kind: 'admitted' },
                }));
                const owningCandidate = eventComposer?.watcherCandidates.find(candidate =>
                    getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).machineId === 'machine-1');
                if (!owningCandidate) throw new Error('Expected acquired source candidate');
                await act(async () => { expect(eventComposer?.selectWatcher(owningCandidate)).toBe(true); });
                expect(eventComposer?.selectedWatcherOrigin).toEqual(executionOrigin);
                const settledReads = projectionRuntime.describe.mock.calls.length;
                await togglePicker();
                await flushHookEffects();
                await act(async () => invalidateProjection());
                await flushHookEffects();
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
                return;
            }
            if (demand === 'project-missing') {
                await waitForHomeGovernance(() => expect(execution?.loading).toBe(false));
                expect(selection?.state).toMatchObject({ kind: 'unavailable', reasons: ['no_materialization'] });
                expect(selection?.canExecute).toBe(false);
                const settledReads = projectionRuntime.describe.mock.calls.length;
                vi.useFakeTimers();
                await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
                expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
                return;
            }
            await waitForHomeGovernance(() => {
                expect(selection?.candidates.some(candidate => 'source' in candidate
                    && isPluginMachineExecutionOriginCandidateSelectable(candidate))).toBe(true);
            });
            expect(selection?.selectedOrigin).toEqual(executionOrigin);
            expect(selection?.canExecute).toBe(true);
            expect(selection?.loading).toBe(false);
            expect(sectionQuestions).not.toContain(deferred.manifest.sections.agentsById);
            // Presented controls execute contributed Actions; their declarations are required UI demand.
            expect(sectionQuestions).toContain(deferred.manifest.sections.actionsById);
            if (coldRead) {
                // A successful required catalogue must publish executable
                // readiness while an unrelated Settings read is still held.
                expect(unrelatedSettled).toBe(false);
            } else {
                expect(sectionQuestions).not.toContain(deferred.manifest.sections.settingsById);
            }
            if (demand === 'project') {
                const manifests = projectionRuntime.describe.mock.calls.slice(beforeOpen).filter(([, options]) => {
                    const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
                    return request.selection === undefined && !request.sectionRead;
                });
                expect(manifests).toHaveLength(1);
            }
            expect(readObservedDaemonMergedProjectionCacheEntry({ ...scope, sections: [] })).toMatchObject({ kind: 'ready' });
            projectionRuntime.describe.mockRejectedValueOnce(Object.assign(new Error('Connection timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));
            const beforeFailure = projectionRuntime.describe.mock.calls.length;
            await act(async () => invalidateProjection());
            await waitForHomeGovernance(() => expect(readObservedDaemonMergedProjectionCacheEntry({ ...scope, sections: [] }))
                .toMatchObject({ kind: 'error', reason: 'timeout' }));
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(beforeFailure + 1);
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(beforeFailure + 1);
            vi.useRealTimers();
            expect(storage.getState().machines['machine-1'], 'User recovery requires the fixture Machine census to retain its target').toBeDefined();
            await act(async () => invalidateProjection());
            await waitForHomeGovernance(() => {
                expect(readObservedDaemonMergedProjectionCacheEntry({ ...scope, sections: [] })).toMatchObject({ kind: 'ready' });
                expect(selection?.canExecute).toBe(true);
            });
            const settledReads = projectionRuntime.describe.mock.calls.length;
            if (demand === 'picker') await togglePicker();
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
            vi.useRealTimers();
        } finally {
            projectReply?.resolve(); eventReply?.resolve(); catalogReply?.resolve(); unrelatedAbort.abort(); unrelatedReply?.resolve();
            await unrelated;
            vi.useRealTimers(); restoreClock(); await screen.unmount();
        }
    });

    it.each([false, true])('keeps a mounted target read through unrelated Machine publications (initially disconnected: %s)', async (initiallyDisconnected) => {
        let phase = 'fixture';
        onTestFailed(() => console.info('Mounted target composition phase:', phase));
        const { createDeferred } = await import('@/dev/testkit');
        const { artifactHtmlBundleFromBodyV1 } = await import('@happier-dev/protocol/artifacts/artifactHtmlV1');
        const { normalizePluginUiDestinationBindingV1 } = await import('@happier-dev/protocol/plugins/ui');
        const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
        const { DaemonPluginUiTargetedContributionsReadResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { usePluginSurfaceExecutionOrigin } = await import('@/components/plugins/surfaces/pluginSurfaceExecutionOrigin');
        const { useMountedTargetedContributions } = await import('@/components/plugins/surfaces/mountedTargetedContributions');
        const pluginId = 'acme.preview';
        const entryId = `surfacePlacement:${pluginId}:home`;
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'preview-root' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: 'machine-1', pluginId, sourceCustody } });
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'home', rendererId: 'home',
            container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('The source fixture has no admitted destination');
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Preview', version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: 'preview-root' },
                    occurrenceId: 'occurrence-preview', sourceCustody, executionOrigin,
                    declaresContributionPoints: true, executionTarget: { default: 'installation' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entryId]: {
                    id: entryId, pluginId, occurrenceId: 'occurrence-preview', executionOrigin,
                    contributionKind: 'surfacePlacement', descriptorId: 'home', binding, target: binding.target,
                    renderer: { kind: 'hostedHtml', contributionId: 'home',
                        source: artifactHtmlBundleFromBodyV1('<p>Preview</p>'), requiredHostMethods: [] },
                    display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
                } } } },
            } });
        projectionRuntime.describe.mockResolvedValue(response);
        const signals: AbortSignal[] = [];
        const deliver: (() => void)[] = [];
        projectionRuntime.targeted.mockImplementation((_machineId, options) => {
            const signal = options && typeof options === 'object' && 'signal' in options
                && options.signal instanceof AbortSignal ? options.signal : null;
            if (!signal) throw new Error('The real targeted RPC did not carry its cancellation signal');
            signals.push(signal);
            return new Promise(resolve => deliver.push(() => resolve(DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'current',
                targetedContributions: { target: { pluginId, occurrenceId: 'occurrence-preview', sourceCustody }, points: [] },
                targetedSurfaceMounts: [] }))));
        });
        const daemonState = { status: 'running', pid: 17, runtimeId: 'runtime-preview',
            contributionRegistryProjectionRevision: 0 };
        setMachine({ daemonStateVersion: 2, daemonState });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('The real Account lifetime was not admitted');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [{ serverIdentityId, machineId: 'machine-1',
                materializationId: 'preview-installation', pluginId, version: '1.0.0', sourceClass: 'localPath',
                portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] }], snapshots: [],
        } });
        if (initiallyDisconnected) setMachine({ active: false });
        function Wrapper({ children }: React.PropsWithChildren) {
            usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            return React.createElement(AppShellPluginUiProjectionProvider, null, children);
        }
        phase = 'mount real AppShell';
        const rendered = await renderHook(() => {
            const currentness = useAppShellPluginUiProjection();
            const selected = usePluginSurfaceExecutionOrigin({ pluginId, projection: currentness.pluginUiProjection,
                entry: currentness.pluginUiProjection?.surfacePlacementsById[entryId], enabled: true,
                includeMachineCandidates: false });
            const targeted = useMountedTargetedContributions({ machineId: selected.selectedSupply?.machineId,
                accountLifetime: lifetime,
                serverId: selected.selectedSupply?.serverId, pluginId,
                mountedOccurrenceId: selected.selectedSupply?.occurrenceId,
                enabled: Boolean(selected.selectedSupply?.occurrenceId) });
            return { currentness, selected, targeted };
        }, { wrapper: Wrapper });
        if (initiallyDisconnected) {
            phase = 'publish first disconnected Machine report';
            await flushHookEffects();
            expect(rendered.getCurrent().selected.selection.selectedOrigin).toBeNull();
            expect(signals).toHaveLength(0);
            phase = 'connect Machine through the real inventory producer';
            await act(async () => { setMachine({ active: true }); });
        }
        phase = 'await initial selected supply and targeted read';
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().selected.selectedSupply?.occurrenceId).toBe('occurrence-preview');
            expect(signals).toHaveLength(1);
        });
        const firstSupply = rendered.getCurrent().selected.selectedSupply;
        const revision = getMachineContributionRegistryProjectionRevision({ machineId: 'machine-1', serverId: serverIdentityId });
        phase = 'publish unrelated Machine content';
        await act(async () => {
            const current = storage.getState().machines['machine-1']!;
            storage.getState().applyMachines([createMachineFixture({ ...current,
                metadataVersion: current.metadataVersion + 1,
                daemonStateVersion: 3, daemonState: { ...daemonState, resources: { cpu: { usage: 0.5 } } },
            })], false, { sourceServerId: connection!.home.id });
        });
        await flushHookEffects();
        expect(getMachineContributionRegistryProjectionRevision({ machineId: 'machine-1', serverId: serverIdentityId })).toBe(revision);
        expect(signals).toHaveLength(1);
        expect(signals[0]!.aborted).toBe(false);
        expect(rendered.getCurrent().selected.selectedSupply).toEqual(firstSupply);
        expect(rendered.getCurrent().targeted.phase).toBe('loading');
        // An actual registry revision, unlike resource telemetry, re-reads the
        // projection and the physical target read. The same daemon is the same
        // authority, so the last-good supply stays current while it is asked
        // again (a stale occurrence is still refused at invocation).
        const replacementDescribe = createDeferred<unknown>();
        projectionRuntime.describe.mockImplementationOnce(() => replacementDescribe.promise);
        phase = 'invalidate registry';
        await act(async () => {
            setMachine({ daemonStateVersion: 4,
                daemonState: { ...daemonState, contributionRegistryProjectionRevision: 1 } });
        });
        phase = 'await replacement target read';
        await flushHookEffects();
        expect(rendered.getCurrent().currentness.phase).toBe('current');
        expect(rendered.getCurrent().selected.selectedSupply).toMatchObject({
            occurrenceId: firstSupply!.occurrenceId,
            phase: 'current', interactionEnabled: true,
        });
        expect(signals).toHaveLength(2);
        expect(signals[0]!.aborted).toBe(true);
        expect(signals[1]!.aborted).toBe(false);
        expect(rendered.getCurrent().selected.selectedSupply?.occurrenceId).toBe('occurrence-preview');
        phase = 'deliver retired target reply';
        await act(async () => { deliver[0]!(); });
        await flushHookEffects();
        expect(rendered.getCurrent().targeted.phase).toBe('loading');
        expect(rendered.getCurrent().targeted.targetedContributions).toBeNull();
        phase = 'admit replacement projection';
        await act(async () => { replacementDescribe.resolve(response); });
        await flushHookEffects();
        expect(signals).toHaveLength(2);
        expect(signals[1]!.aborted).toBe(false);
        expect(rendered.getCurrent().selected.isExecutionOriginCurrent()).toBe(true);
        phase = 'deliver current target reply';
        await act(async () => { deliver[1]!(); });
        await flushHookEffects();
        expect(rendered.getCurrent().targeted).toMatchObject({ phase: 'ready',
            targetedContributions: { target: { pluginId, occurrenceId: 'occurrence-preview' } } });
        phase = 'invalidate before Account retirement';
        await act(async () => { invalidateProjection(); });
        await waitForHomeGovernance(() => expect(signals).toHaveLength(3));
        phase = 'retire active Account lifetime';
        await act(async () => { retireActiveServerAccountScopeLifetime(); });
        expect(signals[2]!.aborted).toBe(true);
        phase = 'deliver retired Account target reply';
        await act(async () => { deliver[2]!(); });
        await flushHookEffects();
        // Capturing the unchanged Account can admit a successor lifetime; it
        // still cannot publish the former lifetime's late targeted answer.
        expect(lifetime.isCurrent()).toBe(false);
        expect(rendered.getCurrent().targeted.targetedContributions).toBeNull();
        phase = 'unmount';
        await rendered.unmount();
    });

    it('keeps supplies current through a same-authority refresh, publishes nothing for an equal answer, and establishes on an authority change', async () => {
        let resolveRefresh!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Catalog'))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }))
            .mockImplementationOnce(() => new Promise(() => {}));
        const frames: Array<Readonly<{ phase: string; interactionEnabled: boolean }>> = [];
        const rendered = await renderHook(() => {
            const currentness = usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            frames.push({ phase: currentness.phase, interactionEnabled: currentness.interactionEnabled });
            return currentness;
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        const settled = rendered.getCurrent();
        frames.length = 0;

        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ serverId: serverIdentityId, machineId: 'machine-1' }, 'refresh'); });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        await act(async () => { resolveRefresh(supportedProjection('Catalog')); });
        await flushHookEffects();
        expect({
            demoted: frames.filter(frame => frame.phase !== 'current' || !frame.interactionEnabled).length,
            sameProjection: rendered.getCurrent().pluginUiProjection === settled.pluginUiProjection,
        }).toEqual({ demoted: 0, sameProjection: true });

        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ serverId: serverIdentityId, machineId: 'machine-1' }, 'authority'); });
        await rendered.rerender();
        expect(rendered.getCurrent().phase).toBe('establishing');
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
    });

    it('keeps supplies current through the explicit Home-wide Retry and still demotes them on a real transport loss', async () => {
        let resolveRefresh!: (value: unknown) => void;
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Catalog'))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
        const frames: Array<Readonly<{ phase: string; interactionEnabled: boolean }>> = [];
        const rendered = await renderHook(() => {
            const currentness = usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId });
            frames.push({ phase: currentness.phase, interactionEnabled: currentness.interactionEnabled });
            return currentness;
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().phase).toBe('current'));
        frames.length = 0;
        // The connected-services Retry re-asks every Machine of the Home.
        await act(async () => { publishMachineContributionRegistryProjectionRefresh(serverIdentityId); });
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        await act(async () => { resolveRefresh(supportedProjection('Catalog')); });
        await flushHookEffects();
        expect(frames.filter(frame => frame.phase !== 'current' || !frame.interactionEnabled)).toHaveLength(0);

        await act(async () => { storage.setState({ endpointStatus: 'offline' }); setMachine({ active: false }); });
        await rendered.rerender();
        expect(rendered.getCurrent().interactionEnabled).toBe(false);
        expect(rendered.getCurrent().phase).toBe('retainedOffline');
    });

    it('re-describes an equal-generation projection when daemon state version advances', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Before daemon republish'))
            .mockResolvedValueOnce(supportedProjection('After daemon republish'));

        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();

        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Before daemon republish' },
        });

        // A durable registry adoption advances the version through the real
        // machine writer. It does not replace the daemon endpoint, so no
        // explicit projection invalidation or reconnect is involved.
        await act(async () => { setMachine({ daemonStateVersion: 2 }); });
        await rendered.rerender();
        await flushHookEffects();

        expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'After daemon republish' },
        });
        expect(rendered.getCurrent().interactionEnabled).toBe(true);
    });

    it.each(['identity', 'default'] as const)('keeps a successful projection through idle rerenders and re-describes only on registry adoption or explicit refresh using the %s Home', async (routing) => {
        const otherHomeId = await harness.addHome({
            name: 'Other projection Home',
            serverUrl: 'https://other-projection.example.test',
            serverIdentityId: 'srv_other_projection_currentness',
            accountId: 'account-a',
            active: false,
        });
        const daemonState = { status: 'running', pid: 17, contributionRegistryProjectionRevision: 0 };
        setMachine({ daemonStateVersion: 2, daemonState });
        storage.getState().applyMachines([createMachineFixture({
            id: 'machine-1', daemonStateVersion: 1, daemonState,
        })], false, { sourceServerId: otherHomeId });
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Before refresh'))
            .mockResolvedValueOnce(supportedProjection('After registry adoption'))
            .mockResolvedValueOnce(supportedProjection('After refresh'));
        let reloadRevision = 0;
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: routing === 'identity' ? serverIdentityId : null,
            reloadRevision,
        }));
        await flushHookEffects();
        // The identity route resolves its real credential binding through
        // secure storage; draining a fixed number of microtasks does not wait
        // for that system boundary to admit the first projection.
        await waitForHomeGovernance(() => {
            const currentness = rendered.getCurrent();
            expect({
                phase: currentness.phase,
                interactionEnabled: currentness.interactionEnabled,
                accountCurrent: currentness.accountLifetime?.isCurrent(),
            }).toMatchObject({ phase: 'current', interactionEnabled: true, accountCurrent: true });
        });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        await expect(loadDaemonMergedProjectionCacheEntry({ sections: 'complete',
            machineId: 'machine-1',
            serverId: connection?.home.id,
            accountLifetime,
            reuseFreshReady: true,
        })).resolves.toMatchObject({ kind: 'ready' });
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: otherHomeId })).toBeNull();

        // Cross both the old full-projection poll cadence and the shared
        // cache's freshness window. Neither elapsed time nor a fresh options
        // object is a change to the projection authority.
        vi.useFakeTimers();
        try {
            await flushHookEffects({ advanceTimersMs: 90_000, cycles: 1, turns: 2 });
            await act(async () => {
                storage.getState().applyMachines([createMachineFixture({
                    id: 'machine-1', daemonStateVersion: 2,
                    daemonState: { ...daemonState, contributionRegistryProjectionRevision: 1 },
                })], false, { sourceServerId: otherHomeId });
            });
            await act(async () => { setMachine({ daemonStateVersion: 3, daemonState: {
                ...daemonState,
                localServices: { v: 1, state: 'ready', runningCount: 1 },
            } }); });
            await rendered.rerender();
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            expect(rendered.getCurrent().phase).toBe('current');
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                .toEqual({ en: { title: 'Before refresh' } });
            await act(async () => { setMachine({ daemonStateVersion: 4, daemonState: {
                ...daemonState,
                contributionRegistryProjectionRevision: 1,
                localServices: { v: 1, state: 'ready', runningCount: 2 },
            } }); });
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                .toEqual({ en: { title: 'After registry adoption' } });
        } finally {
            vi.useRealTimers();
        }

        reloadRevision = 1;
        await rendered.rerender();
        await flushHookEffects();
        expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
            .toEqual({ en: { title: 'After refresh' } });
    });

    it('does not reissue an aborted acquisition until a new presented demand arrives', async () => {
        vi.useFakeTimers();
        try {
            const abortError = Object.assign(new Error('Projection transport cancelled'), { code: 'MACHINE_RPC_ABORTED' });
            projectionRuntime.describe.mockRejectedValue(abortError);
            let enabled = true;
            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1', serverId: serverIdentityId, enabled,
            }));
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            enabled = false;
            await rendered.rerender();
            projectionRuntime.describe.mockResolvedValue(supportedProjection('New presented demand'));
            enabled = true;
            await rendered.rerender();
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            expect(rendered.getCurrent().phase).toBe('current');
            await rendered.unmount();
        } finally { vi.useRealTimers(); }
    });

    it('keeps an undemanded passive projection pending without reading a daemon and adopts a later real read', async () => {
        const target = { machineId: 'machine-1', serverId: serverIdentityId,
            accountLifetime: captureActiveServerAccountScopeLifetime()! };
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({ ...target, load: false }));
        try {
            expect(rendered.getCurrent()).toMatchObject({ phase: 'establishing', interactionEnabled: false });
            expect(rendered.getCurrent().unavailableReasonCode).toBeUndefined();
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            await rendered.rerender();
            await flushHookEffects();
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            projectionRuntime.describe.mockResolvedValue(supportedProjection('Later demand'));
            const { PLUGIN_UI_SECTIONS } = await import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness');
            await act(async () => {
                expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS }))
                    .toMatchObject({ kind: 'ready' });
            });
            expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
        } finally { await rendered.unmount(); }
    });

    it('keeps the cold Account declaration census pending until its Availability owner settles', async () => {
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        for (const actionId of ['account.plugins.availability.materializations.read', 'account.plugins.availability.intents.list'] as const) {
            const path = PluginAvailabilityActionHttpPathsV1[actionId];
            const response = createEmptyAccountBootstrapHttpResponse(path, { method: 'POST' });
            if (!response) throw new Error('availability_fixture_missing');
            harness.answer(homeId, `POST ${path}`, { body: await response.json(), respondAfter });
        }
        clearPluginAccountAvailabilityProjection();
        const pending = sync.refreshPluginAccountAvailability();
        const snapshot: { current: ReturnType<typeof useAppShellPluginUiProjection> | null } = { current: null };
        function Probe() { snapshot.current = useAppShellPluginUiProjection(); return null; }
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Probe /></AppShellPluginUiProjectionProvider>);
        try {
            await flushHookEffects();
            expect(snapshot.current?.phase).toBe('establishing');
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
            await act(async () => { release(); await pending; });
            await flushHookEffects();
            expect(readPluginAccountAvailability(captureActiveServerAccountScopeLifetime()!.scope).readMaterializations())
                .toMatchObject({ kind: 'available', materializations: [] });
            // The Account census answered, but it did not acquire this online
            // Machine's UI projection. Those two authorities stay distinct.
            expect(snapshot.current?.hasEstablishingMembers).toBe(true);
            expect(snapshot.current?.phase).toBe('establishing');
            expect(projectionRuntime.describe).not.toHaveBeenCalled();
        } finally { release(); await pending; await rendered.unmount(); }
    });

    it('admits renderer artifacts from a presented plugin slice while the full catalog is establishing', async () => {
        const { pluginUiSections } = await import('./projectionSections');
        const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1 } = await import('@happier-dev/protocol/plugins/ui');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const { getInstalledPluginReactNativeModuleRegistry } = await import('@/components/plugins/reactNative/moduleRegistry');
        const { loadPluginReactNativeBundleModule } = await import('@/components/plugins/reactNative/loader');
        const pluginId = 'qa.remainder-1116.choices';
        const contributionId = 'choices-renderer';
        const artifactId = 'choices';
        const bundleId = `reactNativeBundle:${pluginId}:${contributionId}`;
        const entry = 'react-native/choices/entry.cjs.bundle';
        const bytes = new TextEncoder().encode('exports.renderSurface = function () { return null; };');
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entry, bytes }]);
        // Captured B2 shape: the mounted plugin's deferred slice has a compatible
        // Machine renderer, while the passive full-catalog projection is unread.
        const reply = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1, projectionDigest: 'c'.repeat(64), projection: {
                v: 2, generation: 9117,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'QA choices', version: '0.1.0', enabled: true,
                    source: { kind: 'registryPackage', locator: '@qa/choices' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [bundleId]: {
                    id: bundleId, pluginId, contributionId, contributionKind: 'reactNativeBundle', generatedV2: true,
                    pluginVersion: '0.1.0', occurrenceId: `${pluginId}:9117`, generatedOwnerKind: 'renderer',
                    artifactSelectionOwner: 'daemonProjection',
                    executionOrigin: { serverIdentityId, materializationRef: { machineId: 'machine-1', pluginId, materializationId: 'materialization-choices' } },
                    entry: { artifactId, exportName: 'renderSurface' },
                    artifactGraph: { artifactId, tier: 'reactNative', entry,
                        files: [{ relativePath: entry, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
                        digest: artifactDigest, builtWith: { bundler: 'esbuild', version: '0.27.2' },
                        executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.1.0' },
                    runtime: { state: 'loadable', diagnostics: [], decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        cacheKey: artifactDigest, cacheIdentity: { artifactDigest }, loadPolicy: { source: 'installedArtifact' } },
                } } } },
            },
        });
        const deferred = buildDeferredDaemonProjectionSections(reply);
        projectionRuntime.describe.mockImplementation(async (_machineId, options) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Expected shared projection');
            return request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
        });
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const target = { machineId: 'machine-1', serverId: serverIdentityId, accountLifetime: lifetime };
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({ ...target, load: false }));
        const modules = getInstalledPluginReactNativeModuleRegistry();
        try {
            await act(async () => {
                expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: pluginUiSections(pluginId) }))
                    .toMatchObject({ kind: 'ready' });
            });
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().phase).toBe('establishing');
                expect(rendered.getCurrent().presentedPluginIds?.has(pluginId)).toBe(true);
                expect(rendered.getCurrent().installedPackagesProjection?.reactNativeBundlesById[bundleId])
                    .toMatchObject({ artifactGraph: { digest: artifactDigest }, runtime: { decision: { state: 'load' } } });
            });
            expect(rendered.getCurrent().pluginUiProjection?.reactNativeBundlesById[bundleId]).toBeUndefined();
            const identity = { pluginId, contributionId, artifactId, artifactDigest, platform: 'web' };
            const cache = getInstalledPluginReactNativeBundleCache();
            expect(cache.putInstalledArtifact({ identity, bytes, format: 'plainJs', accountScope: lifetime.scope },
                cache.captureWriteFence(identity))).toMatchObject({ ok: true });
            expect(cache.readInstalledArtifact(identity, lifetime.scope)).not.toBeNull();
            const loaded = await loadPluginReactNativeBundleModule({ cache, identity });
            if (!loaded.ok) throw new Error(loaded.code);
            const fence = modules.captureWriteFence(artifactDigest);
            expect(fence).not.toBeNull();
            expect(modules.write(artifactDigest, loaded.module, fence!)).toBe(true);
        } finally { await rendered.unmount(); }
        expect(modules.read(artifactDigest)).toBeNull();
    });

    it('settles a passive source establishment when demanded deferred UI sections fail, and recovers on fresh demand', async () => {
        const { PLUGIN_UI_SECTIONS } = await import('./usePluginUiProjectionCurrentness');
        const deferred = buildDeferredDaemonProjectionSections({
            ...supportedProjection('Admitted UI'), projectionDigest: 'c'.repeat(64),
        });
        const reply = async (_machineId: string, options: unknown) => {
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse((options as { payload: unknown }).payload);
            if (request.selection !== undefined) throw new Error('Expected shared projection');
            return request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
        };
        projectionRuntime.describe.mockImplementation(reply);
        const target = { machineId: 'machine-1', serverId: serverIdentityId,
            accountLifetime: captureActiveServerAccountScopeLifetime()! };
        const partial = await loadDaemonMergedProjectionCacheEntry({ ...target, sections: [] });
        expect(partial).toMatchObject({ kind: 'ready' });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({ ...target, load: false }));
        try {
            expect(rendered.getCurrent().phase).toBe('establishing');
            // The actual network boundary answers, but neither the section nor
            // full-response fallback supplies an admissible projection body.
            projectionRuntime.describe.mockResolvedValue({ invalidProjectionResponse: true });
            await act(async () => {
                const failed = await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS,
                    reuseFreshReady: true });
                expect(failed).toMatchObject({ kind: 'error', reason: 'invalid-response' });
            });
            expect(rendered.getCurrent()).toMatchObject({ phase: 'unavailable', interactionEnabled: false,
                unavailableReasonCode: 'plugin_daemon_invalid_response' });

            const settledReads = projectionRuntime.describe.mock.calls.length;
            vi.useFakeTimers();
            try { await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1, turns: 2 }); }
            finally { vi.useRealTimers(); }
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(settledReads);
            projectionRuntime.describe.mockImplementation(reply);
            await act(async () => {
                expect(await loadDaemonMergedProjectionCacheEntry({ ...target, sections: PLUGIN_UI_SECTIONS }))
                    .toMatchObject({ kind: 'ready' });
            });
            expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                .toEqual({ en: { title: 'Admitted UI' } });
        } finally { await rendered.unmount(); }
    });

    it('shares failed-refresh continuity with passive AppShell observers without adding recovery demand', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe.mockResolvedValueOnce(supportedProjection('Held catalog'))
                .mockRejectedValue(new Error('RPC transport unavailable'));
            const rendered = await renderHook(() => [
                usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId }),
                usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId, load: false }),
            ]);
            await flushHookEffects();
            expect(rendered.getCurrent().map(reader => reader.phase)).toEqual(['current', 'current']);
            await act(async () => { invalidateProjection('refresh'); });
            await flushHookEffects();
            expect(rendered.getCurrent().map(reader => reader.phase)).toEqual(['current', 'current']);
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            await rendered.unmount();
        } finally { vi.useRealTimers(); }
    });

    it.each([false, true])('shares the recovery cadence between simultaneous readers of one Machine authority (purpose admission: %s)', async includeConnectedAccountPurposes => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe.mockRejectedValue(new Error('RPC transport unavailable'));
            const rendered = await renderHook(() => [
                usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId, includeConnectedAccountPurposes }),
                usePluginUiProjectionCurrentness({ machineId: 'machine-1', serverId: serverIdentityId, includeConnectedAccountPurposes }),
            ]);
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            expect(rendered.getCurrent().every(reader => !reader.interactionEnabled)).toBe(true);
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            await flushHookEffects({ advanceTimersMs: 50, cycles: 1, turns: 2 });
            const lateReader = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1', serverId: serverIdentityId, includeConnectedAccountPurposes,
            }));
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            // Departing readers cannot cancel the remaining reader's recovery,
            // and a new mount cannot reset the shared failure to its first rung.
            await rendered.unmount();
            await flushHookEffects({ advanceTimersMs: 949, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            await flushHookEffects({ advanceTimersMs: 1, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            await lateReader.unmount();
            await flushHookEffects({ advanceTimersMs: 10_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
        } finally { vi.useRealTimers(); }
    });

    it('resets a failed projection recovery on explicit refresh and reconnect', async () => {
        vi.useFakeTimers();
        try {
            let reloadRevision = 0;
            projectionRuntime.describe.mockRejectedValue(new Error('RPC transport unavailable'));
            const rendered = await renderHook(() => {
                const params = { machineId: 'machine-1', serverId: serverIdentityId, reloadRevision };
                return [usePluginUiProjectionCurrentness(params), usePluginUiProjectionCurrentness(params)];
            });
            await flushHookEffects();
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            reloadRevision++;
            await rendered.rerender();
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(4);
            await act(async () => { publishMachineContributionRegistryProjectionRefresh(); });
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(5);
            projectionRuntime.describe.mockResolvedValue(supportedProjection('Recovered after reconnect'));
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(6);
            for (const reader of rendered.getCurrent()) {
                expect(reader.interactionEnabled).toBe(true);
                expect(reader.pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                    .toEqual({ en: { title: 'Recovered after reconnect' } });
            }
            await rendered.unmount();
        } finally { vi.useRealTimers(); }
    });

    it('keeps a confirmed projection interactive through a failed refresh while the machine is online, and demotes it only once the machine is offline', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockRejectedValueOnce(new Error('RPC transport unavailable'))
                .mockResolvedValueOnce(supportedProjection('Recovered'));

            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();

            await act(async () => {
                invalidateProjection('refresh');
            });
            await flushHookEffects();

            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
                en: { title: 'Last known good' },
            });
            // A failed refresh never proves absence: the last confirmed projection stays usable.
            expect(rendered.getCurrent().phase).toBe('current');
            expect(rendered.getCurrent().interactionEnabled).toBe(true);

            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });

            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
                en: { title: 'Recovered' },
            });
            expect(rendered.getCurrent().interactionEnabled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('demotes a projection kept through a failed refresh once the machine goes offline', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Last known good'))
            .mockResolvedValue({ protocolVersion: 1, projection: null });
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        await act(async () => { invalidateProjection('refresh'); });
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });

        setMachine({ active: false });
        await act(async () => { await rendered.rerender(); });
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
            .toEqual({ en: { title: 'Last known good' } });
    });

    it('returns to current as soon as a lapsed heartbeat resumes, without re-establishing a daemon that never reconnected', async () => {
        projectionRuntime.describe
            .mockResolvedValueOnce(supportedProjection('Confirmed'))
            .mockImplementation(() => new Promise(() => {}));
        const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });

        // A late heartbeat lapses presence; the daemon socket itself never reconnected, so the
        // endpoint identity (the projection revision) is unchanged when presence resumes.
        setMachine({ active: false });
        await act(async () => { await rendered.rerender(); });
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false });

        setMachine({ active: true });
        await act(async () => { await rendered.rerender(); });
        await flushHookEffects();
        expect(rendered.getCurrent()).toMatchObject({ phase: 'current', interactionEnabled: true });
        expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
            .toEqual({ en: { title: 'Confirmed' } });
    });

    it.each(['transport-error', 'transport-unavailable'] as const)('recovers a cold unavailable projection after %s without reopening the surface', async failureReason => {
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            // Only the machine transport is simulated. The real projection
            // cache/currentness owner must keep retrying a cold build instead
            // of treating a socket observation failure as terminal admission.
            projectionRuntime.describe.mockImplementation(() => {
                if (Date.now() - startedAt >= 160_523) {
                    return Promise.resolve(supportedProjection('Cold build ready'));
                }
                return new Promise((_, reject) => {
                    setTimeout(() => reject(failureReason === 'transport-unavailable'
                        ? new RpcError('Socket disconnected before the read completed', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE)
                        : new Error('RPC timeout')), 30_000);
                });
            });
            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();
            expect(rendered.getCurrent().interactionEnabled).toBe(false);
            for (const retryDelay of [250, 1_000, 2_500, 5_000, 30_000]) {
                await flushHookEffects({ advanceTimersMs: 30_000, cycles: 1, turns: 2 });
                expect(rendered.getCurrent().interactionEnabled).toBe(false);
                expect(rendered.getCurrent()).toMatchObject({
                    phase: 'unavailable', unavailableReasonCode: 'plugin_daemon_unavailable',
                });
                expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: serverIdentityId }))
                    .toMatchObject({ kind: 'error', reason: failureReason });
                expect(rendered.getCurrent().connectedAccountProjection).toEqual({ kind: 'error', reason: 'transport' });
                await flushHookEffects({ advanceTimersMs: retryDelay, cycles: 1, turns: 2 });
            }
            expect(rendered.getCurrent().phase).toBe('current');
            expect(rendered.getCurrent().interactionEnabled).toBe(true);
            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles)
                .toEqual({ en: { title: 'Cold build ready' } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending transient retry when the Account lifetime retires', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockRejectedValueOnce(new Error('RPC transport unavailable'))
                .mockImplementationOnce(() => new Promise(() => {}));

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();

            await act(async () => {
                invalidateProjection();
            });
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);

            await act(async () => { await switchAccount('account-b'); });
            await flushHookEffects({ advanceTimersMs: 10_000, cycles: 1, turns: 2 });

            // The successor Account gets its one new authoritative request;
            // the retired Account's scheduled retry must not escape behind it.
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles an invalid response without retries and recovers once the projection fact changes', async () => {
        answerCurrentMachineCensus();
        vi.useFakeTimers();
        const timers = installTimerCensus(stack => stack.includes('usePluginUiProjectionCurrentness.ts') ? 'projection' : null);
        try {
            // A complete, malformed transport reply is a semantic failure,
            // distinct from a rejected or timed-out RPC. This is a source
            // counterexample, not an alleged captured HOMEIDLE response body.
            projectionRuntime.describe.mockResolvedValue({ protocolVersion: 1, projection: null });
            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();
            expect(rendered.getCurrent()).toMatchObject({ phase: 'unavailable', interactionEnabled: false,
                unavailableReasonCode: 'plugin_daemon_invalid_response' });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            expect(timers.read().filter(timer => timer.consumer === 'projection')).toEqual([]);
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            // Account currentness can refresh independently on endpoint
            // recovery; this owner must not schedule another projection read.
            expect(timers.read().filter(timer => timer.consumer === 'projection')).toEqual([]);
            // New mounted readers share the same settled semantic failure;
            // they cannot turn it back into an automatic acquisition loop.
            const peer = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1', serverId: serverIdentityId,
            }));
            await flushHookEffects();
            expect(peer.getCurrent().unavailableReasonCode).toBe('plugin_daemon_invalid_response');
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(1);
            projectionRuntime.describe.mockResolvedValue(supportedProjection('Recovered after change'));
            await act(async () => { invalidateProjection(); });
            await flushHookEffects();
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(2);
            expect(rendered.getCurrent().phase).toBe('current');
            expect(peer.getCurrent().phase).toBe('current');
            expect(timers.read().filter(timer => timer.consumer === 'projection')).toEqual([]);
            expect(vi.getTimerCount()).toBe(timers.read().length);
            await peer.unmount();
            await rendered.unmount();
        } finally {
            timers.stop();
            vi.useRealTimers();
        }
    });
});
