// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const probe = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'navigation-machine', serverId: 'srv_machine_navigation', page: 'computer' },
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
await import('@/sync/ops/actions/defaultActionExecutor');
const { MachineSubPageScreen } = await import('./MachineSubPageScreen');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { MachineTabSubHead } = await import('./MachineTabSubHead');
const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');

beforeEach(() => { installReactDomPortalBoundaryForTests(); });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); probe.rpc.mockReset(); });

it('names the offline Machine in the page header and uses its canonical reachability cause in the viewer', async () => {
    const serverId = 'srv_machine_navigation';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-navigation.example.test', serverIdentityId: serverId, accountId: 'owner' });
    onTestFinished(() => connection.dispose());
    const baseMachine = createMachineFixture();
    const machine = createMachineFixture({ id: 'navigation-machine', active: false, activeAt: 1, storageMode: 'plain',
        metadata: { ...baseMachine.metadata!, displayName: 'Studio' } });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    await publishMachineInventoryForTest({ serverId: connection.serverId, accountId: 'owner' }, [machine]);
    probe.rpc.mockRejectedValue(new Error('machine_unreachable'));
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}><MachineSubPageScreen /></AuthProvider>);
    onTestFinished(() => screen.unmount());
    expect(screen.root.findByType(MachineTabSubHead).props.description).toContain('machine=Studio');
    await vi.waitFor(() => expect(screen.root.findAllByType(SurfaceStateCard)
        .some(card => card.props.title === 'projects.checkouts.outOfReach(machine=Studio)')).toBe(true));
    expect(screen.getTextContent()).not.toContain('computerUse.presentation.offlineBody');
});

it.each(['owner', 'manage', 'use'] as const)('opens Computer from the Machine page without a Session for %s', async role => {
    const serverId = 'srv_machine_navigation';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-navigation.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'navigation-machine', active: true, activeAt: Date.now(), storageMode: 'plain',
        ...(role === 'owner' ? { isShared: false } : { isShared: true, access: {
            custodian: { accountId: 'machine-owner', displayName: 'Owner' }, role, resourceMode: 'plain', accessState: 'ready',
        } }),
    });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    probe.rpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE || request.method === RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE) {
            return { protocolVersion: 1, result: { consentGranted: false, approvalDisplay: { machineDisplayName: 'Studio', requiresTargetSelection: true } } };
        }
        return new Promise(() => {});
    });
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}><MachineSubPageScreen /></AuthProvider>);
    onTestFinished(() => screen.unmount());
    await vi.waitFor(() => expect(probe.rpc.mock.calls.some(([request]) => request.payload?.actionId === 'computer.target.get')).toBe(true));
    const computer = probe.rpc.mock.calls.map(([request]) => request).filter(request => request.payload?.actionId?.startsWith('computer.'));
    expect(computer).toHaveLength(1);
    expect(computer[0]).toMatchObject({ machineId: machine.id, serverId, method: role === 'use'
        ? RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE : RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
        payload: { actionId: 'computer.target.get', input: { machineId: machine.id } } });
    expect(computer[0].payload.sessionId).toBeUndefined();
    expect(screen.findByTestId('machine-computer-screen')).not.toBeNull();
});
