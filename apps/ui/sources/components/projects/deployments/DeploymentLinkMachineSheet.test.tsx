import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routing = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routing.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

afterEach(() => standardCleanup());
const { showDeploymentLinkMachineSheet } =
  await import('./DeploymentLinkMachineSheet');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storage');

// PAGE-ACCEPT-176 R11-D11: a stored definition's "where it runs" says why only Machines are offered, and the primary
// never offers to link the Machine already linked.
it('says why only Machines are offered and holds the primary on the linked Machine', async () => {
  const scope = { serverId: 'home', accountId: 'account' };
  storage.setState({ profileScope: scope });
  storage.getState().applyMachines([
    createMachineFixture({ id: 'machine-a', installationId: 'installation-a' }),
    createMachineFixture({ id: 'machine-b', installationId: 'installation-b' }),
  ], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
  for (const stored of [true, false]) {
    await act(async () => showDeploymentLinkMachineSheet({ name: 'Production', serverId: scope.serverId,
      suggestedMachineId: 'machine-a', linkedMachineId: 'machine-a', storedDefinition: stored,
      run: vi.fn(), onApproval: () => {} }));
    expect(screen.findByTestId('project-deployments.link.machinesOnly') !== null).toBe(stored);
    expect(screen.findByTestId('project-deployments.link.confirm')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('project-deployments.link.cancel');
    expect(screen.findByTestId('project-deployments.link')).toBeNull();
  }
});
