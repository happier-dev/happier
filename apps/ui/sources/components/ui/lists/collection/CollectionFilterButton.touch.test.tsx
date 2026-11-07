import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { CollectionFilterButton } = await import('./CollectionFilterButton');

afterEach(() => vi.unstubAllGlobals());

it("keeps the filter funnel off what follows its header row, and takes the room it has above", async () => {
  // The primary pointer is read once per app load, so this lives in its own file.
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  const screen = await renderScreen(<CollectionFilterButton testID="filter" activeCount={0} open={false} onPress={() => {}} />);
  const area = await layoutHitArea(() => screen.findHostByTestId('filter'), { width: 30, height: 30 });
  expect(area.insets.bottom).toBe(0);
  expect(area.insets.top).toBe(7);
});
