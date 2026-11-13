import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), back: vi.fn(), replace: vi.fn(),
    params: {} as Record<string, string | undefined> }));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-reanimated', async () =>
    (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/new/pick/machine', params: () => navigation.params,
        navigation: { dispatch: navigation.dispatch, getState: () => ({ index: 1, routes: [
            { key: 'new-route', name: '(app)/new/index', path: '/new', params: {} },
            { key: 'current-route', name: '(app)/new/pick/machine', path: '/new/pick/machine' },
        ] }) },
        router: { back: navigation.back, replace: navigation.replace, canGoBack: () => true },
    }).module);

import { MachinePoolListOutputV1Schema, MachinePoolResolveResultV1Schema, MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { RunnerArtifactAvailabilityProjectionV1Schema } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1 } from '@happier-dev/protocol/ephemeralRunner/routes';
import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';

const account = createProviderSettingsAccountHarness();
const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
await loadSyncSingletonForTests();
const restoreActionLoader = await installRealActionExecutorModuleLoader();
const profiles = await import('@/sync/domains/server/serverProfiles');
const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
const { NewSessionMachineSelectionContent } = await import('@/components/sessions/new/components/NewSessionMachineSelectionContent');
const Screen = (await import('@/app/(app)/new/pick/machine')).default;
const { sync } = await import('@/sync/sync');
const { resetMachinePoolSyncRuntimeForTests } = await import('@/sync/engine/machines/machinePoolSyncRuntime');
type ContentProps = React.ComponentProps<typeof NewSessionMachineSelectionContent>;

const pool = MachinePoolViewV1Schema.parse({ pool: { id: '3a948f0c-bc30-491c-b764-37f0e6744d1f', name: 'Development',
    description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] },
    availability: { state: 'known', connectedCount: 1, enabledCount: 1 } });
const poolListPath = machinePoolActionEndpointPathV1('machines.pools.list');
const poolResolvePath = machinePoolActionEndpointPathV1('machines.pools.resolve');
const artifacts = RunnerArtifactAvailabilityProjectionV1Schema.parse({ status: 'available', artifacts: [{
    identity: { product: 'happier-runner', version: '1.0.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
    channel: 'stable', url: 'https://runner.fixture.test/runner.tar.gz',
    checksumsUrl: 'https://runner.fixture.test/checksums', checksumsSignatureUrl: 'https://runner.fixture.test/checksums.sig',
    sizeBytes: 1, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 1, mode: 0o755 }],
}] });
let homeA = '';
let homeB = '';
let homeC = '';
let savedHomeB = '';
let savedHomeC = '';
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;

function machine(id = 'machine-1', overrides: Partial<Machine> = {}) {
    return createMachineFixture({ id, active: true, activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!,
        host: id, displayName: id === 'machine-1' ? 'Machine 1' : id, homeDir: '/home/me', platform: 'darwin',
    }, ...overrides });
}

function features(serverId: string, temporary = false) {
    const response = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: serverId } } });
    for (const [id, enabled] of [['machines', true], ['sessions', true], ['sessions.drafts', true],
        ['sessions.ephemeralRunner', temporary], ['machines.pools', true]] as const) {
        if (!tryWriteServerEnabledBitInPlace(response, id, enabled)) throw new Error(`Missing fixture feature ${id}`);
    }
    return response;
}

function answerPools(serverId: string, rows = [] as Array<typeof pool>) {
    account.home.answer(serverId, poolListPath, { body: MachinePoolListOutputV1Schema.parse({ pools: rows }) });
}

async function view(target: string | null, group?: Readonly<{ id: string; serverIds: string[] }>) {
    await updateEffectiveHomeViewState(() => ({ version: 1,
        groups: group ? [{ ...group, name: 'Dev Group', presentation: 'grouped' }] : [],
        activeTargetKind: group ? 'group' : target ? 'server' : null, activeTargetId: group?.id ?? target,
    }), { scope: 'device' });
}

function content(): ContentProps {
    if (!screen) throw new Error('Picker is not mounted');
    return screen.findByType(NewSessionMachineSelectionContent).props as ContentProps;
}

async function renderPicker() {
    // Keep the actual lazy owner, but let its SDK graph finish loading before
    // asserting that the destination projection has settled.
    await import('@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers');
    screen = await renderScreen(<Screen />);
    await vi.waitFor(() => expect(content().groups?.filter(group => group.loading)).toEqual([]));
    return screen;
}

function returnedParams() {
    return navigation.dispatch.mock.calls.map(([action]) => action?.payload?.params as Record<string, unknown>);
}

function expectExactReturn(machineId: string, serverId = homeB) {
    expect(navigation.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_PARAMS',
        payload: { params: expect.objectContaining({ machineId, spawnServerId: serverId }) } }));
}

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://ui.fixture.test/new/pick/machine' });
    daemon.reset();
    navigation.dispatch.mockReset(); navigation.back.mockReset(); navigation.replace.mockReset();
    screen = null;
    await account.restore({ serverIdentityId: 'srv_picker_a', currentAccount: true, machines: [], features: features('srv_picker_a'),
        settings: { useMachinePickerSearch: false, managedMachineCreationEnabled: false } });
    homeA = profiles.resolveServerProfileScopeIdForIdentifier(account.serverId);
    savedHomeB = await account.addHome({ name: 'Server B',
        serverUrl: 'https://stack-b.fixture.test', serverIdentityId: 'srv_picker_b', accountId: 'account-b', currentAccount: true,
        active: false, features: features('srv_picker_b') });
    homeB = profiles.resolveServerProfileScopeIdForIdentifier(savedHomeB);
    savedHomeC = await account.addHome({ name: 'Server C',
        serverUrl: 'https://stack-c.fixture.test', serverIdentityId: 'srv_picker_c', accountId: 'account-c', currentAccount: true,
        active: false, features: features('srv_picker_c') });
    homeC = profiles.resolveServerProfileScopeIdForIdentifier(savedHomeC);
    for (const savedHome of [savedHomeB, savedHomeC]) {
        account.home.answer(savedHome, '/v2/account/settings', { body: {
            content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1,
        } });
    }
    await account.publishMachines(savedHomeB, [machine()]);
    for (const home of [account.serverId, savedHomeB, savedHomeC]) answerPools(home);
    await view(homeB);
    navigation.params = { selectedId: 'machine-1', spawnServerId: homeB };
});

afterEach(async () => {
    standardCleanup();
    sync.disconnectServer();
    resetMachinePoolSyncRuntimeForTests();
    await account.reset();
    browser?.restore();
    browser = undefined;
});
afterAll(() => restoreActionLoader());

describe('machine picker server scope', () => {
    it('propagates selected machine and server params back to new session route without switching global active server', async () => {
        const focused = profiles.getActiveServerSnapshot().serverId;
        await renderPicker();
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focused);
        await act(async () => { content().onSelectMachine(machine()); });
        expectExactReturn('machine-1');
        expect(navigation.back).toHaveBeenCalledTimes(1);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focused);
    });

    it('uses the selected machine serverId when provided (group target coherence)', async () => {
        const focused = profiles.getActiveServerSnapshot().serverId;
        await account.publishMachines(savedHomeC, [machine()]);
        await renderPicker();
        await act(async () => { content().onSelectScopedMachine?.({ ...machine(), serverId: homeC, serverName: 'Server C' }); });
        expectExactReturn('machine-1', homeC);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focused);
    });

    it('auto-selects machine when selected server has exactly one machine', async () => {
        navigation.params.selectedId = '';
        await renderPicker();
        expect(content().groups).toMatchObject([{ serverId: homeB, loading: false,
            machines: [{ id: 'machine-1', active: true, availability: { kind: 'available' } }] }]);
        await vi.waitFor(() => expect(content().poolGroups).toMatchObject([{ serverId: homeB,
            pools: [], status: 'idle', projectionReady: true }]));
        await vi.waitFor(() => expectExactReturn('machine-1'));
        expect(navigation.back).toHaveBeenCalledTimes(1);
    });

    it('keeps the picker open when one machine and a machine pool are both available', async () => {
        navigation.params.selectedId = '';
        answerPools(savedHomeB, [pool]);
        await renderPicker();
        await vi.waitFor(() => expect(content().poolGroups?.[0].pools).toEqual([pool]));
        expect(content().poolGroups?.[0].serverId).toBe(homeB);
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('keeps Temporary computer offered and explained when the picker has no exact authoring producer', async () => {
        navigation.params.selectedId = '';
        await account.publishMachines(savedHomeB, []);
        await account.publishFeatures(savedHomeB, features(homeB, true));
        await profiles.adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: homeB,
            canonicalServerUrl: 'https://stack-b.fixture.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://stack-b.fixture.test' }] },
            source: 'qr', descriptorAuthority: 'current_connection_observation' });
        account.home.answer(savedHomeB, EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, { body: artifacts });
        await renderPicker();
        await vi.waitFor(() => expect(content().temporaryComputers).toHaveLength(1));
        const offered = content().temporaryComputers!;
        expect(offered[0]).toMatchObject({ serverId: homeB, artifactTarget: 'linux-x64' });
        expect(offered[0].disabled).not.toBe(true);
        expect(typeof offered[0].unavailableText).toBe('string');
        expect(offered[0].unavailableText!.length).toBeGreaterThan(0);
        expect(account.home.requests.some(request => request.path === EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1)).toBe(true);
        expect(account.home.requests.some(request => request.path === EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1)).toBe(false);
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('resolves a pool against its captured Home and returns the exact machine', async () => {
        navigation.params = { selectedId: '', spawnServerId: homeB, draftId: 'request-7' };
        answerPools(savedHomeB, [pool]);
        account.home.answer(savedHomeB, poolResolvePath, { body: MachinePoolResolveResultV1Schema.parse({ kind: 'resolved',
            poolId: pool.pool.id, machineId: 'machine-1', priorityTier: 0 }) });
        await renderPicker();
        await vi.waitFor(() => expect(content().poolGroups?.[0].projectionReady).toBe(true));
        await act(async () => { await content().onSelectPool?.({ serverId: homeB, accountId: 'account-b', pool }); });
        expect(account.home.requests.filter(request => request.path === poolResolvePath).map(request => ({
            serverId: request.serverId, input: request.input,
        }))).toEqual([{ serverId: savedHomeB, input: { poolId: pool.pool.id, requestKey: 'request-7' } }]);
        expectExactReturn('machine-1');
        expect(returnedParams().at(-1)?.machinePoolId).toBe(pool.pool.id);
    });

    it('keeps the picker open until the pool list is known empty', async () => {
        navigation.params.selectedId = '';
        account.home.answer(savedHomeB, poolListPath, { status: 503, body: { error: 'unavailable' } });
        await renderPicker();
        await vi.waitFor(() => expect(content().poolGroups?.[0].status).toBe('error'));
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('ignores a late pool result after a newer exact-machine choice', async () => {
        navigation.params = { selectedId: '', spawnServerId: homeB, draftId: 'request-8' };
        answerPools(savedHomeB, [pool]);
        const held = createDeferred<void>();
        const requested = createDeferred<void>();
        account.home.answer(savedHomeB, poolResolvePath, { select: async () => {
            requested.resolve(); await held.promise;
            return { body: MachinePoolResolveResultV1Schema.parse({ kind: 'resolved', poolId: pool.pool.id,
                machineId: 'machine-late', priorityTier: 0 }) };
        } });
        await renderPicker();
        await vi.waitFor(() => expect(content().poolGroups?.[0].projectionReady).toBe(true));
        let pending: unknown;
        await act(async () => { pending = content().onSelectPool?.({ serverId: homeB, accountId: 'account-b', pool }); });
        try {
            await requested.promise;
            await act(async () => { content().onSelectMachine(machine('machine-new')); });
        } finally {
            await act(async () => { held.resolve(); await pending; });
        }
        expect(returnedParams().map(params => params.machineId)).toContain('machine-new');
        expect(returnedParams().map(params => params.machineId)).not.toContain('machine-late');
        expect(returnedParams().find(params => params.machineId === 'machine-new')?.machinePoolId).toBeUndefined();
    });

    it('does not auto-select when the only machine for the selected server is offline', async () => {
        navigation.params.selectedId = '';
        // The shared setup published a recent online heartbeat. Replace that
        // census before seeding a Home that only has an expired, offline row;
        // a stale activeAt cannot overwrite a newer live presence observation.
        await account.publishMachines(savedHomeB, []);
        await account.publishMachines(savedHomeB, [machine('machine-1', { active: false, activeAt: 0 })]);
        await renderPicker();
        await vi.waitFor(() => expect(content().poolGroups?.[0].projectionReady).toBe(true));
        expect(content().groups?.[0].machines).toMatchObject([{ id: 'machine-1', active: false }]);
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(navigation.back).not.toHaveBeenCalled();
    });

    it('refreshes machines on mount so newly registered daemons appear in the fallback picker route', async () => {
        await view(homeA);
        navigation.params = { selectedId: 'machine-new', spawnServerId: homeA };
        // Publish the new registration only at HTTP, leaving the real mounted store's old census empty.
        await account.publishMachines(account.serverId, [machine('machine-new')]);
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([], true, { sourceServerId: homeA });
        account.home.requests.length = 0;
        await renderPicker();
        await vi.waitFor(() => expect(content().groups?.[0].machines.map(row => row.id)).toContain('machine-new'));
        expect(account.home.requests.some(request => request.serverId === account.serverId && request.path.split('?')[0] === '/v1/machines')).toBe(true);
    });

    it('normalizes invalid requested serverId to the allowed active target server', async () => {
        navigation.params.spawnServerId = 'removed-requested-home';
        await renderPicker();
        expect(content().serverId).toBe(homeB);
        await act(async () => { content().onSelectMachine(machine()); });
        expectExactReturn('machine-1');
    });

    it('keeps the fallback Home destinations visible when the saved exact Home no longer exists', async () => {
        navigation.params = { selectedId: '' };
        await view('removed-server');
        await account.publishMachines(account.serverId, [machine('machine-a')]);
        await renderPicker();
        expect(content().groups).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: homeA })]));
        await vi.waitFor(() => expect(content().poolGroups).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: homeA })])));
        // The default scope is "All Homes" over every Home this device can use.
        expect(content().groups?.map(group => group.serverId)).toEqual([homeA, homeB, homeC]);
    });

    it('renders grouped selector when target is a group with multiple servers', async () => {
        await view(null, { id: 'grp-dev', serverIds: [homeB, homeC] });
        await renderPicker();
        expect(content().groups).toHaveLength(2);
        expect(content().groups?.map(group => group.serverId)).toEqual([homeB, homeC]);
        expect(content().onSelectScopedMachine).toEqual(expect.any(Function));
    });

    it('keeps the captured destination Home while the active Home changes within the allowed Homes', async () => {
        navigation.params = { selectedId: '' };
        await view(null);
        await account.publishMachines(savedHomeB, [machine('machine-b')]);
        await renderPicker();
        expect(content().selectedServerId).toBe(homeA);
        await act(async () => { await profiles.setActiveServerId(homeB, { scope: 'tab' }); });
        expect(profiles.getActiveServerSnapshot().serverId).toBe(homeB);
        // An unpersisted authoring destination is not moved by an unrelated active-Home switch,
        // and every allowed Home stays offered.
        await act(async () => {});
        expect(content().selectedServerId).toBe(homeA);
        expect(content().groups?.map(group => group.serverId)).toEqual(expect.arrayContaining([homeA, homeB, homeC]));
    });
});
