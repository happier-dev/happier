// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
  readPresentationNotices,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readNavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { AppRailArrivals, useAppRailArrivals } from './AppRailArrivals';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
installDisconnectedServerSocketBoundary();
afterEach(async () => {
  await standardCleanup();
});

const TITLES = {
  deployments: 'Deployments',
  monitoring: 'Monitoring',
  'app-rail-machines': 'Machines',
} as const;
const MACHINES_NOTICE = 'app-rail-arrival:app-rail-machines';

/** The rail's arrival wiring as AppRail mounts it, with the recorded set drawn for the assertions. */
function Rail(props: Readonly<{ scope: ServerAccountScope }>) {
  const { preferences } = useNavigationSurfacePlacement('appRail');
  const arrived = useAppRailArrivals(props.scope);
  return (
    <>
      <Text testID="arrived">{[...arrived].sort().join(',')}</Text>
      <AppRailArrivals
        scope={props.scope}
        arrived={arrived}
        preferences={preferences}
        titles={TITLES}
      />
    </>
  );
}

async function withAccount(run: (scope: ServerAccountScope) => Promise<void>) {
  const locks = installWebLockManagerMock();
  const account = await createSecretSettingsTestHarness({
    settings: settingsParse({
      actionsSettingsV1: normalizeActionsSettingsV1({
        v: 1,
        approvalWaivedSurfaces: { 'settings.set': ['agent'] },
      }),
    }),
  });
  try {
    await run(account.scope);
  } finally {
    await standardCleanup();
    await account.dispose();
    locks.restore();
  }
}

async function addMachine(scope: ServerAccountScope, id: string) {
  await act(async () => {
    storage
      .getState()
      .applyMachines([createMachineFixture({ id })], false, {
        sourceServerId: scope.serverId,
        sourceAccountId: scope.accountId,
      });
  });
}

const arrivedText = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
  const node = screen.findHostByTestId('arrived');
  return node ? String(node.props.children ?? '') : null;
};
const savedRail = () =>
  readNavigationPlacementPreferences(
    storage.getState().localSettings.navigationSurfacePlacementsV1,
    'appRail',
  );

it('brings Machines onto the rail once there is a Machine besides this computer, offers Move to More once, and moves it through the placement Action', async () => {
  await withAccount(async (scope) => {
    const screen = await renderScreen(<Rail scope={scope} />);
    expect(arrivedText(screen)).toBe('');
    expect(
      readPresentationNotices().some(
        (notice) => notice.key === MACHINES_NOTICE,
      ),
    ).toBe(false);

    await addMachine(scope, 'build-box');
    await vi.waitFor(() =>
      expect(arrivedText(screen)).toBe('app-rail-machines'),
    );
    const notice = readPresentationNotices().find(
      (candidate) => candidate.key === MACHINES_NOTICE,
    );
    expect(notice?.action?.label).toBe('navigationPlacement.moveToMore');

    await act(async () => {
      notice!.action!.run();
    });
    await vi.waitFor(() =>
      expect(savedRail()?.placements['app-rail-machines']).toBe('overflow'),
    );
    await act(async () => {
      retirePresentationNotice(MACHINES_NOTICE);
    });

    // Recorded once on this device: a later mount neither announces again nor drops the arrival.
    const again = await renderScreen(<Rail scope={scope} />);
    await addMachine(scope, 'second-box');
    expect(arrivedText(again)).toBe('app-rail-machines');
    expect(
      readPresentationNotices().some(
        (candidate) => candidate.key === MACHINES_NOTICE,
      ),
    ).toBe(false);
  });
});

it('leaves a destination the person placed alone: no arrival, no notice', async () => {
  await withAccount(async (scope) => {
    await act(async () => {
      storage.getState().applyLocalSettings(
        {
          navigationSurfacePlacementsV1: {
            appRail: {
              orderedIds: [],
              placements: { 'app-rail-machines': 'hidden' },
            },
          },
        },
        { persist: false },
      );
    });
    const screen = await renderScreen(<Rail scope={scope} />);
    expect(arrivedText(screen), 'before').toBe('');
    await addMachine(scope, 'build-box');
    await act(async () => {});
    expect(arrivedText(screen)).toBe('');
    expect(
      readPresentationNotices().some(
        (candidate) => candidate.key === MACHINES_NOTICE,
      ),
    ).toBe(false);
  });
});
