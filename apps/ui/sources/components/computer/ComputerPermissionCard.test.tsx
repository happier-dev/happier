import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
  ComputerPermissionCard,
  type ComputerOpenSettingsState,
} from './ComputerPermissionCard';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Native AppState is the platform boundary the app-wide host focus watch reads; the real watch
// (`useHostActivelyFocused`) and the real card run beneath it.
const host = vi.hoisted(() => ({
  appState: 'active' as string,
  listeners: new Set<(state: string) => void>(),
}));

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    AppState: {
      get currentState() {
        return host.appState;
      },
      addEventListener: (event: string, listener: (state: string) => void) => {
        if (event !== 'change') return { remove: () => {} };
        host.listeners.add(listener);
        return { remove: () => host.listeners.delete(listener) };
      },
    },
  });
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  });
});

function setAppState(state: 'active' | 'background'): void {
  act(() => {
    host.appState = state;
    for (const listener of [...host.listeners]) listener(state);
  });
}

function card(
  openSettings: ComputerOpenSettingsState,
  onCheckAgain: () => void,
) {
  return (
    <ComputerPermissionCard
      machineName="Studio Mac"
      grants={{ capture: 'denied', input: 'granted' }}
      openSettings={openSettings}
      onOpenSettings={() => {}}
      onCheckAgain={onCheckAgain}
    />
  );
}

describe('ComputerPermissionCard', () => {
  it('checks again once when the person comes back after the pane opened on the machine', async () => {
    const onCheckAgain = vi.fn();
    const screen = await renderScreen(card('opening', onCheckAgain));
    // System Settings takes focus before the open request even answers.
    setAppState('background');
    await act(async () => screen.update(card('opened', onCheckAgain)));
    expect(onCheckAgain).not.toHaveBeenCalled();

    setAppState('active');
    expect(onCheckAgain).toHaveBeenCalledTimes(1);

    // Leaving and coming back again while that check is out does not ask the machine twice.
    setAppState('background');
    setAppState('active');
    expect(onCheckAgain).toHaveBeenCalledTimes(1);
  });

  it('does not check on return when nothing was opened on the machine', async () => {
    const onCheckAgain = vi.fn();
    await renderScreen(card('idle', onCheckAgain));
    setAppState('background');
    setAppState('active');
    expect(onCheckAgain).not.toHaveBeenCalled();
  });
});
