import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  readPresentationNotices,
  retirePresentationNotice,
} from '@/components/sessions/presentation/presentationNotices';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  publishAppliedActiveServerRuntimeAvailability,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { t } from '@/text';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
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
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const initialStorageState = storage.getState();
const { presentActionAutomationSkipNotice } =
  await import('./actionAutomationSkipNotice');

/** The connection summary the page and the Voice Island read: unreachable, or a live connection. */
function setPageShowsOffline(offline: boolean) {
  storage.setState(
    offline
      ? {
          endpointStatus: 'offline',
          socketStatus: 'disconnected',
          endpointReason: null,
          syncError: null,
        }
      : {
          endpointStatus: 'online',
          socketStatus: 'connected',
          endpointReason: null,
          syncError: null,
        },
  );
}

describe('presentActionAutomationSkipNotice and the Home the page already reports', () => {
  beforeEach(async () => {
    await homes.reset();
    const homeId = await homes.addHome({
      name: 'Studio',
      serverUrl: 'https://studio.example.test',
      accountId: 'notice-account',
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    publishAppliedActiveServerRuntimeAvailability(true);
    storage.setState({ machineListStatusByServerId: { [homeId]: 'idle' } });
  });
  afterEach(async () => {
    retirePresentationNotice();
    standardCleanup();
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialStorageState, true);
  });

  const cases = [
    {
      reason: 'server_unreachable',
      message: 'workflows.triggers.checks.notCheckedUnreachable',
      silentWhenOffline: true,
    },
    {
      reason: 'database_connection_unavailable',
      message: 'workflows.triggers.checks.notCheckedHomeUnavailable',
      silentWhenOffline: false,
    },
    {
      reason: 'not_found',
      message: 'workflows.triggers.checks.notChecked',
      silentWhenOffline: false,
    },
  ] as const;
  for (const { reason, message, silentWhenOffline } of cases) {
    for (const offline of [true, false]) {
      const silent = silentWhenOffline && offline;
      it(`${reason}, page ${offline ? 'shows' : "doesn't show"} the Home offline → ${silent ? 'no second message' : 'one notice'}`, async () => {
        setPageShowsOffline(offline);
        await presentActionAutomationSkipNotice({
          automationNotices: [
            { code: 'action_automations_not_checked', reason },
          ],
        });
        expect(
          readPresentationNotices().map((notice) => notice.message),
        ).toEqual(silent ? [] : [t(message)]);
      });
    }
  }
});
