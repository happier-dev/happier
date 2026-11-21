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

const probe = vi.hoisted(() => ({
    rpc: vi.fn(),
    headerCommits: 0,
    params: { id: 'page-machine', serverId: 'srv_machine_foreign', tab: 'overview' },
}));
vi.mock('./MachinePageHeader', async importOriginal => {
    const actual = await importOriginal<typeof import('./MachinePageHeader')>();
    return {
        ...actual,
        MachinePageHeader: (props: React.ComponentProps<typeof actual.MachinePageHeader>) => (
            <React.Profiler id="Machine header" onRender={() => { probe.headerCommits += 1; }}>
                <actual.MachinePageHeader {...props} />
            </React.Profiler>
        ),
    };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => probe.params,
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

// The Overview still updates its vitals leaf. Its header and the whole Sandboxes tab
// have no reason to commit when only a resource sample changes.
it.each(['overview', 'sandboxes'])('keeps the %s page quiet for unrelated resource arrivals', async tab => {
    probe.params.tab = tab;
    probe.headerCommits = 0;
    const serverId = 'srv_machine_foreign';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-foreign.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    // Current daemons publish their registry projection revision, so a resource sample is not a registry change.
    const daemonState = { status: 'running', pid: 4242, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'];
    const page = createMachineFixture({ id: 'page-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false,
        installationId: 'installation', daemonState, daemonStateVersion: 1 });
    const other = createMachineFixture({ id: 'other-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false,
        daemonState, daemonStateVersion: 1 });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [page.id]: page, [other.id]: other },
        machineListByServerId: { [serverId]: [page, other] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    probe.rpc.mockImplementation(() => new Promise(() => {}));
    let commits = 0;
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}>
        <React.Profiler id="Machine page" onRender={() => { commits += 1; }}><MachinePageScreen /></React.Profiler>
    </AuthProvider>);
    onTestFinished(() => screen.unmount());
    expect(screen.findByTestId(`machine-page-tab:${tab}`)?.props.accessibilityState?.selected).toBe(true);
    // Let mount-time reads settle: count only what the publications cause.
    for (let attempt = 0, quiet = 0; attempt < 10 && quiet < 3; attempt++) {
        const seen = commits;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
        quiet = commits === seen ? quiet + 1 : 0;
    }
    const publishSample = async (machine: Machine, sample: number) => {
        const row: Machine = { ...machine, daemonStateVersion: sample + 2, seq: sample + 2, updatedAt: sample + 2,
            daemonState: { ...daemonState, resources: { v: 1, vitals: { state: 'unavailable', reason: 'reader_failed', since: sample },
                attention: { level: 'calm', reasons: [] } } } };
        const before = tab === 'overview' ? probe.headerCommits : commits;
        await act(async () => storage.getState().applyMachines([row], false, { sourceServerId: serverId }));
        return (tab === 'overview' ? probe.headerCommits : commits) - before;
    };
    // The first publication after mount settles once (Overview's capability/inventory readers adopt their first
    // live snapshot); the steady state is what a busy Account pays every sample.
    await publishSample(other, 0);
    await publishSample(page, 0);
    const foreign: number[] = [];
    const selected: number[] = [];
    for (let sample = 1; sample <= 4; sample++) {
        foreign.push(await publishSample(other, sample));
        selected.push(await publishSample(page, sample));
    }
    expect({ foreign, selected }).toEqual({ foreign: [0, 0, 0, 0], selected: [0, 0, 0, 0] });
    if (tab === 'overview') {
        const before = commits;
        await publishSample(page, 5);
        expect(commits - before).toBeGreaterThan(0);
    }
});
