/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { Modal } from '@/modal';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { getDesktopHostAvailability } from '@/utils/platform/desktopHost';
import { Switch } from '@/components/ui/forms/Switch';

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
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/desktop',
    }).module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
// Native event registration is the genuine Tauri SDK boundary.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DesktopWindowsSettingsSection } =
  await import('./DesktopWindowsSettingsSection');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');
const originalState = storage.getState();
afterEach(() => {
  standardCleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  storage.setState(originalState, true);
});

function stubDesktopHost() {
  vi.stubGlobal('isTauri', true);
  const secureStorage = createDesktopSecureStorageBoundary();
  let secureReadsReady: Promise<void> | undefined;
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === 'desktop_host_get_availability')
        return {
          activity: { kind: 'available' },
          pet: { kind: 'available' },
          windows: { kind: 'available' },
        };
      if (command === 'desktop_secure_storage_read' && secureReadsReady) {
        await secureReadsReady;
      }
      return secureStorage.invoke(command, args);
    },
  });
  return (ready: Promise<void>) => { secureReadsReady = ready; };
}

describe('Settings → Desktop app → Windows', () => {
  it('shows when the Bot rail choice cannot apply yet, then admits the row and settings.set', async () => {
    const holdSecureReads = stubDesktopHost();
    const secureReads = createDeferred<void>();
    const account = await createSecretSettingsTestHarness({
      settings: settingsParse({
        actionsSettingsV1: {
          v: 1,
          approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] },
        },
      }),
    });
    storage.getState().applyLocalSettings({ ...localSettingsDefaults });
    try {
      await getDesktopHostAvailability();
      holdSecureReads(secureReads.promise);
      const screen = await renderScreen(<DesktopWindowsSettingsSection />);
      const row = () =>
        screen.tree
          .findAllByType(Switch)
          .find(
            (item) => item.props.testID === 'settings-desktop-window-bot-rail',
          )!;
      expect(row().props.value).toBe(true);
      vi.mocked(Modal.alert).mockClear();
      await act(async () => { await row().props.onValueChange(false); });
      expect(storage.getState().localSettings.desktopWindowBotRailEnabled).toBe(true);
      const refusalShown = vi.mocked(Modal.alert).mock.calls.length > 0;

      await act(async () => {
        secureReads.resolve();
        await resolveServerCredentialAccountScope(account.scope.serverId);
      });
      await act(async () => { await row().props.onValueChange(false); });
      await vi.waitFor(() =>
        expect(
          storage.getState().localSettings.desktopWindowBotRailEnabled,
        ).toBe(false),
      );
      expect(row().props.value).toBe(false);
      await act(async () => {
        expect(
          await createDefaultActionExecutor().execute(
            'settings.set',
            {
              anchor: 'desktop.windowBotRail',
              value: true,
            },
            {
              surface: 'agent',
              authority: 'account_automation',
              serverId: account.scope.serverId,
              actionCaller: { kind: 'host' },
            },
          ),
        ).toMatchObject({ ok: true });
      });
      expect(storage.getState().localSettings.desktopWindowBotRailEnabled).toBe(
        true,
      );
      expect(row().props.value).toBe(true);
      expect(account.settingsWrites).toEqual([]);
      expect(refusalShown).toBe(true);
    } finally {
      secureReads.resolve();
      standardCleanup();
      await account.dispose();
    }
  });
});
