import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { Item } = await import('./Item');

type Screen = Awaited<ReturnType<typeof renderScreen>>;
const flat = (style: unknown) =>
  StyleSheet.flatten(
    (typeof style === 'function' ? style({ pressed: false }) : style) as never,
  ) ?? {};
const rowOpacity = (screen: Screen, testID: string) =>
  flat(screen.findHostByTestId(testID)?.props.style).opacity ?? 1;
const textColor = (screen: Screen, value: string) =>
  flat(
    screen.findAll(
      (node) => typeof node.type === 'string' && node.props.children === value,
    )[0]?.props.style,
  ).color;
/** The opacity a node shows: the product of its own and every ancestor's opacity up to the row. */
function shownOpacity(screen: Screen, testID: string): number {
  let node =
    screen.findAll(
      (candidate) =>
        candidate.props?.testID === testID && typeof candidate.type === 'string',
    )[0] ?? null;
  let opacity = 1;
  while (node) {
    // Host views only: a composite wrapper hands the same style to its host.
    const own = typeof node.type === 'string' ? flat(node.props.style).opacity : undefined;
    if (typeof own === 'number') opacity *= own;
    node = node.parent;
  }
  return opacity;
}

describe('Item disabled with a reason', () => {
  it('keeps the reason readable: its words step down one ink level instead of fading, while its mark still fades', async () => {
    const screen = await renderScreen(
      <>
        <Item
          testID="explained"
          title="Orders"
          subtitle="Data is on Neon."
          disabled
          showChevron={false}
          onPress={() => {}}
          icon={React.createElement('View', { testID: 'explained-mark' })}
        />
        <Item
          testID="dimmed"
          title="Archive"
          subtitle="Turned off"
          dimmed
          showChevron={false}
          onPress={() => {}}
        />
      </>,
    );
    expect(rowOpacity(screen, 'explained')).toBe(1);
    expect(textColor(screen, 'Data is on Neon.')).toBe(
      textColor(screen, 'Turned off'),
    );
    expect(textColor(screen, 'Orders')).toBe(textColor(screen, 'Archive'));
    expect(shownOpacity(screen, 'explained-mark')).toBe(0.5);
  });

  it('draws a disabled row without a reason exactly as before: the whole row at half strength', async () => {
    const screen = await renderScreen(
      <Item
        testID="bare"
        title="Orders"
        disabled
        showChevron={false}
        onPress={() => {}}
        icon={React.createElement('View', { testID: 'bare-mark' })}
      />,
    );
    expect(rowOpacity(screen, 'bare')).toBe(0.5);
    expect(shownOpacity(screen, 'bare-mark')).toBe(0.5);
  });
});
