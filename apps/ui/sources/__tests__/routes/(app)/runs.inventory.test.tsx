import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';
import { storage } from '@/sync/domains/state/storage';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const routerMock = createExpoRouterMock();
installRouteRootCommonModuleMocks({ router: () => routerMock.module });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// No daemon is present in this inventory-only harness; the real RPC owner fails closed.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { isConnected: () => false } }));
const initial = storage.getState();
beforeEach(() => routerMock.resetParams());
afterEach(async () => { await standardCleanup(); storage.setState(initial, true); });

it('shows the active Home machine when the concurrent inventory has no row for that Home', async () => {
    const home = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_runs_inventory', canonicalServerUrl: 'https://runs-inventory.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://runs-inventory.test' }],
    }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id);
    const machine = createMachineFixture({ activeAt: Date.now(), metadata: {
        host: 'ubuntu-03', happyCliVersion: 'test', happyHomeDir: '/tmp/happier', homeDir: '/tmp',
    } });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    const Runs = (await import('@/app/(app)/runs')).default;
    const screen = await renderScreen(<Runs />);
    expect(screen.findHostByTestId('runs.open-machine')).not.toBeNull();
});

it('does not offer revoked machines that the Machines inventory excludes', async () => {
    const home = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_runs_visibility', canonicalServerUrl: 'https://runs-visibility.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://runs-visibility.test' }],
    }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id);
    const machine = createMachineFixture({ activeAt: Date.now(), revokedAt: Date.now() });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    const Runs = (await import('@/app/(app)/runs')).default;
    const screen = await renderScreen(<Runs />);
    expect(screen.findHostByTestId('runs.open-machine')).toBeNull();
});

it('reads a retained Runs destination scope instead of another browser destination scope', async () => {
    const home = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_runs_retained', canonicalServerUrl: 'https://runs-retained.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://runs-retained.test' }],
    }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    await setActiveServerId(home.id);
    const machine = createMachineFixture({ activeAt: Date.now() });
    storage.setState({ isDataReady: true, machines: { [machine.id]: machine }, machineListByServerId: {},
        machineListStatusByServerId: {}, profile: { ...initial.profile, id: 'runs-account' } });
    routerMock.state.router.setParams({ serverId: 'srv_another_destination', machineId: machine.id, runId: 'run-a' });
    const Runs = (await import('@/app/(app)/runs')).default;
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const screen = await renderScreen(<DestinationInstanceHost tabId="retained-runs" ref={{ kind: 'runs', params: { serverId: 'srv_runs_retained', machineId: machine.id, runId: 'run-a' } }}
        pathname="/runs" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}><Runs /></DestinationInstanceHost>);
    expect(screen.findHostByTestId('runs.open-machine')).not.toBeNull();
});
