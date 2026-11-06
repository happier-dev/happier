import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { Collection, type CollectionAnatomy } from '../../components/Collection.js';
import { useHappierCollection } from '../collection/useCollection.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import type { RegistrySourcesUnavailableProps } from './RegistrySourcesUnavailable.js';

/** Three cards across the homepage column (lab hs A2/A3, hm A2). */
const SHELF_SIZE = 3;
/**
 * The narrowest card whose one-line title (a job: "Know when my site is down") reads whole. A row that
 * cannot hold three at it shows two (the Collection card's title is one line and never truncates);
 * a paging shelf (a phone, lab store `st-hscroll`) gives each card this width and lets the next peek.
 */
const SHELF_CARD_MIN_WIDTH_PX = 236;
/** The homepage is the scroller: the shelf's grid draws none of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

export type RegistryShelfProjection<Item> = Readonly<{
  keyOf: (item: Item) => string;
  title: (item: Item) => string;
  description: (item: Item) => string | null;
  testID: (item: Item) => string;
}>;
export type RegistryShelfUnavailable = Readonly<{
  message: string;
  onRetry: () => void | Promise<void>;
}>;

export type RegistryShelfHost = Readonly<{
  Section: React.ComponentType<Readonly<{ title: string; description?: string; surface: 'none'; action?: React.ReactNode; children?: React.ReactNode }>>;
  BrowseAll: React.ComponentType<Readonly<{ testID: string; title: string; destination: true; onPress: () => void }>>;
  Row: React.ComponentType<Readonly<{ rowRole: 'catalogRow'; testID: string; title: string; subtitle?: string; icon?: React.ReactNode; rightElement?: React.ReactNode; showChevron: false; onPress: () => void }>>;
  Scope: React.ComponentType<Readonly<{ renderPageScroller: (children: React.ReactNode) => React.ReactNode; children: React.ReactNode }>>;
  Unavailable: React.ComponentType<RegistrySourcesUnavailableProps>;
}>;

export type RegistryShelfProps<Item> = Readonly<{
    testID: string;
    title: string;
    description?: string;
    items: readonly Item[];
    projection: RegistryShelfProjection<Item>;
    loading: boolean;
    /** The source could not be read: its reason and Retry sit in the shelf's own slot, under any retained cards. */
    unavailable?: RegistryShelfUnavailable;
    /** The quiet line under the card's name (a publisher, a repository, the source). */
    where: (card: Item) => string | null;
    glyph?: (card: Item) => React.ReactNode;
    action: (card: Item) => React.ReactNode;
    /** Inspect the listing or open its saved home; the action remains an independent target. */
    onOpen: (card: Item) => void;
    columnTitle: string;
    /** "Browse all": opens the kind's Add modal on Browse. */
    browseAll?: Readonly<{ label: string; onPress: () => void }>;
    /**
     * Cards across the column: three (the default homepage shelf) or one (a featured item spanning the column,
     * the same card rather than a hero composition).
     */
    perRow?: 1 | 3;
    /** Every item, not only the first row (a page that is the shelf's own index). */
    showAll?: boolean;
    /** A relationship preview at the card's top end (a job's marks of what does it); never an action target. */
    headerRight?: (card: Item) => React.ReactNode;
  }>;

/** One registry shelf composition; callers retain acquisition, data projection and actions. */
export function HappierRegistryShelf<Item>(props: RegistryShelfProps<Item> & Readonly<{ host: RegistryShelfHost }>) {
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  const gutter = HAPPIER_PAGE_METRICS.sheetInsetPx;
  // The cards fill the row at any column width (never an extra, empty slot), down to the card's minimum.
  const room = width - 2 * gutter;
  const paged = !props.showAll && room > 0 && room < 2 * SHELF_CARD_MIN_WIDTH_PX + gutter;
  // One row holds as many cards as fit at their minimum (three on a wide column, two on a narrower one).
  const fits = room > 0 && !paged
    ? Math.max(1, Math.floor((room + gutter) / (SHELF_CARD_MIN_WIDTH_PX + gutter)))
    : Number.POSITIVE_INFINITY;
  const perRow = Math.min(props.perRow ?? SHELF_SIZE, fits);
  const cards = React.useMemo(
    () => (props.showAll ? props.items : props.items.slice(0, perRow)),
    [props.items, perRow, props.showAll],
  );
  const { onOpen, projection } = props;
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      const card = cards.find((item) => projection.keyOf(item) === key);
      if (card) onOpen(card);
    },
    [cards, onOpen, projection],
  );
  const model = useHappierCollection<Item>({
    items: cards,
    keyOf: projection.keyOf,
    openKey: null,
    onOpenChange,
  });
  const minCardWidth = paged ? SHELF_CARD_MIN_WIDTH_PX : Math.max(
    SHELF_CARD_MIN_WIDTH_PX,
    Math.floor((room - (perRow - 1) * gutter) / perRow) - 1,
  );
  const { where, glyph, action, columnTitle, testID, headerRight } = props;
  const anatomy = React.useMemo(
    (): CollectionAnatomy<Item> => ({
      glyph: (card) => glyph?.(card) ?? null,
      title: projection.title,
      where,
      description: projection.description,
      action,
      columnTitles: { title: columnTitle },
      accessibilityLabel: projection.title,
      testID: (card) => `${testID}.${projection.testID(card)}`,
      ...(headerRight ? { card: { headerRight } } : {}),
    }),
    [action, columnTitle, glyph, testID, where, projection, headerRight],
  );
  if (cards.length === 0 && !props.loading && !props.unavailable) return null;
  const lone = (props.perRow ?? SHELF_SIZE) === SHELF_SIZE && !props.showAll && cards.length === 1 ? cards[0]! : null;
  return (
    <props.host.Section
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
      surface="none"
      {...(props.browseAll
        ? {
            action: (
              <props.host.BrowseAll
                testID={`${testID}.browseAll`}
                title={props.browseAll.label}
                destination
                onPress={props.browseAll.onPress}
              />
            ),
          }
        : {})}
    >
      {lone ? (
        // A card is a choice to compare a few at a time: one suggestion is one catalog row.
        <props.host.Scope renderPageScroller={passThroughScroller}>
          <props.host.Row
            rowRole="catalogRow"
            testID={`${testID}.${projection.testID(lone)}.row`}
            title={projection.title(lone)}
            subtitle={projection.description(lone) ?? where(lone) ?? undefined}
            icon={glyph?.(lone) ?? undefined}
            rightElement={action(lone)}
            showChevron={false}
            onPress={() => onOpen(lone)}
          />
        </props.host.Scope>
      ) : null}
      {/* The card grid draws its own gutter inside the section's content: the shelf pulls that gutter back out so the cards stand on the page's sheet edge, the legend's (lab hm-A2). */}
      {!lone && (cards.length > 0 || props.loading) ? (
        <View onLayout={onLayout} style={{ marginHorizontal: -gutter }}>
          <props.host.Scope renderPageScroller={passThroughScroller}>
            <Collection<Item>
              testID={testID}
              model={model}
              anatomy={anatomy}
              accessibilityLabel={props.title}
              presentation="grid"
              detail="none"
              scroll="page"
              minListWidth={SHELF_CARD_MIN_WIDTH_PX}
              minDetailWidth={SHELF_CARD_MIN_WIDTH_PX}
              preferredListRatio={1}
              minCardWidth={minCardWidth}
              // A one-row shelf that has room for one card (a phone) pages sideways instead of stacking (lab store `st-hscroll`).
              {...(props.showAll ? {} : { narrowGrid: 'page' as const })}
              loading={props.loading && cards.length === 0}
              // The shelf shows one row of cards, so arriving it reserves that row and nothing below moves.
              {...(props.showAll ? {} : { loadingRows: 1 })}
            />
          </props.host.Scope>
        </View>
      ) : null}
      {props.unavailable ? (
        // One verb for a source that did not answer, on every page (TASTE-S4060 D2), through the one outage line.
        <props.host.Unavailable
          testID={`${testID}.unavailable`}
          failures={[{ key: 'source', message: props.unavailable.message, onRetry: props.unavailable.onRetry }]}
        />
      ) : null}
    </props.host.Section>
  );
}
