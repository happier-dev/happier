import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

function switchNodes(screen: RenderScreenResult) {
  return screen.findAll(
    (node) =>
      typeof node.type === 'string' &&
      (node.props?.role === 'switch' ||
        node.props?.accessibilityRole === 'switch'),
  );
}

/** Owner ruling 2026-10-12: tapping anywhere on a switch row toggles its switch, app-wide. */
describe('Item switch row', () => {
  it('makes the whole row the one switch: named by its title, checked by the value, toggled once per press', async () => {
    const { Item } = await import('./Item');
    const { Switch } = await import('@/components/ui/forms/Switch.web');
    const onValueChange = vi.fn();
    const screen = await renderScreen(
      <Item
        testID="row"
        title="Approve requests"
        subtitle="Requests wait for you in Happier."
        rightElement={<Switch value={false} onValueChange={onValueChange} />}
        showChevron={false}
      />,
    );

    const switches = switchNodes(screen);
    expect(switches).toHaveLength(1);
    const control = switches[0]!;
    expect(
      control.props['aria-label'] ?? control.props.accessibilityLabel,
    ).toBe('Approve requests');
    expect(
      control.props['aria-checked'] ??
        control.props.accessibilityState?.checked,
    ).toBe(false);

    await act(async () => {
      screen.pressByTestId('row');
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);

    // Keyboard: Space on the row toggles as a switch does.
    const before = onValueChange.mock.calls.length;
    await act(async () => {
      control.props.onKeyDown?.({
        key: ' ',
        nativeEvent: { key: ' ' },
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(onValueChange.mock.calls.length).toBe(before + 1);
  });

  it('lets an async toggle settle inside the row press, so the row is busy until it finishes', async () => {
    const { Item } = await import('./Item');
    const { Switch } = await import('@/components/ui/forms/Switch.web');
    let settled = false;
    const onValueChange = vi.fn(async () => {
      await Promise.resolve();
      settled = true;
    });
    const screen = await renderScreen(
      <Item testID="row" title="Pinned" rightElement={<Switch value={false} onValueChange={onValueChange} />} showChevron={false} />,
    );
    await screen.pressByTestIdAsync('row');
    expect(onValueChange).toHaveBeenCalledWith(true);
    expect(settled).toBe(true);
  });

  it('leaves a disabled switch row inert', async () => {
    const { Item } = await import('./Item');
    const { Switch } = await import('@/components/ui/forms/Switch.web');
    const onValueChange = vi.fn();
    const screen = await renderScreen(
      <Item
        testID="row"
        title="Change model"
        rightElement={<Switch value onValueChange={onValueChange} disabled />}
        showChevron={false}
      />,
    );
    await act(async () => {
      screen.pressByTestId('row');
    });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(switchNodes(screen)).toHaveLength(1);
  });

  it('keeps a row that navigates on its own press, with the switch as its own control', async () => {
    const { Item } = await import('./Item');
    const { Switch } = await import('@/components/ui/forms/Switch.web');
    const onPress = vi.fn();
    const onValueChange = vi.fn();
    const screen = await renderScreen(
      <Item
        testID="row"
        title="Notifications"
        onPress={onPress}
        rightElement={<Switch value onValueChange={onValueChange} />}
      />,
    );
    await act(async () => {
      screen.pressByTestId('row');
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
