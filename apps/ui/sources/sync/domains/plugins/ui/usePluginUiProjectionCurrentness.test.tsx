import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AccountPetListResponseV1Schema, AccountProfileSchema, AutomationDefinitionListResponseSchema, CurrentCursorResponseSchema, DaemonContributionRegistryProjectionDescribeRequestSchema, DaemonContributionRegistryProjectionDescribeResponseSchema, FeaturesResponseSchema, PluginProjectionV2Schema, V2SessionListResponseSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const projectionRuntime = vi.hoisted(() => ({
    describe: vi.fn<(machineId: string, options?: unknown) => Promise<unknown>>(),
    pendingReplies: new Map<() => void, Promise<void>>(),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock((params) => {
        if (params.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error(`Unexpected currentness fixture RPC: ${params.method}`);
        // Pending external replies belong to the test Home transport. A case
        // may deliver a late answer, but disposing the fixture must settle
        // unanswered reads rather than leaking them into the next Account.
        let disconnect!: () => void;
        const reply = new Promise<unknown>((resolve, reject) => {
            disconnect = () => reject(new Error('Test projection Home transport disconnected'));
            void Promise.resolve(projectionRuntime.describe(params.machineId, params)).then(resolve, reject);
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
const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
const { isMachineOnline } = await import('@/utils/sessions/machineUtils');
const { resolveServerScopedMachine } = await import('@/sync/store/domains/machines/resolveServerScopedMachine');
const { getPreferredLanguage } = await import('@/text');
const { resolveNativeReactNativeHostRuntimeIdentity } = await import('@/components/plugins/reactNative/hostRuntimeIdentity');
const { resolveHostedWebFrameCapability } = await import('@/components/plugins/hostedWeb/hostedWebFrameCapability');
const { publishMachineContributionRegistryProjectionInvalidation, publishMachineContributionRegistryProjectionReconnect } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');

const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
} = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { PluginAppPageLaunchInputScope } = await import('@/components/appShell/plugins/pluginAppPageNavigation');
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

function setMachine(input: { active?: boolean; daemonStateVersion?: number; daemonState?: Readonly<Record<string, unknown>> }) {
    const current = storage.getState().machines['machine-1'];
    // No heartbeat timestamp in this boundary fixture: the real presence
    // owner therefore uses the Home-published active bit, not a stale clock.
    storage.getState().applyMachines([createMachineFixture({ ...current, ...input, id: 'machine-1', activeAt: 0 })], true, { sourceServerId: connection?.home.id });
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
    const request = createServerFetchAtEndpoint({ endpointUrl: home.serverUrl, credentials: { token: home.token } });
    const restored = await restoreServerAccountForTest({
        serverUrl: home.serverUrl,
        serverIdentityId: serverIdentityId,
        accountId,
        request: (url, init) => request(String(url), init),
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

function answerBootstrap() {
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
    harness.answer(homeId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`, {
        body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] }),
    });
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

function invalidateProjection() {
    publishMachineContributionRegistryProjectionInvalidation({ serverId: serverIdentityId, machineId: 'machine-1' });
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
        answerBootstrap();
        connection = await restoreCurrentnessAccount('account-a');
        storage.setState({ endpointStatus: 'online' });
        setMachine({ active: true, daemonStateVersion: 1 });
        await assertProjectionFixtureReady();
        projectionRuntime.describe.mockReset();
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

    it('publishes one exact Home Machine inventory through device-local and portable aliases', () => {
        if (!connection) throw new Error('The real focused Home was not restored');
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

        expect(emptied.getCurrent().phase).toBe('establishing');
        expect(emptied.getCurrent().pluginUiProjection?.generation).toBeNull();
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
        expect(cold.getCurrent().phase).toBe('establishing');

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
        projectionRuntime.describe.mockResolvedValue({ protocolVersion: 1, projection: null });
        const transient = await renderHook(() => usePluginUiProjectionCurrentness({
            machineId: 'machine-1',
            serverId: serverIdentityId,
        }));
        await flushHookEffects();
        expect(transient.getCurrent().phase).toBe('establishing');
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

        expect(afterDefinitive.getCurrent().phase).toBe('establishing');
        expect(afterDefinitive.getCurrent().pluginUiProjection?.generation).toBeNull();
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
        expect(otherAccount.getCurrent().phase).toBe('establishing');
        expect(otherAccount.getCurrent().pluginUiProjection?.generation).toBeNull();
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
        setMachine({ active: true });
        await act(async () => {
            await restored.rerender();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(restored.getCurrent().phase).toBe('current');
        expect(restored.getCurrent().interactionEnabled).toBe(true);
        expect(restored.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
            en: { title: 'Live catalog' },
        });
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
        const offlineMachines = Array.from({ length: 40 }, (_, index) => createMachineFixture({
            id: `offline-${index}`, active: false, activeAt: 0,
        }));
        storage.getState().applyMachines(offlineMachines, false, { sourceServerId: connection!.home.id });
        projectionRuntime.describe.mockResolvedValue(supportedProjection('Live catalog'));
        const rendered = await renderHook(() => {
            // The reader count is fixed for this mounted test. Each reader
            // runs the real store/currentness owner, as AppShell's children do.
            const readers = ['machine-1', ...offlineMachines.map(machine => machine.id)].map(machineId => (
                usePluginUiProjectionCurrentness({ machineId, serverId: serverIdentityId })
            ));
            return { readers, union: unionPluginUiProjections(readers.map(reader => ({
                ...reader, machineId: reader.machineId!,
                projection: reader.pluginUiProjection,
            }))) };
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().readers[0]?.phase).toBe('current'));
        expect(rendered.getCurrent().readers.slice(1).every(reader => reader.phase === 'establishing')).toBe(true);
        expect(rendered.getCurrent().union).toMatchObject({ phase: 'current', interactionEnabled: true });
        expect(projectionRuntime.describe.mock.calls.map(([machineId]) => machineId)).toEqual(['machine-1']);
        const settledReaders = rendered.getCurrent().readers;
        await act(async () => {
            setMachine({ active: true, daemonStateVersion: 1 });
        });
        await flushHookEffects();
        expect(rendered.getCurrent().readers.every((reader, index) => reader === settledReaders[index])).toBe(true);
        await rendered.unmount();
    });

    it('retains the AppShell catalog identity across real Machine presence updates with installed declarations', async () => {
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
        function Probe() { snapshot.current = useAppShellPluginUiProjection(); return null; }
        const rendered = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><Probe /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(() => expect(snapshot.current?.phase).toBe('current'));
        const settledProjection = snapshot.current!.pluginUiProjection;
        expect(settledProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({ en: { title: 'Stable catalog' } });
        await act(async () => {
            const machine = storage.getState().machines['machine-1']!;
            storage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, { sourceServerId: connection!.home.id });
        });
        await flushHookEffects();
        expect(snapshot.current!.pluginUiProjection).toBe(settledProjection);
        await rendered.unmount();
        clearPluginAccountAvailabilityProjection();
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
        });
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
            <PluginAppPageLaunchInputScope pluginUiProjection={null}>
                <ProjectionOwner />
                <AvailabilityObserver />
            </PluginAppPageLaunchInputScope>
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

            expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('account-b');
            expect(snapshot.current?.interactionEnabled).toBe(false);
            expect(snapshot.current?.connectedAccountProjection).toBeNull();
            expect(accountAReader.readMaterializations()).toEqual({
                kind: 'unavailable', code: 'account_availability_not_loaded',
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
        // (`publishMachineContributionRegistryProjectionReconnect`), so the
        // one owner issues a fresh read instead of joining the prior flight.
        await act(async () => {
            storage.setState({ endpointStatus: 'online' });
            setMachine({ active: true });
            publishMachineContributionRegistryProjectionReconnect();
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
        await expect(loadDaemonMergedProjectionCacheEntry({
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

    it('retries a transient projection failure while retaining an inert last-known-good snapshot', async () => {
        vi.useFakeTimers();
        try {
            projectionRuntime.describe
                .mockResolvedValueOnce(supportedProjection('Last known good'))
                .mockResolvedValueOnce({ protocolVersion: 1, projection: null })
                .mockResolvedValueOnce(supportedProjection('Recovered'));

            const rendered = await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();

            await act(async () => {
                invalidateProjection();
            });
            await flushHookEffects();

            expect(rendered.getCurrent().pluginUiProjection?.translationsByPluginId['acme.preview']?.bundles).toEqual({
                en: { title: 'Last known good' },
            });
            expect(rendered.getCurrent().interactionEnabled).toBe(false);

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

    it('recovers a cold projection after repeated transport timeouts outlast the transient retry burst', async () => {
        vi.useFakeTimers();
        try {
            const startedAt = Date.now();
            // Only the machine transport is simulated. The real projection
            // cache/currentness owner must keep retrying a cold build instead
            // of treating a socket observation timeout as terminal admission.
            projectionRuntime.describe.mockImplementation(() => {
                if (Date.now() - startedAt >= 160_523) {
                    return Promise.resolve(supportedProjection('Cold build ready'));
                }
                return new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('RPC timeout')), 30_000);
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
                .mockResolvedValueOnce({ protocolVersion: 1, projection: null })
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

    it('settles a persistent failure onto the app-wide projection refresh cadence instead of re-asking every five seconds', async () => {
        vi.useFakeTimers();
        try {
            // A failure this owner cannot cure by asking again: a response the
            // daemon delivered in full and this client could not parse arrives
            // here as the same opaque `error`. Retrying it faster than the
            // app's own 30 s projection refresh buys nothing and re-pulls the
            // whole projection each time.
            projectionRuntime.describe.mockResolvedValue({ protocolVersion: 1, projection: null });

            await renderHook(() => usePluginUiProjectionCurrentness({
                machineId: 'machine-1',
                serverId: serverIdentityId,
            }));
            await flushHookEffects();

            // The transient burst is deliberately preserved: 250 ms, 1 s,
            // 2.5 s, 5 s. Real blips live inside those first ~8.75 s.
            await flushHookEffects({ advanceTimersMs: 250, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 2_500, cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(5);

            // Past that burst the failure is no longer a blip. Twenty-five more
            // seconds must not produce five more full projection reads.
            await flushHookEffects({ advanceTimersMs: 25_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(5);

            // It still recovers on its own — one attempt per refresh cadence.
            await flushHookEffects({ advanceTimersMs: 5_000, cycles: 1, turns: 2 });
            expect(projectionRuntime.describe).toHaveBeenCalledTimes(6);
        } finally {
            vi.useRealTimers();
        }
    });
});
