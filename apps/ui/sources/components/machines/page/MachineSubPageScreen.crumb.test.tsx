// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  createMachineFixture,
  findTestInstanceByTypeWithProps,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';

const probe = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      params: {
        id: 'crumb-machine',
        serverId: 'srv_machine_crumb',
        page: 'network',
      },
    }).module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({
      width: 1440,
      height: 1000,
      scale: 1,
      fontScale: 1,
    }),
    Dimensions: {
      get: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
      addEventListener: () => ({ remove: () => {} }),
    },
  }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () =>
    (
      await import('@/dev/testkit/mocks/serverScopedRpc')
    ).createServerScopedMachineRpcBoundaryMock(probe.rpc),
);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MachineSubPageScreen } = await import('./MachineSubPageScreen');
const { MachineTabSubHead } = await import('./MachineTabSubHead');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { t } = await import('@/text');

beforeEach(() => {
  installReactDomPortalBoundaryForTests();
  probe.rpc.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  standardCleanup();
  vi.restoreAllMocks();
  probe.rpc.mockReset();
});

async function crumbFor(hydrating: boolean) {
  const serverId = 'srv_machine_crumb';
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://machine-crumb.example.test',
    serverIdentityId: serverId,
  });
  onTestFinished(() => connection.dispose());
  const settled = createMachineFixture({
    id: 'crumb-machine',
    active: true,
    activeAt: Date.now(),
    storageMode: 'plain',
  });
  // Its row is listed, but its details are still being read (no metadata, no availability verdict yet).
  const machine = hydrating
    ? { ...settled, metadata: null, availability: undefined }
    : settled;
  storage.setState({
    isDataReady: true,
    machines: { [machine.id]: machine },
    machineListByServerId: { [serverId]: [machine] },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
  const screen = await renderScreen(
    <AuthProvider initialCredentials={connection.credentials}>
      <MachineSubPageScreen />
    </AuthProvider>,
  );
  onTestFinished(() => screen.unmount());
  return findTestInstanceByTypeWithProps(screen, MachineTabSubHead, {
    testID: 'machine-sub-page-header-network',
  })?.props.back?.label;
}

it('never names the way back with the loading placeholder while the Machine is still being read', async () => {
  const label = await crumbFor(true);
  expect(label).toBe(t('machine.back'));
});

it('names the way back for the Machine once its name is read', async () => {
  const label = await crumbFor(false);
  expect(label).not.toBe(t('machine.back'));
  expect(typeof label === 'string' && label.length > 0).toBe(true);
});
