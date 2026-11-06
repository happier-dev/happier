import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { EditorAccessoryBar, EditorAccessoryChip } from './EditorAccessoryBar';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

describe('EditorAccessoryChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repeats a held arrow key like a hardware key and stops on release', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <EditorAccessoryChip
        testID="key"
        icon="arrow-left"
        label="Left"
        repeat
        onPress={onPress}
      />,
    );
    const chip = screen.findByTestId('key')!;
    act(() => {
      chip.props.onPressIn?.({});
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(
        motionTokens.gesture.keyRepeatDelayMs +
          motionTokens.gesture.keyRepeatIntervalMs * 3,
      );
    });
    expect(onPress).toHaveBeenCalledTimes(5);
    act(() => {
      chip.props.onPressOut?.({});
      chip.props.onPress?.({});
    });
    act(() => {
      vi.advanceTimersByTime(motionTokens.gesture.keyRepeatIntervalMs * 5);
    });
    // Releasing ends the repeat, and the release's own press is not a sixth step.
    expect(onPress).toHaveBeenCalledTimes(5);
  });

  it('still steps once for a press that arrives without a press-in (keyboard or assistive activation)', async () => {
    const onPress = vi.fn();
    const screen = await renderScreen(
      <EditorAccessoryChip
        testID="key"
        icon="arrow-left"
        label="Left"
        repeat
        onPress={onPress}
      />,
    );
    act(() => {
      screen.findByTestId('key')!.props.onPress?.({});
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('EditorAccessoryBar', () => {
  it('keeps the key row above the phone floating tab bar, so Save and the keys stay tappable', async () => {
    const { StyleSheet } = await import('react-native');
    const tabBarHeight = 84;
    const screen = await renderScreen(
      <SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
        <EditorAccessoryBar testID="key-row"><EditorAccessoryChip text="Tab" label="Tab" onPress={() => {}} /></EditorAccessoryBar>
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    const bottomReservation = () => {
      let node = screen.findHostByTestId('key-row');
      let bottom = 0;
      while (node) {
        if (typeof node.type === 'string') bottom += Number(StyleSheet.flatten(node.props.style)?.paddingBottom ?? 0);
        node = node.parent;
      }
      return bottom;
    };
    expect(bottomReservation()).toBe(tabBarHeight);
    // With no floating chrome over the page, the row keeps its own edge.
    await screen.update(<EditorAccessoryBar testID="key-row"><EditorAccessoryChip text="Tab" label="Tab" onPress={() => {}} /></EditorAccessoryBar>);
    expect(bottomReservation()).toBe(0);
  });
});
