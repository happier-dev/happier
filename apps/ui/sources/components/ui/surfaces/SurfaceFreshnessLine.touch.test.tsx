// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SurfaceFreshnessLine } from './SurfaceFreshnessLine';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ View: 'View' });
});

afterEach(() => vi.unstubAllGlobals());

it("keeps the recovery link's finger reach inside the line's own padding, so the next row keeps its taps", async () => {
  // The primary pointer is read once per app load, so this lives in its own file.
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const screen = await renderScreen(
    <SurfaceFreshnessLine
      testID="line"
      reason="Couldn't read"
      action={{ testID: 'line-retry', label: 'Retry', onPress: () => {} }}
    />,
  );
  const retry = screen.findHostByTestId('line-retry')!;
  await act(async () =>
    retry.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 39, height: 24 } },
    }),
  );
  const frame = screen.root.findAll(
    (node) => node.props?.dataSet?.happierHitArea === 'true',
  )[0]!;
  // The 44 px target alone would reach 10 above and below; the strip's block padding is 6.
  expect([-frame.props.style.top, -frame.props.style.bottom]).toEqual([6, 6]);
});
