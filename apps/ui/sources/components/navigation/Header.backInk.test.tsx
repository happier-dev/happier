import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const BAND_INK = '#e9e7e4';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock({
    theme: { colors: { chrome: { header: { foreground: BAND_INK } } } },
  });
});
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

function flatColor(style: unknown): unknown {
  if (Array.isArray(style))
    return style
      .map(flatColor)
      .filter((color) => color !== undefined)
      .at(-1);
  return style !== null && typeof style === 'object'
    ? (style as { color?: unknown }).color
    : undefined;
}

describe('the band Back', () => {
  afterEach(standardCleanup);

  // A plugin's pushed detail publishes its way back to the band without a tint; on a dark band a black Back vanished.
  it('draws its parent name in the band ink when its publisher gives no tint', async () => {
    const { DefaultBackButton } = await import('./Header');
    const screen = await renderScreen(
      <DefaultBackButton onPress={() => {}} label="PRs & Issues" />,
    );
    const label = screen.root.find(
      (node) =>
        node.props.children === 'PRs & Issues' &&
        node.props.numberOfLines === 1,
    );
    expect(flatColor(label.props.style)).toBe(BAND_INK);
  });
});
