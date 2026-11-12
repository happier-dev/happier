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

it("extends the recovery link vertically to 44 px without changing its drawn height", async () => {
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
  // The 24 px drawing reaches the 44 px target through ten invisible pixels on either side.
  expect([-frame.props.style.top, -frame.props.style.bottom]).toEqual([10, 10]);
});

it("lets an inline (page header) Retry reach a line's target height through its hit area, not its drawn height (R139)", async () => {
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const screen = await renderScreen(
    <SurfaceFreshnessLine
      testID="line"
      presentation="inline"
      reason="Couldn't read"
      action={{ testID: 'line-retry', label: 'Retry', onPress: () => {} }}
    />,
  );
  const retry = screen.findHostByTestId('line-retry')!;
  await act(async () =>
    retry.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 39, height: 16 } },
    }),
  );
  const frame = screen.root.findAll(
    (node) => node.props?.dataSet?.happierHitArea === 'true',
  )[0]!;
  // Drawn at the words' 16 px; fourteen invisible pixels above and below reach 44 px.
  expect([-frame.props.style.top, -frame.props.style.bottom]).toEqual([14, 14]);
});
