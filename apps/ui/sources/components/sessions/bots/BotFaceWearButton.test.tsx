import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';

vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const { BotFaceWearButton } = await import('./BotFaceWearButton');
const { t } = await import('@/text');

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => { restorePopoverGlobals = withPopoverWebGlobals(); });
afterEach(async () => { restorePopoverGlobals?.(); await standardCleanup(); });

describe('Use as a Bot\'s face…', () => {
  it('opens the Bots roster from the button as a chooser wearing the pet, and mounts nothing until then (R12 §10)', async () => {
    const screen = await renderScreen(
      <BotFaceWearButton testID="wear" pet={{ kind: 'builtIn', petId: 'milo' }} name="Milo" />,
    );
    expect(screen.findByTestId('bots-roster')).toBeNull();
    await screen.pressByTestIdAsync('wear');
    expect(screen.findByTestId('bots-roster')).not.toBeNull();
    expect(screen.getTextContent()).toContain(t('bots.face.wearTitle', { name: 'Milo' }));
    // The roster's own chooser: no roster actions beside the Bots it lists.
    expect(screen.findByTestId('bots-roster.from-template')).toBeNull();
  });
});
