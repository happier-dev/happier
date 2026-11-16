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

/**
 * SHELL-ACCEPT-1116 (item 3 with a header band): a band under the title (Sessions' spaces strip, Services' and
 * Workflows' view bands) took the 6px header gap above and below, so its centre and the first row sat off the rail
 * grid and tighter than a section break. A band is one more step: its centre one rail step under the title row's,
 * and the first row one step under the band's, whatever the band's height.
 */
it.each([24, 36])('stands a %ipx header band one rail step under the title and one above the first row', async (bandPx) => {
  const { CollectionList } = await import('./CollectionList');
  const { Item } = await import('@/components/ui/lists/Item');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 280, height: 600 }}>
        <CollectionList
          testID="column"
          title="Workflows"
          surface="plane"
          headerAction={<View testID="header-action" style={{ width: 30, height: 30 }} />}
          strip={<View testID="band" style={{ height: bandPx }} />}
        >
          <Item testID="first-row" title="Library" density="compact" showChevron={false} onPress={() => {}} />
        </CollectionList>
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 320, height: 640 },
    texts: ['Workflows'],
    settle: (replay) => act(replay),
  });
  const controlCentre = centre(layout.rect('header-action'));
  const bandCentre = centre(layout.rect('band'));
  expect(Math.abs(bandCentre - controlCentre - RAIL_STEP)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(centre(layout.rect('first-row')) - bandCentre - RAIL_STEP)).toBeLessThanOrEqual(0.5);
});
