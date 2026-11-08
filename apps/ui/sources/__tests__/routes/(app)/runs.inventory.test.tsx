import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';
import { storage } from '@/sync/domains/state/storage';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const routerMock = createExpoRouterMock();
installRouteRootCommonModuleMocks({ router: () => routerMock.module });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// A reachable daemon has no Runs; inventory and Account owners remain real.
installSessionActionRpcBoundary(async request => {
    const method = request.method.slice(request.method.indexOf(':') + 1);
    if (method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST) return { runs: [] };
    if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
    throw Object.assign(new Error('Fixture method unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
});
const initial = storage.getState();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const disposeActionLoader = await installRealActionExecutorModuleLoader();
const { sync } = await import('@/sync/sync');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
beforeEach(async () => { routerMock.resetParams(); await homes.reset(); browser = await installBrowserRuntimeForTests({ url: 'https://runs-inventory.test' }); });
afterEach(async () => {
    try {
        await standardCleanup(); await connection?.dispose(); connection = undefined;
        await homes.reset(); storage.setState(initial, true);
    } finally {
        browser?.restore(); browser = undefined;
    }
});
afterAll(() => disposeActionLoader());

async function connectInventory(profileId: string, machine: Machine) {
    const profile = getServerProfileById(profileId)!;
    const row = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'runs-account', machine }),
        active: machine.active, activeAt: machine.activeAt, revokedAt: machine.revokedAt ?? null };
    homes.answer(profileId, '/v1/machines', { body: [row] });
    homes.answer(profileId, `/v1/machines/${machine.id}`, { body: { machine: row } });
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
    if (!credentials) throw new Error('Inventory Account fixture is unavailable');
    connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl,
        serverIdentityId: profile.serverIdentityId!, accountId: 'runs-account', credentials, request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
    await waitForHomeGovernance(() => expect(storage.getState().machineListStatusByServerId[profile.serverIdentityId!]).toBe('idle'));
    // Preserve the real active Home rows while removing the concurrent-list projection.
    storage.setState({ machineListByServerId: {}, machineListStatusByServerId: {} });
}

it('shows the active Home machine when the concurrent inventory has no row for that Home', async () => {
    const profileId = await homes.addHome({ name: 'Inventory', serverIdentityId: 'srv_runs_inventory',
        serverUrl: 'https://runs-inventory.test', accountId: 'runs-account', currentAccount: true });
    const machine = createMachineFixture({ activeAt: Date.now(), metadata: {
        host: 'ubuntu-03', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/tmp/happier', homeDir: '/tmp',
    } });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    await connectInventory(profileId, machine);
    const Runs = (await import('@/app/(app)/runs')).default;
    const screen = await renderScreen(<Runs />);
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('runs.open-machine')).not.toBeNull());
});

it('does not offer revoked machines that the Machines inventory excludes', async () => {
    const profileId = await homes.addHome({ name: 'Visibility', serverIdentityId: 'srv_runs_visibility',
        serverUrl: 'https://runs-visibility.test', accountId: 'runs-account', currentAccount: true });
    const machine = createMachineFixture({ activeAt: Date.now(), revokedAt: Date.now() });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    await connectInventory(profileId, machine);
    const Runs = (await import('@/app/(app)/runs')).default;
    const screen = await renderScreen(<Runs />);
    expect(screen.findHostByTestId('runs.open-machine')).toBeNull();
});

it('reads a retained Runs destination scope instead of another browser destination scope', async () => {
    const profileId = await homes.addHome({ name: 'Retained', serverIdentityId: 'srv_runs_retained',
        serverUrl: 'https://runs-retained.test', accountId: 'runs-account', currentAccount: true });
    const machine = createMachineFixture({ activeAt: Date.now() });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    await connectInventory(profileId, machine);
    routerMock.state.router.setParams({ serverId: 'srv_another_destination', machineId: machine.id, runId: 'run-a' });
    const Runs = (await import('@/app/(app)/runs')).default;
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const screen = await renderScreen(<DestinationInstanceHost tabId="retained-runs" ref={{ kind: 'runs', params: { serverId: 'srv_runs_retained', machineId: machine.id, runId: 'run-a' } }}
        pathname="/runs" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}><Runs /></DestinationInstanceHost>);
    await waitForHomeGovernance(() => expect(screen.findHostByTestId('runs.open-machine')).not.toBeNull());
});
