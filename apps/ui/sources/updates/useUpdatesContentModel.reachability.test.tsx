import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { UpdatesActionOutputSchemas } from '@happier-dev/protocol/actions/updatesActionFamily';
import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Native OTA and desktop event listeners are genuine platform boundaries.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('expo-updates', () => ({
    useUpdates: () => ({ currentlyRunning: { isEmbeddedLaunch: true }, isChecking: false,
        isDownloading: false, isRestarting: false, isUpdateAvailable: false, isUpdatePending: false }),
    checkForUpdateAsync: async () => ({ isAvailable: false }),
}));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { recordMachineRequestFailed, recordMachineRequestSucceeded, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useUpdatesContentModel } = await import('./useUpdatesContentModel');
const { useUpdatesSummary } = await import('./useUpdatesSummary');
const groupBuilders = await import('./buildMachineUpdateGroups');
const machineNames = await import('@/utils/sessions/machineDisplayNames');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const before = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let machineRowReads = 0;
let managedReads = 0;

afterEach(async () => { standardCleanup(); await connection?.dispose(); connection = undefined;
    storage.setState(before, true); clearMachineRequestReachabilityForTest(); network.resetRequests(); machineRowReads = 0; managedReads = 0; });
afterAll(() => network.dispose());

async function restoreUpdatesHome() {
    const accountHome = await network.addHome('https://updates-retry.test', 'updates-account');
    const serverIdentityId = 'srv_updates_reachability';
    connection = await restoreServerAccountForTest({ serverUrl: accountHome.serverUrl, serverIdentityId, accountId: accountHome.accountId,
        credentials: { token: accountHome.token }, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines/managed/actions/get') {
                managedReads++;
                return Response.json({ code: 'controller_unavailable' }, { status: 503 });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId } } }));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            // The Home's own Machine row is the transport authority the capability read refreshes.
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                machineRowReads += 1;
                return createMachineReadBatchResponseFixture(init.body,
                    id => createPlainMachineRowFixture({ id, accountId: accountHome.accountId, machine: storage.getState().machines[id] }));
            }
            if (path.startsWith('/v1/machines/')) return Response.json({ machine: createPlainMachineRowFixture({
                id: decodeURIComponent(path.slice('/v1/machines/'.length)), accountId: accountHome.accountId,
                machine: storage.getState().machines[decodeURIComponent(path.slice('/v1/machines/'.length))] }) });
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            return null;
        } });
    // The restored Account lifetime names the Home that is actually active.
    const scope = { serverId: connection.serverId, accountId: accountHome.accountId };
    await flushHookEffects();
    return scope;
}

it.each([undefined, 'studio'])('routes managed guest updates through their Home without public latest (surface %s)', async (machineId) => {
    const scope = await restoreUpdatesHome();
    const template = createMachineFixture();
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain',
        managedMachineRef: { homeId: 'srv_updates_reachability', managedId: 'retained' },
        // The incident's 0.3 development payload still reported package version 0.2.10.
        metadata: { ...template.metadata!, cliUpdate: { currentVersion: '0.2.10', latestVersion: '0.2.20',
            channel: 'stable', installSource: 'managed', updateCommand: null, canUpdateRemotely: true, lastUpdate: null } } });
    storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
    network.respond(RPC_METHODS.CAPABILITIES_INVOKE, { supported: false, reason: 'not-supported' });
    const hook = await renderHook(() => useUpdatesContentModel({ machineId }));
    // Retained Machine tabs can mount after the requested Machine's surface.
    const otherMachine = await renderHook(() => useUpdatesContentModel({ machineId: 'other' }));
    try {
        await flushHookEffects();
        const item = hook.getCurrent().groups.flatMap(group => group.items).find(item => item.subject.kind === 'happier-cli');
        expect(item).toBeDefined();
        if (!machineId) {
            const listed = await createFrontDoorActionExecute().confirmed('updates.get', {}, {
                surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
            });
            expect(listed).toMatchObject({ ok: true, result: { groups: expect.arrayContaining([
                expect.objectContaining({ groupId: 'app' }),
            ]) } });
        }
        await act(async () => { const result = await createFrontDoorActionExecute().confirmed('machines.cli.update',
            { target: { kind: 'machine', machineId: machine.id } }, { surface: 'ui', authority: 'present_user',
                serverId: scope.serverId, expectedAccountId: scope.accountId });
            expect(result).toMatchObject({ ok: false, errorCode: 'controller_unavailable' }); });
        expect(managedReads).toBe(1);
        expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE
            && JSON.stringify(request).includes('cli.update.v1'))).toHaveLength(0);
    } finally { await otherMachine?.unmount(); await hook.unmount(); }
});

it('Checks updates explicitly on a request-unreachable machine through the mounted Action owner', async () => {
    const scope = await restoreUpdatesHome();
    // Match the Plain Machine producer; metadata presence alone is not a content-mode authority.
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain' });
    const machines = [machine,
        createMachineFixture({ id: 'locked', activeAt: Date.now(), availability: { kind: 'locked', reason: 'content_unreadable' } }),
        createMachineFixture({ id: 'revoked', activeAt: Date.now(), revokedAt: Date.now() }),
        createMachineFixture({ id: 'replaced', activeAt: Date.now(), replacedByMachineId: machine.id }),
    ];
    storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
        machines: Object.fromEntries(machines.map(row => [row.id, row])), machineListByServerId: { [scope.serverId]: machines },
        machineListStatusByServerId: { [scope.serverId]: 'idle' } }));
    recordMachineRequestFailed({ ...scope, machineId: machine.id });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
    const hook = await renderHook(() => useUpdatesContentModel());
    await flushHookEffects();
    expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toHaveLength(0);
    try {
        await act(async () => {
            const root = storage.getState();
            storage.getState().applyMachineActivityUpdates([
                { id: machine.id, active: true, activeAt: machine.activeAt + 1 },
            ], { sourceServerId: scope.serverId });
            // The arrival is synchronous. An unrelated Account bootstrap can
            // finish after this turn (for example isSessionDraftsReady).
            expect(storage.getState()).toBe(root);
        });
        expect(hook.getCurrent().groups.find(group => group.machineId === machine.id))
            .toMatchObject({ online: false, lastSeenAt: machine.activeAt + 1 });
        expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toHaveLength(0);
        const execute = createFrontDoorActionExecute();
        await act(async () => {
            const checked = await execute.confirmed('updates.check', {}, { surface: 'ui', authority: 'present_user',
                serverId: scope.serverId, expectedAccountId: scope.accountId });
            if (!checked.ok) throw new Error(checked.errorCode);
            expect(UpdatesActionOutputSchemas['updates.check'].parse(checked.result)).toEqual({ status: 'requested' });
        });
        await vi.waitFor(() => expect(network.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_DETECT
            && request.targetId === machine.id)).toBe(true));
        expect(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)
            .every(request => request.targetId === machine.id)).toBe(true);
        // The row counter must see a real, explicitly demanded authority read.
        expect(machineRowReads).toBeGreaterThan(0);
    } finally { await hook.unmount(); }
});

it('one Machine’s Security tab reads and asks only that Machine, without the This app group', async () => {
    const scope = await restoreUpdatesHome();
    const machines = [createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain' }),
        createMachineFixture({ id: 'vps-1', activeAt: Date.now(), storageMode: 'plain' })];
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    for (const machine of machines) recordMachineRequestSucceeded({ ...scope, machineId: machine.id });
    network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {} });
    const hook = await renderHook(() => useUpdatesContentModel({ machineId: 'vps-1' }));
    try {
        await flushHookEffects();
        expect(hook.getCurrent().groups.map(group => group.machineId)).toEqual(['vps-1']);
        expect(hook.getCurrent().groups[0]).toMatchObject({ online: true });
        await vi.waitFor(() => expect(network.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)).toBe(true));
        expect(new Set(network.requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT)
            .map(request => request.targetId))).toEqual(new Set(['vps-1']));
    } finally { await hook.unmount(); }
});

it('selects only update facts for 137 Machines across heartbeat, display and presence publications', async () => {
    const scope = await restoreUpdatesHome();
    const template = createMachineFixture();
    const cliUpdate = { currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable' as const,
        installSource: 'managed' as const, updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null };
    const machines = Array.from({ length: 137 }, (_, index) => createMachineFixture({
        id: `updates-${index}`, activeAt: Date.now(), storageMode: 'plain',
        metadata: { ...template.metadata!, happyCliVersion: cliUpdate.currentVersion, cliUpdate },
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
    const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
    const agentKey = serverAccountScopedResourceKey(scope, 'machine-agents', machines[2]!.id);
    const agentItem = {
        agentId: 'review', title: 'Review', installed: true, version: '1.0.0', latestVersion: '2.0.0',
        update: { supported: true, command: null }, signIn: { status: 'signedIn', loginSupport: 'status_only' },
        platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null },
        dependencies: [],
    } satisfies MachineAgentInventoryItem;
    machineAgentInventoryStore.publish(agentKey, { status: 'ready', lastCheckedAt: Date.now(), items: [agentItem] });
    const groups = vi.spyOn(groupBuilders, 'buildMachineUpdateGroups');
    const names = vi.spyOn(machineNames, 'resolveMachineDisplayNames');
    const hook = await renderHook(() => useUpdatesSummary());
    await flushHookEffects();
    expect(hook.getCurrent().actionableCount).toBe(138);
    expect(machineAgentInventoryStore.read(agentKey).agents[0]).toMatchObject({ installed: true, stale: false });
    // Positive controls: the real shared item policy ran, and the always-mounted
    // summary has current admitted Machines rather than an empty mock store.
    expect(groups.mock.calls.length).toBeGreaterThan(0);
    names.mockClear();
    const { buildRemoteMachineUpdateFacts } = await import('./remoteCliUpdateItems');
    expect(buildRemoteMachineUpdateFacts(machines, null, new Map(), new Map(), scope)).toHaveLength(137);
    expect(names).toHaveBeenCalledTimes(1);
    groups.mockClear(); names.mockClear();
    const rowReadsBeforeArrivals = machineRowReads;
    let rootPublications = 0;
    const stop = storage.subscribe(() => { rootPublications += 1; });
    try {
        for (let arrival = 1; arrival <= 20; arrival += 1) {
            await act(async () => {
                const machine = storage.getState().machines[machines[0]!.id]!;
                storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true,
                    activeAt: machine.activeAt + arrival }], { sourceServerId: scope.serverId });
                // A real metadata publication changes only presentation, including
                // a newly parsed but unchanged CLI facts object.
                storage.getState().applyMachines([{ ...machine, updatedAt: machine.updatedAt + 1,
                    metadata: { ...machine.metadata!, host: `presentation-${arrival}`, cliUpdate: { ...cliUpdate } },
                }], false, { sourceServerId: scope.serverId });
                storage.getState().replaceMachineDisplays(Object.values(storage.getState().machineDisplayById)
                    .map(row => ({ ...row, updatedAt: row.updatedAt + 1 })), { sourceServerId: scope.serverId });
                // Exercise published presence identities too, not only the now
                // root-quiet heartbeat writer. No presence verdict changes.
                storage.setState(state => ({ machinePresenceById: { ...state.machinePresenceById },
                    machinePresenceByServerId: { ...state.machinePresenceByServerId } }));
            });
        }
        expect(rootPublications).toBeGreaterThanOrEqual(20);
        console.info('PERF_UPDATES_SUMMARY_COUNTS', JSON.stringify({ machines: 137, arrivals: 20,
            rootPublications, groupRebuilds: groups.mock.calls.length, nameComputations: names.mock.calls.length,
            machineRowReads: machineRowReads - rowReadsBeforeArrivals }));
        expect(machineRowReads).toBe(rowReadsBeforeArrivals);
        expect(groups).toHaveBeenCalledTimes(0);
        expect(names).toHaveBeenCalledTimes(0);
        expect(hook.getCurrent().actionableCount).toBe(138);

        await act(async () => {
            const machine = storage.getState().machines[machines[0]!.id]!;
            storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, cliUpdate: { ...cliUpdate, currentVersion: cliUpdate.latestVersion } },
            }], false, { sourceServerId: scope.serverId });
        });
        expect(groups).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().actionableCount).toBe(137);
        groups.mockClear();

        network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {
            'tool.systemTasks': { ok: true, checkedAt: Date.now(), data: { kinds: [] } },
        } });
        const { refreshMachineUpdateFacts } = await import('./machineUpdateRuns');
        await act(async () => {
            refreshMachineUpdateFacts(scope.serverId, machines[1]!.id, { accountScope: scope });
        });
        await vi.waitFor(() => expect(hook.getCurrent().actionableCount).toBe(136));
        await flushHookEffects();
        expect(groups).toHaveBeenCalledTimes(1);
        groups.mockClear();

        await act(async () => recordMachineRequestFailed({ ...scope, machineId: machines[2]!.id }));
        await flushHookEffects();
        expect(machineAgentInventoryStore.read(agentKey).agents[0]).toMatchObject({ installed: true, version: '1.0.0', stale: true });
        expect(groups).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().actionableCount).toBe(134);
        groups.mockClear();

        await act(async () => recordMachineRequestSucceeded({ ...scope, machineId: machines[2]!.id }));
        await flushHookEffects();
        expect(groups).toHaveBeenCalledTimes(1);
        // Reachability recovery restores the Machine CLI, not stale Agent update
        // authority. Only a real inventory answer may restore that second action.
        expect(machineAgentInventoryStore.read(agentKey).agents[0]).toMatchObject({ stale: true });
        expect(hook.getCurrent().actionableCount).toBe(135);
        groups.mockClear();
        await act(async () => machineAgentInventoryStore.publish(agentKey, {
            status: 'ready', lastCheckedAt: Date.now(), items: [agentItem],
        }));
        expect(groups).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().actionableCount).toBe(136);
        // Names belong to the open detail surface, not the closed pill's counts.
        expect(names).toHaveBeenCalledTimes(0);
    } finally { stop(); await hook.unmount(); groups.mockRestore(); names.mockRestore(); }
});

it('keeps the published Updates summary when arrivals change rows but no summary fact', async () => {
    const scope = await restoreUpdatesHome();
    const template = createMachineFixture();
    const cliUpdate = { currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable' as const,
        installSource: 'managed' as const, updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null };
    const machines = Array.from({ length: 3 }, (_, index) => createMachineFixture({
        id: `summary-identity-${index}`, activeAt: Date.now(), storageMode: 'plain',
        metadata: { ...template.metadata!, happyCliVersion: cliUpdate.currentVersion, cliUpdate },
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    const { UpdatesSummaryProvider, useSharedUpdatesSummary } = await import('./useUpdatesSummary');
    const published: unknown[] = [];
    // An always-mounted chrome entry: it re-renders only when the provider publishes a new value.
    const Entry = React.memo(function Entry() {
        published.push(useSharedUpdatesSummary());
        return null;
    });
    const screen = await renderScreen(<UpdatesSummaryProvider><Entry /></UpdatesSummaryProvider>);
    await flushHookEffects();
    const first = published.at(-1) as { actionableCount: number };
    expect(first.actionableCount).toBe(3);
    const rendersBefore = published.length;
    const { refreshMachineUpdateFacts } = await import('./machineUpdateRuns');
    try {
        for (let arrival = 1; arrival <= 3; arrival += 1) {
            // A newer CLI release keeps the row actionable: the row changes, the summary does not.
            await act(async () => {
                const machine = storage.getState().machines[machines[0]!.id]!;
                storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, cliUpdate: { ...cliUpdate, latestVersion: `0.2.${13 + arrival}` } },
                }], false, { sourceServerId: scope.serverId });
            });
            // A background re-detect answers the same facts with a new check time.
            network.respond(RPC_METHODS.CAPABILITIES_DETECT, { protocolVersion: 1, results: {
                'tool.systemTasks': { ok: true, checkedAt: Date.now() + arrival, data: { kinds: ['cli.update.v1'] } },
            } });
            await act(async () => {
                await refreshMachineUpdateFacts(scope.serverId, machines[1]!.id, { accountScope: scope });
            });
            await flushHookEffects();
        }
        console.info('PERF_UPDATES_SUMMARY_PUBLICATIONS', JSON.stringify({ arrivals: 6,
            entryRenders: published.length - rendersBefore, identities: new Set(published.slice(rendersBefore - 1)).size }));
        expect(published.length - rendersBefore).toBe(0);
        expect(published.at(-1)).toBe(first);

        // Positive control: a real summary change still reaches the entry once.
        await act(async () => {
            const machine = storage.getState().machines[machines[2]!.id]!;
            storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, cliUpdate: { ...cliUpdate, currentVersion: cliUpdate.latestVersion } },
            }], false, { sourceServerId: scope.serverId });
        });
        await flushHookEffects();
        expect(published.length - rendersBefore).toBe(1);
        expect((published.at(-1) as { actionableCount: number }).actionableCount).toBe(2);
    } finally { await screen.unmount(); }
});
