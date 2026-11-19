import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOME_ATMOSPHERE,
  type ProjectAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { AtmosphereEditor } from './atmosphereEditor';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
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
// The device picture store's storage boundary: the browser store over fake IndexedDB.
vi.mock(
  '@/components/atmosphere/pictureStore',
  async () => import('@/components/atmosphere/pictureStore.web'),
);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { LookPanel } = await import('./LookPanel');
const originalState = storage.getState();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  standardCleanup();
  vi.restoreAllMocks();
  storage.setState(originalState, true);
});

const { moments: _moments, ...HOME } = DEFAULT_HOME_ATMOSPHERE;

/** Home's Look over a local atmosphere editor; the field row writes the Account preference through its own Action. */
function HomeLook(
  props: Readonly<{
    initial: ProjectAtmosphere;
    edits: ProjectAtmosphere[];
    project?: boolean;
  }>,
) {
  const [value, setValue] = React.useState(props.initial);
  const editor = React.useMemo<AtmosphereEditor>(
    () => ({
      value,
      ...(props.project ? { sameAsHome: false, resetToHome: () => {} } : {}),
      update: (edit) =>
        setValue((current) => {
          const next = { ...current, ...edit(current) };
          props.edits.push(next);
          return next;
        }),
    }),
    [props.edits, props.project, value],
  );
  return <LookPanel editor={editor} field={!props.project} />;
}

describe('Home look sheet (firstOpen.01.F2)', () => {
  it('orders Background as Planet, Picture, None and sets the Background field once per choice, without touching the atmosphere', async () => {
    const account = await createSecretSettingsTestHarness({
      settings: settingsParse({}),
    });
    const edits: ProjectAtmosphere[] = [];
    const screen = await renderScreen(
      <HomeLook initial={HOME} edits={edits} />,
    );
    try {
      const order = [
        ...new Set(
          screen
            .findAll((node) => typeof node.props.testID === 'string' && /^look-source:[a-z]+$/.test(node.props.testID))
            .map((node) => node.props.testID as string),
        ),
      ];
      expect(order).toEqual(['look-source:planet', 'look-source:picture', 'look-source:none']);
      expect(
        screen.findByTestId('look-field:animated')?.props.accessibilityState
          ?.checked,
      ).toBe(true);

      const before = account.settingsWrites.length;
      await act(async () => {
        await screen.pressByTestIdAsync('look-field:still');
        await vi.waitFor(() =>
          expect(account.persistedSettings.homeBackgroundField).toBe('still'),
        );
      });
      expect(account.settingsWrites.length - before).toBe(1);
      expect(edits).toHaveLength(0);
      expect(account.artifacts.list()).toHaveLength(0);

      const settled = account.settingsWrites.length;
      await act(async () => {
        await screen.pressByTestIdAsync('look-field:still');
      });
      expect(account.settingsWrites.length).toBe(settled);
    } finally {
      await screen.unmount();
      await account.dispose();
    }
  });

  it('keeps the Background field row over a picture and says where it shows', async () => {
    const account = await createSecretSettingsTestHarness({
      settings: settingsParse({}),
    });
    const screen = await renderScreen(
      <HomeLook initial={{ ...HOME, source: 'picture' }} edits={[]} />,
    );
    try {
      expect(screen.findByTestId('look-field:off')).not.toBeNull();
      expect(screen.getTextContent()).toContain(
        t('settingsAppearance.glassControls.fieldPictureNote'),
      );
      expect(screen.findByTestId('look-intensity:quiet')).toBeNull();
      expect(screen.findByTestId('look-digits')).toBeNull();
    } finally {
      await screen.unmount();
      await account.dispose();
    }
  });

  it('leaves the field to Home: a project Look has no Background field row', async () => {
    const account = await createSecretSettingsTestHarness({
      settings: settingsParse({}),
    });
    const screen = await renderScreen(
      <HomeLook initial={HOME} edits={[]} project />,
    );
    try {
      expect(screen.findByTestId('look-intensity:quiet')).not.toBeNull();
      expect(screen.findByTestId('look-field:animated')).toBeNull();
    } finally {
      await screen.unmount();
      await account.dispose();
    }
  });
});
