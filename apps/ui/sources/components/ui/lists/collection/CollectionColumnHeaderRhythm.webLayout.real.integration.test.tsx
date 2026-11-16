// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { HAPPIER_SHELL_RAIL_STEP_PX as RAIL_STEP } from '@happier-dev/plugin-ui/presentation';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const centre = (rect: Readonly<{ top: number; bottom: number }>) =>
  (rect.top + rect.bottom) / 2;

/**
 * Owner feedback 2026-11-16 (r2 items 2 and 3, 588c34cf / 735a6668): a column's title sat above the line its header
 * controls and the rail's first icon share, and the first group stood further below the rows above it than the
 * first row stood below the header. One header line; one rail step from the header to the first row and from a
 * row to the next group's label.
 */
it('centres the title on its controls and keeps one rail step from the header to the first row and to the next group', async () => {
  const { CollectionList, CollectionListGroupLabel } =
    await import('./CollectionList');
  const { Item } = await import('@/components/ui/lists/Item');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 280, height: 600 }}>
        <CollectionList
          testID="column"
          title="Machines"
          surface="plane"
          headerAction={
            <View testID="header-action" style={{ width: 30, height: 30 }} />
          }
        >
          <Item
            testID="first-row"
            title="Overview"
            density="compact"
            showChevron={false}
            onPress={() => {}}
          />
          <CollectionListGroupLabel testID="next-group" title="Your machines" />
          <Item
            testID="group-row"
            title="Build box"
            density="compact"
            showChevron={false}
            onPress={() => {}}
          />
        </CollectionList>
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 320, height: 640 },
    texts: ['Machines'],
    settle: (replay) => act(replay),
  });
  const titleCentre = centre(layout.textRects('Machines')[0]!);
  const controlCentre = centre(layout.rect('header-action'));
  expect(Math.abs(titleCentre - controlCentre)).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(
      centre(layout.rect('first-row')) -
        controlCentre -
        RAIL_STEP,
    ),
  ).toBeLessThanOrEqual(0.5);
  expect(
    Math.abs(
      centre(layout.rect('next-group')) -
        centre(layout.rect('first-row')) -
        RAIL_STEP,
    ),
  ).toBeLessThanOrEqual(0.5);
});
