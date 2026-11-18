import { describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
import { renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

vi.mock('react-native', async () => {
  const { createReactNativeAppStateEmitter, createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    AppState: createReactNativeAppStateEmitter('active').appState,
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const { useFleetUpdates } = await import('./useFleetUpdates');

describe('fleet Updates membership', () => {
  it('lists the Machines collection members: an ended creation and a host-bound sandbox are not fleet rows', async () => {
    const homeId = 'srv_fleet_updates_home';
    const managed = (
      id: string,
      enrolledMachineId: string,
      extra: Partial<ManagedMachineV1>,
    ): ManagedMachineV1 => ({
      id,
      homeId,
      custodianAccountId: 'account-a',
      launch: {
        provider: { pluginId: 'custom.provisioner', localId: 'native' },
        schemaVersion: 1,
        name: id,
        choices: {},
      },
      controller: { machineId: 'controller', installationId: 'installation' },
      allocation: 'confirmed-absent',
      creationState: 'active',
      desired: 'delete',
      desiredWhen: 'now',
      intentRevision: 1,
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
      enrolledMachineId,
      ...extra,
    });
    const ended = managed('old-build-box', 'retained-enrollment', {
      archivedAt: 1,
    });
    const sandbox = managed('kept-sandbox', 'sandbox-enrollment', {
      acquisitionMode: 'resource-bound',
    } as Partial<ManagedMachineV1>);
    const homes = await serveAccountHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://fleet-updates.test',
          serverIdentityId: homeId,
          accountId: 'account-a',
        },
      ],
      route: (request) =>
        request.path === '/v1/machines/managed/actions/list'
          ? Response.json({
              machines:
                request.body &&
                typeof request.body === 'object' &&
                'archived' in request.body
                  ? [ended, sandbox]
                  : [sandbox],
            })
          : undefined,
    });
    try {
      const serverId = homes.homes.a!.id;
      await publishMachineInventoryForTest(
        { serverId, accountId: 'account-a' },
        ['current', 'retained-enrollment', 'sandbox-enrollment'].map((id) =>
          createMachineFixture({ id, active: false, activeAt: 1 }),
        ),
      );
      const fleet = await renderHook(() => useFleetUpdates(serverId));
      try {
        await vi.waitFor(() =>
          expect(
            fleet.getCurrent().machines.map((machine) => machine.machineId),
          ).toEqual(['current']),
        );
        // The page's count line and the column's Updates entry read this summary: one offline Machine, not three.
        expect(fleet.getCurrent().summary.offline).toHaveLength(1);
      } finally {
        await fleet.unmount();
      }
    } finally {
      await homes.dispose();
    }
  });
});
