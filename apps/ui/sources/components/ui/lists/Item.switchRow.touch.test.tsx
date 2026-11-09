import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// The primary pointer is read once per app load: a finger is it before anything mounts.
vi.stubGlobal('navigator', { maxTouchPoints: 1 });
const { Item } = await import('./Item');
const { Switch } = await import('@/components/ui/forms/Switch.web');

afterEach(() => vi.unstubAllGlobals());

it('is one target under a finger: the nested switch draws only and brings no hit area of its own into the row', async () => {
  const screen = await renderScreen(
    <>
      <Item testID="pinned" title="Pinned" rightElement={<Switch value={false} onValueChange={() => {}} />} showChevron={false} />
      <Item testID="tags" title="Tags" detail="Tag" onPress={() => {}} />
    </>,
  );
  // Rows are full-width targets stacked edge to edge; the only extra reach a row's control could add is a
  // hit frame, and a switch row has none (neither on the row nor on its switch).
  expect(screen.root.findAll((node) => node.props?.dataSet?.happierHitArea === 'true')).toHaveLength(0);
});
