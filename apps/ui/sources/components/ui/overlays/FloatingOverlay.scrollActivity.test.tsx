import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';
import {
  PluginUiScrollActivityProvider,
  type PluginUiScrollActivityTracker,
} from '@happier-dev/plugin-ui/advanced';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { FloatingOverlay } from './FloatingOverlay';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    View: 'View',
  }),
);
// The host renderer has no screen coordinates: the overlay's real tracker measures each span at its scroller's top.
vi.mock('@/components/widgets/nearViewport', async () =>
  (
    await import('@/dev/testkit/mocks/nearViewport')
  ).createMeasuredNearViewportModuleMock(
    await vi.importActual<typeof import('@/components/widgets/nearViewport')>(
      '@/components/widgets/nearViewport',
    ),
  ),
);

afterEach(() => standardCleanup());

/** The page behind the overlay: it stays at its top while the overlay scrolls. */
const STILL_PAGE_WINDOW = { top: 0, bottom: 800 } as const;
function createStillPageTracker(): PluginUiScrollActivityTracker {
  return {
    onScroll() {},
    onLayout() {},
    onContentSizeChange() {},
    invalidateLayout() {},
    getLayoutRevision: () => 0,
    // One snapshot: the page's window never changes while the overlay scrolls.
    getWindow: () => STILL_PAGE_WINDOW,
    subscribe: () => () => {},
    measureSpan: async () => ({ top: 0 }),
    scrollToOffset() {},
  };
}

type Card = Readonly<{ key: string; title: string }>;
/** Census-sized: a catalog several overlay heights tall (the examples picker holds 21 map cards). */
const CARDS: readonly Card[] = Array.from({ length: 120 }, (_, index) => ({
  key: `card-${index}`,
  title: `Example ${index + 1}`,
}));
const readKey = (card: Card) => card.key;
const passThrough = (children: React.ReactNode) => children;

function CensusGrid() {
  const model = useHappierCollection<Card>({
    items: CARDS,
    keyOf: readKey,
    openKey: null,
    onOpenChange: () => {},
  });
  const anatomy = React.useMemo(
    () => ({
      glyph: () => null,
      title: (card: Card) => card.title,
      description: () => 'What it does',
      accessibilityLabel: (card: Card) => card.title,
      testID: (card: Card) => `census:${card.key}`,
      columnTitles: { title: 'Examples' },
      card: {},
    }),
    [],
  );
  return (
    <CoreCollectionScope renderPageScroller={passThrough}>
      <Collection<Card>
        testID="census"
        model={model}
        anatomy={anatomy}
        accessibilityLabel="Examples"
        presentation="grid"
        detail="none"
        scroll="page"
        minCardWidth={320}
      />
    </CoreCollectionScope>
  );
}

const mountedCards = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  CARDS.filter((card) => screen.findHostByTestId(`census:${card.key}`) !== null)
    .length;

describe('FloatingOverlay scroll activity', () => {
  it('windows a page-scrolled collection on its own scroller, so every card of a census-sized catalog is reachable', async () => {
    const screen = await renderScreen(
      <PluginUiScrollActivityProvider tracker={createStillPageTracker()}>
        <FloatingOverlay maxHeight={728}>
          <CensusGrid />
        </FloatingOverlay>
      </PluginUiScrollActivityProvider>,
    );
    await reportCollectionLayout(screen, 'census', { width: 700, height: 728 });
    // The overlay's scroller: the one host scroll view under it.
    const scroller = screen.find(
      (node) =>
        typeof node.props.onScroll === 'function' &&
        node.props.scrollEventThrottle === 32,
    );
    await act(async () => {
      scroller.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 728 } },
      });
    });
    const resting = mountedCards(screen);
    // Windowed: what is near the overlay's viewport mounts, never the whole catalog.
    expect(resting).toBeGreaterThan(0);
    expect(resting).toBeLessThan(CARDS.length);
    expect(screen.findHostByTestId(`census:${CARDS.at(-1)!.key}`)).toBeNull();
    // Scrolling the overlay viewport by viewport (the page behind it stays still) reaches the catalog's end.
    const last = `census:${CARDS.at(-1)!.key}`;
    let offset = 0;
    while (screen.findHostByTestId(last) === null && offset < 40_000) {
      offset += 600;
      await act(async () => {
        scroller.props.onScroll?.({ nativeEvent: { contentOffset: { x: 0, y: offset },
          layoutMeasurement: { width: 700, height: 728 }, contentSize: { width: 700, height: 40_728 } } });
      });
    }
    expect(screen.findHostByTestId(last), `scrolled to ${offset}`).not.toBeNull();
    // Still a window at the end, not the whole catalog mounted (the grid keeps only its tab stop beyond it).
    expect(mountedCards(screen)).toBeLessThan(CARDS.length);
  });
});
