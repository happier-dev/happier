// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import type { Machine } from '@/sync/domains/state/storageTypes';

const probe = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'page-machine', serverId: 'srv_machine_foreign', tab: 'overview' },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
        addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(probe.rpc));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MachinePageScreen } = await import('./MachinePageScreen');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');

beforeEach(() => { installReactDomPortalBoundaryForTests(); });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); probe.rpc.mockReset(); });

// A busy Account's other Machines publish daemon state every resource sample (each advances
// `daemonStateVersion`). None of that is a fact of this Machine's page, so the page commits nothing.
it('commits nothing on a Machine page for other Machines\' daemon publications', async () => {
    const serverId = 'srv_machine_foreign';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-foreign.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const page = createMachineFixture({ id: 'page-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false });
    // Current daemons publish their registry projection revision, so a resource sample is not a registry change.
    const daemonState = { status: 'running', pid: 4242, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'];
    let other: Machine = createMachineFixture({ id: 'other-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false,
        daemonState, daemonStateVersion: 1 });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [page.id]: page, [other.id]: other },
        machineListByServerId: { [serverId]: [page, other] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    probe.rpc.mockImplementation(() => new Promise(() => {}));
    let commits = 0;
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}>
        <React.Profiler id="Machine page" onRender={() => { commits += 1; }}><MachinePageScreen /></React.Profiler>
    </AuthProvider>);
    onTestFinished(() => screen.unmount());
    expect(screen.findByTestId('machine-page-tabs')).not.toBeNull();
    // Let mount-time reads settle: count only what the publications cause.
    for (let quiet = 0, seen = -1; quiet < 3 && commits < 1_000;) {
        seen = commits;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
        quiet = commits === seen ? quiet + 1 : 0;
    }
    const publishSample = async (sample: number) => {
        other = { ...other, daemonStateVersion: (other.daemonStateVersion ?? 0) + 1,
            daemonState: { ...(other.daemonState ?? {}), resources: { v: 1, sampledAt: sample } } as Machine['daemonState'] };
        await act(async () => storage.getState().applyMachines([other], false, { sourceServerId: serverId }));
    };
    // The first publication after mount settles once (Overview's capability/inventory readers adopt their first
    // live snapshot); the steady state is what a busy Account pays every sample.
    await publishSample(0);
    commits = 0;
    for (let sample = 1; sample <= 4; sample++) await publishSample(sample);
    expect(commits).toBe(0);
});
