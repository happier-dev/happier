import * as React from 'react';
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

afterEach(() => standardCleanup());
const { SetupOriginRow } =
  await import('./presentPluginEventAutomationSetupSurface');
const { SessionMachineField } =
  await import('@/components/sessions/new/placement/SessionPlacementChips');
const { storage } = await import('@/sync/domains/state/storage');

// QA-SWEEP-172 #201: "Check from" inside the open Add check form is a Machine field over the composer's usable watchers
// (21fe08b30ac), current one marked; choosing another moves the open form there. Without choices it stays a fact.
it('offers the usable watchers as a Machine field and moves the open form to the chosen one', async () => {
  const scope = { serverId: 'home', accountId: 'account' };
  storage.setState({ profileScope: scope });
  storage
    .getState()
    .applyMachines(
      [
        createMachineFixture({
          id: 'machine-a',
          installationId: 'installation-a',
        }),
        createMachineFixture({
          id: 'machine-b',
          installationId: 'installation-b',
        }),
        createMachineFixture({
          id: 'machine-c',
          installationId: 'installation-c',
        }),
      ],
      true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId },
    );
  const chooseWatcher = vi.fn(() => true);
  const screen = await renderScreen(
    <SetupOriginRow
      label="Check from"
      machineId="machine-a"
      serverId={scope.serverId}
      watcherChoices={[
        { machineId: 'machine-a', selected: true },
        { machineId: 'machine-b', selected: false },
      ]}
      chooseWatcher={chooseWatcher}
    />,
  );
  const field = screen.findAllByType(SessionMachineField)[0];
  expect(field?.props.machineId).toBe('machine-a');
  expect(
    (field?.props.machines as readonly { id: string }[])
      .map((machine) => machine.id)
      .sort(),
  ).toEqual(['machine-a', 'machine-b']);
  field?.props.onSelectMachine({ id: 'machine-b' });
  expect(chooseWatcher).toHaveBeenCalledWith('machine-b');
  await screen.unmount();
  const fact = await renderScreen(
    <SetupOriginRow
      label="Check from"
      machineId="machine-a"
      serverId={scope.serverId}
      chooseWatcher={chooseWatcher}
    />,
  );
  expect(fact.findAllByType(SessionMachineField)).toHaveLength(0);
});
