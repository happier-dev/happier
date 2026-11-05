// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const probe = vi.hoisted(() => ({ rpc: vi.fn(), width: 390 }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'pushed-machine', serverId: 'srv_machine_pushed', tab: 'services', page: 'service', service: 'web' },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: probe.width, height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: probe.width, height: 844, scale: 1, fontScale: 1 }),
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

async function mountPushedServicePage() {
    const serverId = 'srv_machine_pushed';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-pushed.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'pushed-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    probe.rpc.mockImplementation(() => new Promise(() => {}));
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}><MachinePageScreen /></AuthProvider>);
    onTestFinished(() => screen.unmount());
    expect(screen.findByTestId('machine-service-page')).not.toBeNull();
    return screen;
}

it('a page a tab pushes owns the top of a phone, with no Machine header above it', async () => {
    probe.width = 390;
    const screen = await mountPushedServicePage();
    expect(screen.findByTestId('machine-service-back')).not.toBeNull();
    expect(screen.findByTestId('machine-detail-header')).toBeNull();
});

it('a wide page keeps the Machine header and tabs above the page a tab pushes', async () => {
    probe.width = 1440;
    const screen = await mountPushedServicePage();
    expect(screen.findByTestId('machine-detail-header')).not.toBeNull();
});
