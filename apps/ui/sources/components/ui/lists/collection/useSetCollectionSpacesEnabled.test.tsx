import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useSetCollectionSpacesEnabled } =
  await import('./useSetCollectionSpacesEnabled');

const enablement = () => {
  const {
    collectionSpacesEnabled,
    sessionSpacesEnabled,
    workflowSpacesEnabled,
  } = storage.getState().settings;
  return {
    collectionSpacesEnabled,
    sessionSpacesEnabled,
    workflowSpacesEnabled,
  };
};

describe("one list's spaces switch (title menu and Manage spaces)", () => {
  it('turns off only this list, and turning it on again also lifts the Account-wide switch', async () => {
    const account = await createSecretSettingsTestHarness({
      settings: settingsParse({}),
    });
    try {
      const hook = await renderHook(() =>
        useSetCollectionSpacesEnabled('sessionWork'),
      );
      await act(async () => {
        await hook.getCurrent()(false);
      });
      await vi.waitFor(() =>
        expect(enablement()).toEqual({
          collectionSpacesEnabled: true,
          sessionSpacesEnabled: false,
          workflowSpacesEnabled: true,
        }),
      );

      await act(async () => {
        account.replaceSettings(
          settingsParse({
            collectionSpacesEnabled: false,
            sessionSpacesEnabled: false,
          }),
        );
      });
      await act(async () => {
        await hook.getCurrent()(true);
      });
      await vi.waitFor(() =>
        expect(enablement()).toEqual({
          collectionSpacesEnabled: true,
          sessionSpacesEnabled: true,
          workflowSpacesEnabled: true,
        }),
      );
      expect(account.persistedSettings).toMatchObject({
        collectionSpacesEnabled: true,
        sessionSpacesEnabled: true,
      });
    } finally {
      standardCleanup();
      await account.dispose();
    }
  });
});
