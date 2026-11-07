// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const probe = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'navigation-machine', serverId: 'srv_machine_navigation', tab: 'overview' },
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
const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { Modal } = await import('@/modal');

beforeEach(() => { installReactDomPortalBoundaryForTests(); });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); probe.rpc.mockReset(); });

it('detail-navigation.Machine: lists core pages without mounting siblings and selects through the existing column Action', async () => {
    const serverId = 'srv_machine_navigation';
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-navigation.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'navigation-machine', active: false, activeAt: 0, storageMode: 'plain', isShared: false });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    probe.rpc.mockImplementation(() => new Promise(() => {}));
    const screen = await renderScreen(<AuthProvider initialCredentials={connection.credentials}><MachinePageScreen /></AuthProvider>);
    onTestFinished(() => screen.unmount());
    const listed = await invokeScopeAction('shell.column.get', { column: 'main' });
    expect(listed).toMatchObject({ available: true, activeTab: 'overview', tabs: ['overview', 'services', 'processes', 'storage', 'guard', 'setup', 'security'] });
    expect(screen.findByTestId('machine-page-tab-body.services')).toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.processes')).toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.storage')).toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.guard')).toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.setup')).toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.security')).toBeNull();
    const before = probe.rpc.mock.calls.length;
    await invokeScopeAction('shell.column.get', { column: 'main' });
    expect(probe.rpc.mock.calls).toHaveLength(before);
    const menu = screen.findAllByType(DropdownMenu).find(menu => menu.props.items.some((item: { testID?: string }) => item.testID === 'machine-page-tab.more.customize'))!;
    expect(menu).toBeDefined();
    await act(async () => menu.props.onOpenChange(true));
    const customize = menu.props.items.find((item: { testID?: string }) => item.testID === 'machine-page-tab.more.customize');
    expect(customize).toBeDefined();
    await act(async () => menu.props.onSelect(customize.id));
    await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
    expect(probe.rpc.mock.calls).toHaveLength(before);
    for (const id of ['services', 'processes', 'storage', 'guard']) expect(screen.findByTestId(`machine-page-tab-body.${id}`)).toBeNull();
    await act(async () => { expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'guard' })).toEqual({ ok: true }); });
    expect(screen.findByTestId('machine-page-tab-body.guard')).not.toBeNull();
    expect(screen.findByTestId('machine-page-tab-body.storage')).toBeNull();
    // A stopped Machine is navigable; describing/selecting chrome must not start it.
    expect(probe.rpc.mock.calls.some(([call]) => /wake|power|start/i.test(String(call.method)))).toBe(false);
});
