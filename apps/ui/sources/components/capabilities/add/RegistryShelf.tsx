import * as React from 'react';
import { RegistrySourcesUnavailable } from './RegistrySourcesUnavailable';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_ICON_BUTTON_SIZE,
  HAPPIER_PAGE_METRICS,
  HappierMotionFeedback,
} from '@happier-dev/plugin-ui/presentation';
import {
  Collection,
  type CollectionAnatomy,
  useHappierCollection,
} from '@happier-dev/plugin-ui';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  describeRegistrySourceFailure,
  type RegistryFailureStatus,
} from '@/registries/describeRegistrySourceStatus';
import { t } from '@/text';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

/** Three cards across the homepage column (lab hs A2/A3, hm A2). */
const SHELF_SIZE = 3;
const SHELF_CARD_MIN_WIDTH_PX = 200;
/** The homepage is the scroller: the shelf's grid draws none of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

export type RegistryShelfCard = RegistryItemSummaryV1;

export function registryShelfCardKey(item: RegistryShelfCard): string {
  return `${item.sourceId}:${item.itemId}`;
}
export type RegistryShelfProjection<Item> = Readonly<{
  keyOf: (item: Item) => string;
  title: (item: Item) => string;
  description: (item: Item) => string | null;
  testID: (item: Item) => string;
}>;
export const registryShelfProjection: RegistryShelfProjection<RegistryShelfCard> =
  {
    keyOf: registryShelfCardKey,
    title: (item) => item.title,
    description: (item) => item.description ?? null,
    testID: (item) => item.itemId,
  };

/** The shelf's one quiet outage line: the source and the reason, with the Retry that re-reads it. */
export type RegistryShelfUnavailable = Readonly<{
  message: string;
  onRetry: () => void | Promise<void>;
}>;

/**
 * The typed acquisition result a homepage shelf already holds (`useRegistrySuggestions`), read into the one
 * outage line. A failed source page names its source and reason; a read that failed outright names the
 * shelf's source. A settled empty read carries neither, so a confirmed-empty shelf stays quiet.
 */
export function resolveRegistryShelfUnavailable(
  shelf: Readonly<{
    sourceId: string | null;
    error: string | null;
    status: RegistryFailureStatus | null;
    sourceFailures: readonly Readonly<{ sourceId: string; message: string }>[];
    refresh: () => Promise<void>;
  }>,
  sourceName: (sourceId: string) => string | undefined | null,
): RegistryShelfUnavailable | undefined {
  const failure = shelf.sourceFailures[0];
  if (!failure && !shelf.error) return undefined;
  const sourceId = failure?.sourceId ?? shelf.sourceId;
  const name = sourceId ? sourceName(sourceId) : null;
  return {
    message: failure ? name ? `${name} · ${failure.message}` : failure.message
      : describeRegistrySourceFailure(shelf.status, name),
    onRetry: shelf.refresh,
  };
}

/**
 * A capability homepage's registry shelf (P4's one suggestions rule, IR-79): three cards in a Collection
 * grid that fill the row at any column width, each with its Add. The homepage supplies the words under a
 * card's name and its action; no items, no shelf (never an empty one).
 */
function RegistryShelfContent<Item>(
  props: Readonly<{
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
  }>,
) {
  const perRow = props.perRow ?? SHELF_SIZE;
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
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  const gutter = HAPPIER_PAGE_METRICS.sheetInsetPx;
  // The cards fill the row at any column width (never an extra, empty slot), down to the card's minimum.
  const room = width - 2 * gutter;
  const minCardWidth = Math.max(
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
  const lone = perRow === SHELF_SIZE && !props.showAll && cards.length === 1 ? cards[0]! : null;
  return (
    <ItemGroup
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
      surface="none"
      {...(props.browseAll
        ? { action: <SectionActionButton testID={`${testID}.browseAll`} title={props.browseAll.label} icon="magnifying-glass" onPress={props.browseAll.onPress} /> }
        : {})}
    >
      {lone ? (
        // A card is a choice to compare a few at a time: one suggestion is one catalog row.
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
          <Item
            rowRole="catalogRow"
            testID={`${testID}.${projection.testID(lone)}.row`}
            title={projection.title(lone)}
            subtitle={projection.description(lone) ?? where(lone) ?? undefined}
            icon={glyph?.(lone) ?? undefined}
            rightElement={action(lone)}
            showChevron={false}
            onPress={() => onOpen(lone)}
          />
        </CoreCollectionScope>
      ) : null}
      {/* The card grid draws its own gutter inside the section's content: the shelf pulls that gutter back out so the cards stand on the page's sheet edge, the legend's (lab hm-A2). */}
      {!lone && (cards.length > 0 || props.loading) ? (
        <View onLayout={onLayout} style={{ marginHorizontal: -gutter }}>
          <CoreCollectionScope renderPageScroller={passThroughScroller}>
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
              loading={props.loading && cards.length === 0}
            />
          </CoreCollectionScope>
        </View>
      ) : null}
      {props.unavailable ? (
        // One verb for a source that did not answer, on every page (TASTE-S4060 D2), through the one outage line.
        <RegistrySourcesUnavailable
          testID={`${testID}.unavailable`}
          failures={[{ key: 'source', message: props.unavailable.message, onRetry: props.unavailable.onRetry }]}
        />
      ) : null}
    </ItemGroup>
  );
}
export const RegistryShelf = React.memo(
  RegistryShelfContent,
) as typeof RegistryShelfContent;

export type RegistryShelfAddState = 'available' | 'adding' | 'added' | 'failed';

/**
 * A shelf card's one add control, at its top-right corner (lab y:card): a quiet + while it can be added, its spinner
 * while adding, and a quiet check with the kind's word once it is in ("In your library", "Added"). The card itself
 * opens the item, so an added card needs no second button. Only a failed add asks again with a small bordered button.
 *
 * The control's own add ending in `added` is an acknowledged result (S10 §7.2): the shared `HappierMotionFeedback`
 * confirms it in the same box and one polite announcement names it. A card that mounts or refreshes already added,
 * and a failed or partial add, stay static and silent.
 */
export const RegistryShelfAddControl = React.memo(
  function RegistryShelfAddControl(
    props: Readonly<{
      state: RegistryShelfAddState;
      /** The card's name, so the + announces what it adds. */
      title: string;
      addLabel: string;
      addedLabel: string;
      failedLabel: string;
      onAdd: () => void;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    // Counts this control's own adds that landed (adding → added), derived while rendering so the confirming frame is the first.
    const [acknowledged, setAcknowledged] = React.useState({
      state: props.state,
      count: 0,
    });
    let count = acknowledged.count;
    if (acknowledged.state !== props.state) {
      count +=
        acknowledged.state === 'adding' && props.state === 'added' ? 1 : 0;
      setAcknowledged({ state: props.state, count });
    }
    const content =
      props.state === 'added' ? (
        <View testID={`${props.testID}.added`} style={styles.added}>
          <Icon name="check" size={14} color={theme.colors.text.tertiary} />
          <Text variant="meta" numberOfLines={1} style={styles.addedLabel}>
            {props.addedLabel}
          </Text>
        </View>
      ) : props.state === 'failed' ? (
        <RoundButton
          testID={`${props.testID}.add`}
          size="small"
          display="secondary"
          title={props.failedLabel}
          onPress={props.onAdd}
        />
      ) : (
        <IconButton
          testID={`${props.testID}.add`}
          iconName="plus"
          variant="plain"
          accessibilityLabel={`${props.addLabel}, ${props.title}`}
          tooltip={props.addLabel}
          busy={props.state === 'adding'}
          onPress={props.onAdd}
        />
      );
    return (
      <>
        <HappierMotionFeedback trigger={count}>{content}</HappierMotionFeedback>
        <PoliteAccessibilityStatus
          statusTestID={`${props.testID}.status`}
          transitionKey={String(count)}
          announcement={
            count === 0 ? '' : `${props.title}, ${props.addedLabel}`
          }
        />
      </>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  added: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minHeight: HAPPIER_ICON_BUTTON_SIZE,
  },
  addedLabel: { color: theme.colors.text.tertiary },
}));
