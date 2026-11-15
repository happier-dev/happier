// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';
import { CoreCollectionScope } from './CoreCollectionScope';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

installWebLayoutBridge();
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

type Card = Readonly<{ key: string; title: string; bodyHeight: number }>;
const CARDS: readonly Card[] = [
  { key: 'short', title: 'Ask once', bodyHeight: 40 },
  { key: 'tall', title: 'Review a pull request', bodyHeight: 220 },
];

function Grid() {
  const model = useHappierCollection<Card>({
    items: CARDS,
    keyOf: (card) => card.key,
    openKey: null,
    onOpenChange: () => {},
  });
  const anatomy = React.useMemo(
    () => ({
      glyph: () => null,
      title: (card: Card) => card.title,
      description: () => 'An example',
      accessibilityLabel: (card: Card) => card.title,
      testID: (card: Card) => `grid:${card.key}`,
      columnTitles: { title: 'Examples' },
      card: {
        body: {
          render: (card: Card) => <View style={{ height: card.bodyHeight }} />,
        },
      },
    }),
    [],
  );
  return (
    <Collection<Card>
      testID="grid"
      model={model}
      anatomy={anatomy}
      accessibilityLabel="Examples"
      presentation="grid"
      detail="none"
      scroll="page"
      minCardWidth={300}
    />
  );
}

it("draws the cards of one grid row at one height on the web, the tallest card's (lab nav-N3, QA-DESIGN-R2 G1)", async () => {
  // Web lays a wrapped grid row out with the platform's own per-line stretch: a short card no longer stops short
  // of its taller neighbour. Native keeps sizing each card by its content (the Yoga wrapped-row erratum).
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <View style={{ width: 760 }}>
        <CoreCollectionScope renderPageScroller={(children) => children}>
          <Grid />
        </CoreCollectionScope>
      </View>,
    ),
  );
  const layout = await measureWebLayout(host, {
    viewport: { width: 1000, height: 900 },
    texts: CARDS.map((card) => card.title),
    settle: (replay) => act(replay),
  });
  const short = layout.rect('grid:short:chrome');
  const tall = layout.rect('grid:tall:chrome');
  expect(Math.abs(short.top - tall.top), 'one row').toBeLessThan(2);
  expect(
    Math.abs(short.height - tall.height),
    JSON.stringify({ short, tall }),
  ).toBeLessThan(2);
});
