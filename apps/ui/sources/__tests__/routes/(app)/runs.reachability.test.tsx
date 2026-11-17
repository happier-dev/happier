import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createStackOptionsCapture } from '@/dev/testkit/mocks/router';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';
import { t } from '@/text';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';

const header = createStackOptionsCapture();
installRouteRootCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ stackOptionsCapture: header }).module,
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Only native presentation leaves are replaced; inventory, admission, and RPC remain real.
vi.mock('@/components/ui/lists/Item', async () => (await import('@/dev/testkit/mocks/components')).createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemGroup', async () => (await import('@/dev/testkit/mocks/components')).createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/ItemList', async () => (await import('@/dev/testkit/mocks/components')).createPassThroughModule(['ItemList']));

const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, readMachineRequestReachabilityObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { useAllProfileMachineInventorySnapshots } = await import('@/sync/domains/machines/useMachineInventorySnapshots');
const { default: RunsScreen } = await import('@/app/(app)/runs');
const previous = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

beforeEach(async () => {
    network.resetRequests();
    header.reset();
    const account = await network.addHome('https://runs-reachability.test', 'runs-account');
    const home = await adoptHomeProfile({ descriptor: { serverUrl: account.serverUrl, homeServerIdentityId: 'srv_runs_reachability' }, source: 'manual' });
    serverId = home.id;
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: account.accountId,
        credentials: { token: account.token }, request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
            if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'studio', accountId: account.accountId })]);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                machineId => machineId === 'studio' ? createPlainMachineRowFixture({ id: machineId, accountId: account.accountId }) : null);
            if (path === '/v1/machines/studio') return Response.json({ machine: createPlainMachineRowFixture({ id: 'studio', accountId: account.accountId }) });
            return null;
        } });
    serverId = connection.home.id;
    const machine = createMachineFixture({ id: 'studio', activeAt: Date.now() });
    storage.setState(state => ({ isDataReady: true, profileScope: { serverId, accountId: account.accountId },
        profile: { ...state.profile, id: account.accountId }, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } }));
    network.respond(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, { runs: [] });
});

afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    storage.setState(previous, true);
    clearMachineRequestReachabilityForTest();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => network.dispose());

it('suppresses automatic run reads after request failure but explicit refresh still reaches the Machine', async () => {
    const inventory = await renderHook(() => useAllProfileMachineInventorySnapshots());
    await vi.waitFor(() => expect(inventory.getCurrent().find(snapshot => snapshot.kind === 'resolved'
        && snapshot.profileId === serverId)).toMatchObject({ accountId: 'runs-account', machines: [expect.objectContaining({ id: 'studio' })] }));
    const snapshot = inventory.getCurrent().find(snapshot => snapshot.kind === 'resolved' && snapshot.profileId === serverId);
    if (snapshot?.kind !== 'resolved' || !snapshot.accountId) throw new Error('Expected a credential-bound Machine inventory');
    recordMachineRequestFailed({ serverId: snapshot.serverIdentityId, accountId: snapshot.accountId, machineId: 'studio' });
    const screen = await renderScreen(<RunsScreen />);
    await flushHookEffects({ cycles: 4 });
    expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toHaveLength(0);
    // A skipped registry read establishes no Machine presence fact.
    expect(screen.findByType(CountedDisclosureItem).props).toMatchObject({ title: t('common.unknown'), count: 1 });
    const HeaderRight = header.getResolved()?.headerRight as React.ComponentType | undefined;
    expect(HeaderRight).toBeDefined();
    const refresh = await renderScreen(React.createElement(HeaderRight!));
    await act(async () => { refresh.findByProps({ accessibilityLabel: t('runs.a11y.refresh') }).props.onPress(); });
    const runReads = () => network.requests.filter(request => request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST);
    await vi.waitFor(() => expect(runReads().length).toBeGreaterThan(0));
    const restoredConnection = connection;
    if (!restoredConnection) throw new Error('Expected the restored Home connection');
    expect(runReads().every(request => request.serverUrl === restoredConnection.home.serverUrl
        && request.token === restoredConnection.credentials.token && request.targetId === 'studio')).toBe(true);
    expect(readMachineRequestReachabilityObservation({ serverId: snapshot.serverIdentityId, accountId: snapshot.accountId }, 'studio'))
        .toMatchObject({ outcome: 'succeeded' });
    await flushHookEffects({ cycles: 4 });
    expect(screen.findAll(node => node.props?.title === t('detailPages.runs.emptyRunning')).length).toBeGreaterThan(0);
    expect(screen.findAllByType(CountedDisclosureItem)).toHaveLength(0);
    const settledReadCount = runReads().length;
    // Recovery publishes once; unrelated renders must not turn that publication into a read storm.
    await act(async () => { screen.update(<RunsScreen />); });
    await flushHookEffects({ cycles: 4 });
    expect(runReads()).toHaveLength(settledReadCount);
    await refresh.unmount();
    await screen.unmount();
    await inventory.unmount();
});
