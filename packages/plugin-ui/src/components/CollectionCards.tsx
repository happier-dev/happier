import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { useOptionalPluginUiScrollActivityTracker, type PluginUiScrollActivityTracker } from '../presentationHost/scrollActivity.js';
import { usePageWindow } from '../presentation/collection/pageCollectionVirtualizer.js';

import {
  resolveHappierUiPalette,
  useHappierUiAccessibility,
  useHappierUiTheme,
  useOptionalHappierUiPalette,
  useOptionalHappierUiTypography,
} from '../environment/context.js';
import type { HappierTypeRole } from '../environment/types.js';
import type { HappierCollectionKey, HappierCollectionSection } from '../presentation/collection/collectionModel.js';
import { resolveHappierCollectionGridRows } from '../presentation/collection/collectionModel.js';
import { HappierCardActionsCornerContext, HappierCardFillsCellContext, HappierCardSelectionRingContext } from '../presentation/collection/CollectionList.js';
import { resolveHappierCollectionGridGeometry } from '../presentation/collection/collectionTable.js';
import { useHappierCollectionViewport, type HappierCollectionModel, type HappierCollectionViewport } from '../presentation/collection/useCollection.js';
import { HappierSkeletonBlock, HappierSkeletonTitle } from '../presentation/feedback/Skeleton.js';
import { HappierSegmentedChoice } from '../presentation/form/SegmentedChoice.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { Button } from './Button.js';
import { DropTarget } from './EntityDragDrop.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_WIDGET_FRAME_METRICS, HappierWidgetFrame } from '../presentation/layout/WidgetFrame.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierPortableStyle, HappierStyleProp } from '../presentation/portableTypes.js';
import { HappierText } from '../presentation/text/Text.js';
import { HAPPIER_WORK_STATUS_SEMANTIC_TONE } from '../presentation/work/workStatus.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { scaleTextStyleMetrics } from '../presentation/text/textStyleScale.js';
import type { CollectionAnatomy, CollectionGroupAction, CollectionProps } from './Collection.js';
import { List, ListItemSelectionContext, useRowFocusRequest, type ItemProps } from './List.js';
import { activateListItem, useListMultiSelectionRow, type ListMultiSelectionStore } from './ListMultiSelection.js';
import { renderCollectionItemDestination } from './collectionItemDestination.js';
import { ListCollectionControlContext, type ListCollectionControl } from './listCollectionControl.js';
import { usePluginTranslation } from './PluginUiProvider.js';

/**
 * The Collection's card presentations (COLLECTION.md §3, §6, §10.1): `board` draws one column of cards per group of
 * the one axis, and `grid` draws cards in responsive columns under optional shelves. Both draw the caller's one item
 * anatomy; consumers never write a card renderer. Opening a card goes through the model to the Collection's one
 * detail (the host details pane beside the cards, or the pushed page).
 */

type Theme = ReturnType<typeof useHappierUiTheme>;
type Typography = ReturnType<typeof useOptionalHappierUiTypography>;

/** One role's exact line height at the reader's text size: the Collection's geometry is arithmetic over these. */
export function readCollectionLineHeight(role: HappierTypeRole, theme: Theme, typography: Typography, textScale: number): number {
  const style = scaleTextStyleMetrics(resolveHappierTypeRoleStyle(role, theme, typography), textScale) as HappierPortableStyle;
  const value = (style as Readonly<{ lineHeight?: unknown }>).lineHeight;
  return typeof value === 'number' ? Math.ceil(value) : 20;
}

/** Deliberate card/track dimensions, not spacing steps. Insets and gaps follow the reader's theme below. */
const CARD = Object.freeze({
  /** The identity mark's box, independent of the spacing rhythm. */
  markSize: 32,
  /**
   * The preview band's height on a card of the default width: about seven preview lines, enough to recognise the
   * item at a glance. A narrower card (two across a phone) keeps the same proportion, so it shows a short preview.
   */
  previewHeight: 128,
  // Compact tracks still leave room for the mark, a readable title and the card insets.
  boardColumnMinWidth: 160,
  /** The default narrowest grid card; one column at a 390 pt phone. */
  gridMinCardWidth: 280,
  /** The list row's transparent focus-ring edge (1 each side) around the card's own edge. */
  rowLayerEdge: 2,
});
const GUTTER = HAPPIER_PAGE_METRICS.sheetInsetPx;
/** Cards sit the card gap apart, across a row and between rows (DESIGN.md → one card). */
const CARD_GAP = HAPPIER_PAGE_METRICS.cardGapPx;
const RADIUS = HAPPIER_PAGE_METRICS.sheetRadiusPx;

/** One spacing owner for both measured card heights and the insets that draw them. */
function useCardLayout() {
  const { spacing } = useHappierUiTheme();
  return useMemo(() => {
    // The card sits between the page's regular steps: roomy inside, compact between cards.
    const padding = HAPPIER_PAGE_METRICS.cardPaddingPx;
    const gap = HAPPIER_PAGE_METRICS.cardGapPx;
    const boardCardInsetX = gap;
    const boardCardInsetY = spacing.xsmall;
    return {
      padding, gap, boardCardInsetX, boardCardInsetY,
      lineStyle: { ...lineStyle, gap: spacing.small },
      boardRowStyle: { ...boardRowStyle, paddingHorizontal: GUTTER - boardCardInsetX },
      boardRowScrollStyle: { ...boardRowScrollStyle, paddingHorizontal: GUTTER - boardCardInsetX },
      boardListContentStyle: { gap: 0, paddingBottom: padding },
      boardItemStyle: { paddingHorizontal: boardCardInsetX, paddingVertical: boardCardInsetY },
      columnHeaderStyle: { gap: spacing.xsmall / 2, paddingHorizontal: boardCardInsetX, paddingTop: padding, paddingBottom: gap },
      // The phone pager stands on the cards' own edge, so a track wider than the column scrolls out at the edge the
      // whole page shares (lab `.pager`), never at an inset of its own.
      pagerStyle: { paddingVertical: gap },
      shelfHeaderStyle: { ...shelfHeaderStyle, gap: spacing.medium },
    };
  }, [spacing]);
}

export type CollectionCardsProps<Item> = Readonly<{
  presentation: 'board' | 'grid';
  selection?: CollectionProps<Item>['selection'];
  useRowActions?: CollectionProps<Item>['useRowActions'];
  useRowItem?: CollectionProps<Item>['useRowItem'];
  tabStopKey: string | null;
  eligibleKeys: readonly string[];
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  accessibilityLabel: string;
  /** The measured width the cards lay out in; `null` before the first measurement. */
  width: number | null;
  /** The measured height on screen, which a loading grid's skeleton fills; `null` before the first measurement. */
  height?: number | null;
  /** Both panes do not fit: the board pages its columns (a phone). */
  narrow: boolean;
  boardLayout?: 'columns' | 'stacked';
  /** The item whose detail is on screen, marked selected. */
  selectedKey: HappierCollectionKey | null;
  /** Move focus to this card (a new object is a new request), e.g. after its detail closes. */
  focusRequest: Readonly<{ key: HappierCollectionKey }> | null;
  onFocusedKeyChange: (key: HappierCollectionKey, viewport?: HappierCollectionViewport) => void;
  /** The narrowest card: the grid's columns follow the measured width, and a board's columns never draw narrower. */
  minCardWidth?: number;
  /** A one-column grid stacks its cards, or pages each group sideways (`CollectionProps.narrowGrid`). */
  narrowGrid?: 'stack' | 'page';
  /** A shelf's one header action, by group key. */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
  /** Items are still arriving: the grid holds its geometry with skeleton cards. */
  loading?: boolean;
  /** Rows of cards the caller knows are coming (a shelf's one row); the skeleton reserves exactly those. */
  loadingRows?: number;
  empty?: ReactNode;
  /** The grid scrolls with the page around it (the Collection's `scroll="page"`): it draws no scroller of its own. */
  pageScroll?: boolean;
  testID?: string;
}>;

type CardText = Readonly<{ title: number; description: number; meta: number; label: number }>;

function useCardText(): CardText {
  const theme = useHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const { textScale } = useHappierUiAccessibility();
  return useMemo(() => ({
    // The roles the card draws (lab store `y:card`): a heading title, a body description, a meta facts line.
    title: readCollectionLineHeight('heading', theme, typography, textScale),
    description: readCollectionLineHeight('body', theme, typography, textScale),
    meta: readCollectionLineHeight('meta', theme, typography, textScale),
    label: readCollectionLineHeight('label', theme, typography, textScale),
  }), [textScale, theme, typography]);
}

function useCardColors() {
  const theme = useHappierUiTheme();
  const palette = useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  return { theme, palette };
}

function Slot(props: Readonly<{ value: ReactNode; tone?: 'secondary' | 'muted' }>): ReactElement | null {
  const value = props.value;
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <HappierText variant="meta" tone={props.tone ?? 'secondary'} numberOfLines={1} tabularNumbers style={shrinkStyle}>
        {String(value)}
      </HappierText>
    );
  }
  return <>{value}</>;
}

/** The ring that marks the card whose detail is open: drawn over the edge, so the card never changes size. */
function SelectedRing(props: Readonly<{ color: string; testID?: string }>): ReactElement {
  return <View pointerEvents="none" testID={props.testID} style={[ringStyle, { borderColor: props.color }]} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------------------------

function BoardCard<Item>(props: Readonly<{ item: Item; anatomy: CollectionAnatomy<Item>; selected: boolean; reserveActions: boolean;
  /**
   * A board card (lab c7 board): its mark and title share one line, and the title is the item's identity ("Retry
   * idempotent payment intents on 409 conflicts"), so it takes two lines before it truncates. Its reason leads the
   * facts line beneath. A grid card keeps the catalog anatomy (mark row, one-line title, reason at the top right),
   * so a row of cards keeps one geometry.
   */
  board?: boolean;
  /** The grid track's height for this card's edge, so a row's cards share one edge and one facts baseline. */
  minHeight?: number;
  /** A grid card's preview band height: the frame's edge wraps the band, and its header starts below it. */
  previewInset?: number;
  /** A grid card's frame takes its cell's height where the grid row stretches (web). */
  fillsCell?: boolean }>): ReactElement {
  const { item, anatomy } = props;
  const card = useCardLayout();
  const { palette } = useCardColors();
  const { textScale } = useHappierUiAccessibility();
  const testID = anatomy.testID?.(item);
  const description = anatomy.description?.(item) ?? null;
  const reason = anatomy.reason?.(item);
  const action = anatomy.action?.(item);
  const board = props.board === true;
  // A card under a preview band (lab artifacts A1): mark beside the title, where under it, kind and age at the foot.
  const previewCard = (props.previewInset ?? 0) > 0;
  const cardText = useCardText();
  const theme = useHappierUiTheme();
  // A name still arriving (`titlePending`) holds the loading rows' title bar on the card's title line.
  const pendingTitle = anatomy.titlePending?.(item) === true ? <HappierSkeletonTitle theme={theme} lineHeight={cardText.title}
    {...(testID === undefined ? {} : { testID: `${testID}:title-pending` })} /> : null;
  // The mark centres on the title's first line, so a wrapped title keeps the mark beside its opening words.
  const boardMark = board ? <View style={[boardMarkStyle, { height: cardText.title }]}>{anatomy.glyph(item)}</View> : null;
  // On a board the reason moves to the facts line, so the top-right slot holds only the item's own control.
  const headerReason = board || previewCard ? undefined : reason;
  const headerRight = anatomy.card?.headerRight ? anatomy.card.headerRight(item) : (
    present(headerReason) || present(action) ? <View pointerEvents="box-none" style={card.lineStyle}>
      <View pointerEvents="none" style={shrinkStyle}><Slot value={headerReason} /></View>
      {present(action) ? <View pointerEvents="auto" style={{ flexShrink: 0 }}>{action}</View> : null}
    </View> : null
  );
  // On a board the reason follows the card's place (lab c7 board: "payments-api #2481 · 18m", then the badge with
  // its state), so a wrapped facts line breaks before the badge rather than splitting the place from its card.
  // The top-right slot holds only the card's own control: a long state word there squeezed a narrow column's title.
  const boardReason = (board || previewCard) && present(reason) ? <Passive key="reason"><Slot value={reason} tone={previewCard ? 'muted' : undefined} /></Passive> : null;
  const place = anatomy.byline ? anatomy.byline(item) : anatomy.where?.(item);
  const placeUnderTitle = previewCard && !anatomy.card?.description && !hasDescription(description);
  const facts = anatomy.card?.facts ? [...(boardReason ? [boardReason] : []), <Passive key="facts">{anatomy.card.facts(item)}</Passive>] : [
    ...(placeUnderTitle ? [] : [place]).filter(present).map((value) => <Passive key="place"><Slot value={value} tone="muted" /></Passive>),
    ...(boardReason ? [boardReason] : []),
    ...(previewCard ? [<View key="end" style={factsEndStyle} />] : []),
    ...[anatomy.signal?.(item), anatomy.agent?.(item), anatomy.age?.(item)]
      .filter(present).map((value, index) => <Passive key={index}><Slot value={value} tone="muted" /></Passive>),
  ];
  const body = anatomy.card?.body;
  // Like a two-line list row, a card whose facts carry the byline says the designation there, not after the title.
  const titleSuffix = anatomy.byline === undefined ? anatomy.titleSuffix : undefined;
  return <HappierWidgetFrame frameStyle="card" placement="board" anatomy={previewCard ? 'previewItem' : 'item'} testID={testID === undefined ? undefined : `${testID}:chrome`}
    cardStyle={[boardCardStyle, { backgroundColor: palette.sheet, borderColor: palette.sheetBorder }, props.minHeight === undefined ? null : { minHeight: props.minHeight },
      props.previewInset ? { paddingTop: props.previewInset } : null, props.fillsCell && Platform.OS === 'web' ? CELL_FILL_STYLE : null]}
    mark={board ? undefined : anatomy.glyph(item)} title={titleSuffix || anatomy.titleMeta ? <View pointerEvents="none" style={[card.lineStyle, { flexWrap: 'wrap' }]}>
      {boardMark}
      {pendingTitle ?? <HappierText variant="heading" tone="neutral">{anatomy.title(item)}</HappierText>}
      <Slot value={titleSuffix?.(item)} />
      <Slot value={anatomy.titleMeta?.(item)} />
    </View> : board ? <View pointerEvents="none" style={[card.lineStyle, { alignItems: 'flex-start' }]}>
      {boardMark}
      {pendingTitle ?? <HappierText variant="heading" tone="neutral" numberOfLines={2} accessibilityRole="header" style={shrinkStyle}>{anatomy.title(item)}</HappierText>}
    </View> : pendingTitle ?? anatomy.title(item)}
    source={anatomy.card?.description ? <Passive>{anatomy.card.description(item)}</Passive>
      : hasDescription(description) ? <Passive><HappierText variant="body" tone="secondary" numberOfLines={2} testID={testID === undefined ? undefined : `${testID}:description`}>{description}</HappierText></Passive>
      : placeUnderTitle && present(place) ? <Passive><Slot value={place} tone="muted" /></Passive> : null}
    accessory={props.reserveActions ? <View style={{ paddingRight: CARD.markSize, minWidth: 0 }}>{headerRight}</View> : headerRight}
    facts={Array.isArray(facts) && facts.length === 0 ? null : facts}
    bodyStyle={body?.heightAtNormalText === undefined ? undefined : { minHeight: Math.ceil(body.heightAtNormalText * textScale) }}
    overlay={props.selected ? <SelectedRing color={palette.selection} /> : null}
  >{body ? <View pointerEvents="none" style={passiveBodyStyle}>{body.render(item)}</View> : null}</HappierWidgetFrame>;
}

/**
 * A card's content that is not a control (title, description, body, facts) lets the pointer through to the open
 * target beneath it (`contentBesidePressable`), so pressing anywhere on the card opens it. The frame's own wrappers
 * are `box-none`, which hands pointer hits back to their children; this is what keeps those children passive.
 * Controls stay in `headerRight` and the card's actions corner, outside these slots (CollectionAnatomy.card).
 */
function Passive(props: Readonly<{ children: ReactNode }>): ReactElement {
  return <View pointerEvents="none" style={passiveSlotStyle}>{props.children}</View>;
}
const passiveSlotStyle: HappierPortableStyle = { minWidth: 0, flexShrink: 1 };
const boardMarkStyle: HappierPortableStyle = { justifyContent: 'center', flexShrink: 0 };
const passiveBodyStyle: HappierPortableStyle = { flexGrow: 1, minWidth: 0 };
/** Pushes a preview card's age to the end of its foot line, across from its kind. */
const factsEndStyle: HappierPortableStyle = { flexGrow: 1 };

function BoardCardRow<Item>(props: Readonly<{
  item: Item;
  anatomy: CollectionAnatomy<Item>;
  selected: boolean;
  useRowActions?: CollectionProps<Item>['useRowActions'];
  useRowItem?: CollectionProps<Item>['useRowItem'];
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const card = useCardLayout();
  const cardText = useCardText();
  const { anatomy } = props;
  const item = props.useRowItem?.(props.item) ?? props.item;
  const actions = props.useRowActions?.(item) ?? {};
  // Row actions are the card's own corner control, not a sibling beside the card: they sit at the title line's
  // end inside the card's body (its top and side insets), revealed like a grid card's. The title stands on the
  // card's top inset (the frame centres its controls on that line), so the corner's box centres there too.
  const hasRowActions = ((actions.secondaryActions !== undefined && actions.secondaryActions.length > 0)
    || (host?.renderDestinationRow !== undefined && anatomy.destination?.(item) != null));
  const actionsCorner = useMemo(() => hasRowActions ? {
    top: card.padding + card.boardItemStyle.paddingVertical - (CARD.markSize - cardText.title) / 2,
    end: card.padding + card.boardItemStyle.paddingHorizontal,
    height: CARD.markSize,
  } : null, [card.padding, card.boardItemStyle.paddingHorizontal, card.boardItemStyle.paddingVertical, cardText.title, hasRowActions]);
  const row: ReactElement<ItemProps> = <List.Item
    {...actions} density="compact" showDivider={false} accessoryOutsidePressable contentBesidePressable
    accessibilityLabel={anatomy.accessibilityLabel(item)}
    accessibilityHint={anatomy.accessibilityHint?.(item)}
    testID={anatomy.testID?.(item)} style={card.boardItemStyle}
  ><BoardCard item={item} anatomy={anatomy} selected={props.selected} reserveActions={actionsCorner !== null} board /></List.Item>;
  const composed = <HappierCardActionsCornerContext.Provider value={actionsCorner}>{renderCollectionItemDestination(host, anatomy, item, row)}</HappierCardActionsCornerContext.Provider>;
  return <>{composed}</>;
}

function BoardColumn<Item>(props: Readonly<{
  section: HappierCollectionSection<Item>;
  selection?: CollectionProps<Item>['selection'];
  useRowActions?: CollectionProps<Item>['useRowActions'];
  useRowItem?: CollectionProps<Item>['useRowItem'];
  tabStopKey: string | null;
  eligibleKeys: readonly string[];
  columnKey: string;
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  label: string;
  selectedKey: HappierCollectionKey | null;
  focusRequest: Readonly<{ key: string }> | undefined;
  onFocusedKeyChange: (key: HappierCollectionKey, viewport?: HappierCollectionViewport) => void;
  style: HappierStyleProp;
  showHeader: boolean;
  pageScroll?: boolean;
  testID?: string;
}>): ReactElement {
  const { section, model, anatomy, selectedKey } = props;
  const card = useCardLayout();
  const keyOf = model.keyOf;
  const open = model.actions.open;
  const single = props.selection?.single;
  const choose = useCallback((key: string) => {
    if (single !== undefined && key !== single.value) single.onValueChange(key);
  }, [single?.value, single?.onValueChange]);
  const { viewport, scrollRequest } = useHappierCollectionViewport(model, 'board', props.columnKey);
  const observeFocus = useCallback((key: string) => props.onFocusedKeyChange(key, viewport), [props.onFocusedKeyChange, viewport]);
  const selected = selectedKey !== null && section.items.some((item) => keyOf(item) === selectedKey) ? selectedKey : null;
  const renderItem = useCallback((item: Item) => <BoardCardRow item={item} anatomy={anatomy}
    selected={keyOf(item) === selected} useRowActions={props.useRowActions} useRowItem={props.useRowItem} />, [anatomy, keyOf, props.useRowActions, props.useRowItem, selected]);
  const control = useMemo<ListCollectionControl>(() => ({
    ownsSelectionRows: true,
    hideChrome: true,
    ...(single === undefined ? {} : { collectionRole: 'group' as const }),
    pageScroll: props.pageScroll,
    scroll: { offsetRef: viewport.offsetRef, request: scrollRequest },
    focus: { key: model.focusKey, tabStopKey: props.tabStopKey, request: model.focusRequest,
      onRequestHandled: model.actions.consumeFocusRequest,
      onKey: (key, from, event) => model.actions.navigate({ key, from, event, presentation: 'board',
        store: props.selection?.multiple?.store, eligibleKeys: props.eligibleKeys,
        ...(single === undefined ? {} : { onValueChange: choose }) }) },
  }), [choose, model, props.eligibleKeys, props.pageScroll, props.selection?.multiple?.store, props.tabStopKey, scrollRequest, single === undefined, viewport]);
  const group = section.group;
  const content = <>
      {!props.showHeader || group === null || group.title === '' ? null : (
        <View style={card.columnHeaderStyle}>
          <View style={card.lineStyle}>
            <HappierText variant="label" tone={HAPPIER_WORK_STATUS_SEMANTIC_TONE[section.items.length > 0 ? group.tone ?? 'neutral' : 'neutral']} style={[titleStyle, { flexShrink: 1 }]}>{group.title}</HappierText>
            <HappierText variant="meta" tone="muted" tabularNumbers>{String(section.items.length)}</HappierText>
          </View>
          {group.description === undefined ? null : (
            <HappierText variant="meta" tone="muted" numberOfLines={2}>{group.description}</HappierText>
          )}
        </View>
      )}
      {/* An empty column says so by its header's count ("Needs you 0"); it draws no second line. */}
      <View style={props.pageScroll ? undefined : fillStyle}>
        <ListCollectionControlContext.Provider value={control}>
          <List<Item>
            accessibilityLabel={props.label}
            accessibilityPattern="grid"
            density="compact"
            contentContainerStyle={card.boardListContentStyle}
            items={section.items}
            keyForItem={keyOf}
            renderItem={renderItem}
            selection={single === undefined ? {
              isItemActivatable: props.selection?.isItemActivatable,
              multiple: props.selection?.multiple,
              selectedKey: selected,
              onSelectedKeyChange: open,
              onFocusedKeyChange: observeFocus,
              ...(props.focusRequest === undefined ? {} : { focusRequest: props.focusRequest }),
            } : { single, isItemActivatable: props.selection?.isItemActivatable, onFocusedKeyChange: observeFocus }}
          />
        </ListCollectionControlContext.Provider>
      </View>
    </>;
  return <View style={props.style} testID={props.testID}>
    {group?.membership?.kind === 'assignable'
      ? <DropTarget {...group.membership.target} style={fillStyle}>{content}</DropTarget>
      : content}
  </View>;
}

function CollectionBoard<Item>(props: CollectionCardsProps<Item>): ReactElement {
  const { model } = props;
  const card = useCardLayout();
  const { theme, palette } = useCardColors();
  const translate = usePluginTranslation();
  const { textScale, reducedMotion } = useHappierUiAccessibility();
  const sections = model.sections;
  const narrow = props.boardLayout === undefined && props.narrow;
  const stacked = props.boardLayout === 'stacked';
  const boardViewport = model.viewport('board');
  const stackedScroll = useRef<ScrollView | null>(null);
  const horizontalScroll = useRef<ScrollView | null>(null);
  // A caller's narrowest card sets the track (the card plus its insets); otherwise the compact track.
  const minColumn = props.minCardWidth === undefined ? CARD.boardColumnMinWidth * textScale
    : props.minCardWidth * textScale + 2 * card.boardCardInsetX;
  // Empty and populated buckets keep the same track; arrivals never resize their neighbours.
  const availableWidth = props.width === null ? null : Math.max(0, props.width - 2 * (GUTTER - card.boardCardInsetX));
  const fits = availableWidth === null || sections.length * minColumn <= availableWidth;
  const columnWidth = availableWidth === null ? null : Math.max(minColumn, availableWidth / Math.max(1, sections.length));
  useLayoutEffect(() => {
    horizontalScroll.current?.scrollTo({ x: boardViewport.horizontalOffsetRef.current, animated: false });
    if (!props.pageScroll) stackedScroll.current?.scrollTo({ y: boardViewport.offsetRef.current, animated: false });
  }, [boardViewport, fits, narrow, props.pageScroll, stacked]);
  const columnKeys = useMemo(() => sections.map((section, index) => section.group?.key ?? `collection-${index}`), [sections]);
  const page = model.boardColumnKey;
  // A reader's explicit choice wins even when that column is empty. Until
  // they choose, land where the rows are, including after the first load.
  const pageKey = page !== null && columnKeys.includes(page) ? page
    : columnKeys[sections.findIndex(section => section.items.length > 0)] ?? columnKeys[0] ?? null;
  const focusRequest = props.focusRequest ?? model.focusRequest;
  // A board that does not fit scrolls sideways to show one whole column, edge and focus ring included; the
  // nearest edge moves, and a column already on screen stays put.
  const revealColumn = (column: number) => {
    if (fits || narrow || stacked || column < 0 || columnWidth === null || props.width === null) return;
    const edge = GUTTER - card.boardCardInsetX;
    const start = edge + column * columnWidth;
    const end = start + columnWidth;
    const offset = boardViewport.horizontalOffsetRef.current;
    const next = start - edge < offset ? Math.max(0, start - edge)
      : end + edge > offset + props.width ? end + edge - props.width : offset;
    if (next === offset) return;
    boardViewport.horizontalOffsetRef.current = next;
    horizontalScroll.current?.scrollTo({ x: next, animated: !reducedMotion });
  };
  // The open card stays on screen when its detail narrows the board (the host's pane opens beside it): its column
  // comes into view once per open or width change, never on data refresh.
  const openColumn = props.selectedKey === null ? -1
    : sections.findIndex(section => section.items.some(item => model.keyOf(item) === props.selectedKey));
  useEffect(() => {
    revealColumn(openColumn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openColumn, fits, columnWidth, props.width]);
  useEffect(() => {
    if (focusRequest === null) return;
    const column = sections.findIndex(section => section.items.some(item => model.keyOf(item) === focusRequest.key));
    const key = columnKeys[column];
    if (key !== undefined) model.actions.showColumn(key);
    // Keyboard focus moving across columns brings the focused card's column into view.
    revealColumn(column);
    // A request moves the page once; refreshing data must not undo a reader's pager choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  if (model.keys.length === 0 && props.empty !== undefined) return <View style={fillStyle}>{props.empty}</View>;

  const columnFor = (section: HappierCollectionSection<Item>, index: number, style: HappierStyleProp, showHeader: boolean) => {
    const columnKey = columnKeys[index]!;
    return (
      <BoardColumn
        key={columnKey}
        section={section}
        columnKey={columnKey}
        model={model}
        anatomy={props.anatomy}
        label={section.group?.title || props.accessibilityLabel}
        selectedKey={props.selectedKey}
        focusRequest={focusRequest !== null && section.items.some(item => model.keyOf(item) === focusRequest.key) ? focusRequest : undefined}
        selection={props.selection}
        useRowActions={props.useRowActions}
        useRowItem={props.useRowItem}
        eligibleKeys={props.eligibleKeys}
        tabStopKey={narrow && !section.items.some(item => model.keyOf(item) === props.tabStopKey)
          ? section.items.map(model.keyOf).find(key => key === model.viewport('board', columnKey).anchorRef.current && props.eligibleKeys.includes(key))
            ?? section.items.map(model.keyOf).find(key => props.eligibleKeys.includes(key)) ?? null : props.tabStopKey}
        onFocusedKeyChange={props.onFocusedKeyChange}
        style={style}
        showHeader={showHeader}
        pageScroll={stacked}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:column:${columnKey}` })}
      />
    );
  };

  if (stacked) return <ScrollView ref={stackedScroll} scrollEnabled={!props.pageScroll} style={props.pageScroll ? undefined : fillStyle} contentContainerStyle={{ gap: card.gap,
    paddingVertical: card.padding, paddingHorizontal: GUTTER - card.boardCardInsetX }}
    scrollEventThrottle={16} onScroll={props.pageScroll ? undefined : event => { boardViewport.offsetRef.current = event.nativeEvent.contentOffset.y; }}>
    {sections.map((section, index) => columnFor(section, index, {}, true))}
  </ScrollView>;

  if (narrow) {
    // A phone pages the columns: one column at a time, chosen by name and count.
    const index = pageKey === null ? -1 : columnKeys.indexOf(pageKey);
    const section = index < 0 ? undefined : sections[index];
    return (
      <View style={fillStyle}>
        {sections.length < 2 ? null : (
          <View style={card.pagerStyle}>
            <HappierSegmentedChoice
              accessibilityLabel={translate('happier.plugin-ui.collection.board.columns', 'Columns')}
              scrollable
              segments={sections.map((candidate, candidateIndex) => ({
                key: columnKeys[candidateIndex]!,
                label: `${candidate.group?.title ?? ''} ${candidate.items.length}`,
                selected: candidateIndex === index,
                disabled: false,
              }))}
              onSelect={(next) => { const key = columnKeys[next]; if (key !== undefined) model.actions.showColumn(key); }}
              colors={{
                track: palette.segmentTrack,
                thumb: palette.segmentThumb,
                thumbLift: palette.segmentThumbLift,
                label: theme.colors.secondaryText,
                activeLabel: theme.colors.text,
                focusRing: theme.colors.focus,
              }}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}:pager` })}
            />
          </View>
        )}
        {section === undefined ? null : columnFor(section, index, fillStyle, sections.length < 2)}
      </View>
    );
  }

  const columns = sections.map((section, index) => columnFor(section, index, [
    columnWidth === null ? { flex: 1, minWidth: 0 } : { width: columnWidth, flexShrink: 0 },
  ], true));
  return fits ? (
    <View style={card.boardRowStyle}>{columns}</View>
  ) : (
    <ScrollView ref={horizontalScroll} horizontal style={fillStyle} contentContainerStyle={card.boardRowScrollStyle} scrollEventThrottle={16}
      onScroll={event => { boardViewport.horizontalOffsetRef.current = event.nativeEvent.contentOffset.x; }}>{columns}</ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------------------------------------------

type GridGeometry = Readonly<{
  /**
   * A card with no description and no footer content is a compact tile (R-APP-14): mark and title on one
   * row, its `where` quiet on that row's end, one row's height plus the card padding.
   */
  compact: boolean;
  columns: number;
  cardWidth: number;
  cardHeight: number;
  /** One card per row: no row peers to align with, so the card follows its content (no reserved bands). */
  fitContent?: boolean;
  /** One row that pages sideways (`narrowGrid: 'page'`): the cards keep their own width. */
  paged?: boolean;
  /** Zero when the anatomy draws no preview band. */
  previewHeight: number;
}>;

/** Which of a card's optional slots this grid keeps: those at least one of its cards fills (every card keeps them). */
type GridSlots = Readonly<{ description: boolean; facts: boolean; body: boolean; headerRight: boolean; preview: boolean;
  /** A preview card's `where` line under its title: kept only when a card says where it came from. */
  place: boolean }>;

function present(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false;
}

function hasDescription(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

function useGridSlots<Item>(model: HappierCollectionModel<Item>, anatomy: CollectionAnatomy<Item>): GridSlots {
  return useMemo(() => {
    const items = model.sections.flatMap((section) => section.items);
    if (items.length === 0) {
      // Nothing to read yet (loading): hold the anatomy's declared shape, so the skeleton matches what arrives.
      return {
        description: anatomy.description !== undefined || anatomy.card?.description !== undefined,
        facts: anatomy.card?.facts !== undefined || anatomy.where !== undefined || anatomy.age !== undefined,
        body: anatomy.card?.body !== undefined,
        headerRight: anatomy.card?.headerRight !== undefined || anatomy.reason !== undefined || anatomy.action !== undefined,
        preview: anatomy.preview !== undefined,
        place: anatomy.where !== undefined || anatomy.byline !== undefined,
      };
    }
    return readGridSlots(items, anatomy);
  }, [anatomy, model.sections]);
}

/** Optional content determines each track's minimum; bodies and text can grow beyond it. */
function readGridSlots<Item>(items: readonly Item[], anatomy: CollectionAnatomy<Item>): GridSlots {
  let description = anatomy.card?.description !== undefined;
  let facts = false;
  let headerRight = false;
  let place = false;
  for (const item of items) {
    if (!place && (present(anatomy.where?.(item)) || present(anatomy.byline?.(item)))) place = true;
    if (!description && hasDescription(anatomy.description?.(item))) description = true;
    if (!facts && (present(anatomy.card?.facts?.(item)) || present(anatomy.where?.(item)) || present(anatomy.byline?.(item)) || present(anatomy.age?.(item)) || present(anatomy.agent?.(item)) || present(anatomy.signal?.(item)))) facts = true;
    if (!headerRight && (present(anatomy.card?.headerRight?.(item)) || present(anatomy.reason?.(item)) || present(anatomy.action?.(item)))) headerRight = true;
  }
  return { description, facts, headerRight, body: anatomy.card?.body !== undefined, preview: anatomy.preview !== undefined, place };
}

/**
 * The grid's card geometry for a set of bands. Exact per text size, never measured per card. The grid's
 * columns come from its whole-grid bands; each shelf sizes its cards from its own (a shelf where no card
 * has a description or a footer drops that band), so heights stay equal within a shelf.
 */
function useGridGeometryResolver(width: number | null, minCardWidth: number, contentHeightAtNormalText: number | null,
  previewAspectRatio?: number): (slots: GridSlots) => GridGeometry {
  const card = useCardLayout();
  const text = useCardText();
  const { textScale } = useHappierUiAccessibility();
  return useCallback((slots: GridSlots): GridGeometry => {
    const inner = Math.max(0, (width ?? 0) - 2 * GUTTER);
    const { columns, cardWidth } = resolveHappierCollectionGridGeometry({ width: inner, minCardWidth: minCardWidth * textScale, gap: CARD_GAP });
    const previewHeight = !slots.preview ? 0 : previewAspectRatio ? Math.round(cardWidth / previewAspectRatio)
      : Math.min(CARD.previewHeight, Math.round(cardWidth * CARD.previewHeight / (CARD.gridMinCardWidth * textScale)));
    // The arithmetic of what the one frame draws (WidgetFrame card): its border, insets, identity row and gaps.
    const F = HAPPIER_WIDGET_FRAME_METRICS;
    if (!slots.description && !slots.facts && !slots.body && !slots.headerRight && previewHeight === 0) {
      // One line: the frame centres the mark on the title's line, so the line is the title's.
      return { compact: true, columns, cardWidth, cardHeight: CARD.rowLayerEdge + 2 + 2 * card.padding + text.title,
        previewHeight };
    }
    if (previewHeight > 0) {
      // The band, the title beside the mark over its `where` line (reserved while any card has one), then the foot.
      const cardHeight = CARD.rowLayerEdge + 2 + previewHeight + card.padding + text.title + (slots.place ? F.previewPlaceGapPx + text.meta : 0)
        + (slots.facts ? F.headerGapPx + text.meta + card.padding : card.padding);
      return { compact: false, columns, cardWidth, cardHeight, previewHeight, fitContent: columns === 1 };
    }
    const content = contentHeightAtNormalText === null ? 0 : Math.ceil(contentHeightAtNormalText * textScale);
    const cardHeight = CARD.rowLayerEdge + 2 + card.padding + CARD.markSize + F.cardTitleGapPx + text.title + previewHeight
      + (slots.description ? F.cardDescriptionGapPx + 2 * text.description : 0)
      + (slots.body ? card.padding + content + F.bodyBottomInsetPx : 0)
      + (slots.facts ? (slots.body ? 0 : F.cardFactsGapPx) + text.meta + card.padding : slots.body ? 0 : card.padding);
    return { compact: false, columns, cardWidth, cardHeight, previewHeight,
      fitContent: columns === 1 };
  }, [card, contentHeightAtNormalText, minCardWidth, previewAspectRatio, text, textScale, width]);
}

function GridCardView<Item>(props: Readonly<{
  item: Item;
  itemKey: string;
  anatomy: CollectionAnatomy<Item>;
  geometry: GridGeometry;
  selected: boolean;
  tabStop: boolean;
  onOpen: (key: string) => void;
  onFocus: (key: string) => void;
  onKey: (key: string, from: string, event: unknown) => boolean;
  /** The grid's card count (its grid row extent). Never the model: a new object on every render. */
  count: number;
  /**
   * This card's resolved selection facts. Never the caller's `selection` object, which a consumer may
   * rebuild on every render: a memoized card would then re-render with every one.
   */
  activatable: boolean;
  selectable: boolean;
  multipleStore: ListMultiSelectionStore | null;
  singleChoice: boolean;
  unavailableReason?: string | null;
  useRowActions?: CollectionProps<Item>['useRowActions'];
  useRowItem?: CollectionProps<Item>['useRowItem'];
  rowIndex: number;
  /** Remaining cells in this logical row, kept as layout space without reparenting keyed cards. */
  rowEndSpace: number;
  register: (key: string, target: HappierFocusable | null) => void;
  /** A windowed grid's content-sized card reports its drawn height, so the page window places the lines below it. */
  onHeight?: (key: string, height: number) => void;
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const cardLayout = useCardLayout();
  const cardText = useCardText();
  const { itemKey, anatomy, geometry } = props;
  const item = props.useRowItem?.(props.item) ?? props.item;
  const { palette } = useCardColors();
  const testID = anatomy.testID?.(item);
  const register = props.register;
  const onKey = props.onKey;
  const onFocus = props.onFocus;
  const multi = useListMultiSelectionRow(itemKey);
  const cardSelected = props.multipleStore !== null ? multi.isSelected : props.selected;
  const actions = props.useRowActions?.(item) ?? {};
  const { activatable, selectable } = props;
  // Row actions sit at the title line's end (the line reserves their width), not beside the card's body.
  // A host destination can add its own row actions (open in a new tab), so a destination card reserves the place too.
  const hasRowActions = ((actions.secondaryActions !== undefined && actions.secondaryActions.length > 0)
    || (host?.renderDestinationRow !== undefined && anatomy.destination?.(item) != null));
  // Under a band there is no identity row: the corner centres on the title's own line instead.
  const actionsTop = geometry.previewHeight > 0
    ? geometry.previewHeight + cardLayout.padding - (CARD.markSize - cardText.title) / 2 : cardLayout.padding;
  const actionsCorner = useMemo(() => hasRowActions ? {
    top: actionsTop,
    end: cardLayout.padding, height: CARD.markSize,
  } : null, [actionsTop, cardLayout.padding, hasRowActions]);
  const select = (event?: import('../presentation/portableTypes.js').HappierGestureResponderEvent): 'handled' | 'open' => {
    if (props.singleChoice) {
      onFocus(itemKey);
      props.onOpen(itemKey);
      return 'handled';
    }
    return activateListItem({ key: itemKey, event, store: props.multipleStore,
      focus: onFocus, open: props.onOpen });
  };
  // The open card stays in view while the grid re-flows around a pane opening beside it (a new column count moves
  // every card). Web hosts only: a native View has no `scrollIntoView`, and a card already in view does not move.
  const cardRef = useRef<View>(null);
  const selectedForReveal = props.selected;
  useEffect(() => {
    if (selectedForReveal) revealNearest(cardRef.current);
  }, [selectedForReveal, geometry.cardWidth]);
  const row: ReactElement<ItemProps> = (
    <List.Item {...actions} showDivider={false} density="compact" accessoryOutsidePressable contentBesidePressable
      accessibilityLabel={anatomy.accessibilityLabel(item)} accessibilityHint={anatomy.accessibilityHint?.(item)}
      // Sized by its content (the card's minHeight keeps a row's cards equal): a growing child of a wrapped grid row
      // takes the whole grid's height under React Native's Yoga errata, and every card stretched to it on iOS.
      testID={testID} style={GRID_CARD_ITEM_STYLE}
    >
      <BoardCard item={item} anatomy={anatomy} selected={false} reserveActions={hasRowActions} previewInset={geometry.previewHeight} fillsCell
        minHeight={geometry.fitContent ? undefined : geometry.cardHeight - CARD.rowLayerEdge} />
    </List.Item>
  );
  const card = (
    <View
      ref={cardRef}
      style={[gridCardStyle, { width: geometry.cardWidth, marginEnd: props.rowEndSpace, ...(geometry.fitContent ? {} : { minHeight: geometry.cardHeight }) }]}
      testID={testID === undefined ? undefined : `${testID}:card`}
      {...(props.onHeight === undefined ? {} : { onLayout: (event: HappierLayoutChangeEvent) => props.onHeight!(itemKey, event.nativeEvent.layout.height) })}
    >
      <ListItemSelectionContext.Provider value={{
        itemKey, multiSelectable: selectable, selected: cardSelected,
        activatable, select, positionInSet: props.rowIndex + 1, setSize: props.count,
        roving: { isTabStop: props.tabStop, register: target => register(itemKey, target),
          onFocus: () => onFocus(itemKey),
          onKeyDown: (key, event) => onKey(key, itemKey, event) },
        accessibilityPattern: props.singleChoice ? 'radiogroup' : 'grid', unavailableReason: props.unavailableReason,
        rowIndex: props.rowIndex, rowCount: props.count,
      }}>
        <HappierCardSelectionRingContext.Provider value>
          <HappierCardFillsCellContext.Provider value>
            <HappierCardActionsCornerContext.Provider value={actionsCorner}>
              {renderCollectionItemDestination(host, anatomy, item, row)}
            </HappierCardActionsCornerContext.Provider>
          </HappierCardFillsCellContext.Provider>
        </HappierCardSelectionRingContext.Provider>
      </ListItemSelectionContext.Provider>
      {geometry.previewHeight === 0 ? null : (
        // Anchor the edge-to-edge band to the card, not the padded metadata inside List.Item.
        <View
          pointerEvents="none"
          style={[gridPreviewStyle, {
            height: geometry.previewHeight,
            borderTopLeftRadius: RADIUS - 2,
            borderTopRightRadius: RADIUS - 2,
            // On the card's own material (lab A1): a second fill made the foot under it read as a slab.
            borderBottomColor: palette.rowDivider,
          }]}
          {...(testID === undefined ? {} : { testID: `${testID}:preview` })}
        >
          {anatomy.preview?.(item)}
        </View>
      )}
      {/* The ring is the card's one selection mark, for the open card and for each card in a bulk set. */}
      {props.selected || cardSelected ? <SelectedRing color={palette.selection} {...(testID === undefined ? {} : { testID: `${testID}:selected` })} /> : null}
    </View>
  );
  return card;
}

/**
 * One card re-renders only when its own facts change (its item, selection, tab stop, geometry): opening an
 * item or moving focus commits the two cards involved, not the whole grid.
 */
const GridCard = memo(GridCardView) as typeof GridCardView;

function CollectionGrid<Item>(props: CollectionCardsProps<Item>): ReactElement {
  const { model, anatomy } = props;
  const card = useCardLayout();
  const { theme, palette } = useCardColors();
  const { viewport, scrollRequest } = useHappierCollectionViewport(model, 'grid');
  const resolveGeometry = useGridGeometryResolver(props.width, props.minCardWidth ?? CARD.gridMinCardWidth,
    anatomy.card?.body?.heightAtNormalText ?? null, anatomy.previewAspectRatio);
  const gridSlots = useGridSlots(model, anatomy);
  const { textScale } = useHappierUiAccessibility();
  const inner = props.width === null ? null : props.width - 2 * GUTTER;
  const longestGroup = Math.max(0, ...model.sections.map((section) => section.items.length));
  // A lone card has nothing to page to: it stacks like any one-column grid.
  const pageWidth = props.narrowGrid === 'page' && inner !== null && (longestGroup > 1 || props.loading === true)
    ? Math.min((props.minCardWidth ?? CARD.gridMinCardWidth) * textScale, inner - CARD_GAP - GUTTER) : null;
  const resolvePageableGeometry = useCallback((slots: GridSlots): GridGeometry => {
    const resolved = resolveGeometry(slots);
    // A paging shelf: the cards stand in one row at its card width and share the row's height.
    return pageWidth === null || resolved.columns > 1 ? resolved
      : { ...resolved, cardWidth: pageWidth, fitContent: false, paged: true };
  }, [pageWidth, resolveGeometry]);
  const { description, facts, body, headerRight, preview, place } = gridSlots;
  const geometry = useMemo(() => resolvePageableGeometry({ description, facts, body, headerRight, preview, place }),
    [description, facts, body, headerRight, preview, place, resolvePageableGeometry]);
  const paged = geometry.paged === true;
  // A paged row holds its whole group; the keyboard walks it with ← and →.
  const rowColumns = paged ? Math.max(1, longestGroup) : geometry.columns;
  // Each grid row's own bands (R-APP-10, R-APP-14): cards in a row share its tallest card's height, and a
  // row where no card has a description or footer content drops that band (all compact tiles).
  // A compact tile starts its own row rather than stretching beside described cards (R-APP-14); the
  // keyboard walks the same rows.
  const gridRows = useMemo(() => resolveHappierCollectionGridRows({
    sections: model.sections.map((section) => section.items),
    columns: rowColumns,
    compact: (item) => {
      const slots = readGridSlots([item], anatomy);
      return !slots.description && !slots.facts && !slots.body && !slots.headerRight && !slots.preview;
    },
  }), [anatomy, rowColumns, model.sections]);
  const rowGeometries = useMemo(() => gridRows.map((rows) => rows.map((row) => {
    const slots = readGridSlots(row, anatomy);
    return slots.description === gridSlots.description && slots.facts === gridSlots.facts && slots.headerRight === gridSlots.headerRight
      && slots.place === gridSlots.place ? geometry : resolvePageableGeometry(slots);
  })), [anatomy, geometry, gridRows, gridSlots, resolvePageableGeometry]);
  const keyOf = model.keyOf;
  const gridRowKeys = useMemo(() => gridRows.flatMap((rows) => rows.map((row) => row.map(keyOf))), [gridRows, keyOf]);
  const keys = useMemo(() => model.sections.flatMap((section) => section.items.map(keyOf)), [keyOf, model.sections]);
  const rowIndices = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  // The last known card count, which the skeleton holds while the items are arriving again.
  const lastKnownCount = useRef(0);
  if (keys.length > 0) lastKnownCount.current = keys.length;

  const tabStopKey = props.tabStopKey;
  const targets = useRef(new Map<string, HappierFocusable>());
  const physicalRequest = useRowFocusRequest();
  const register = useCallback((key: string, target: HappierFocusable | null) => {
    if (target === null) targets.current.delete(key);
    else { targets.current.set(key, target); physicalRequest.consume(key, target); }
  }, [physicalRequest]);
  const authorFocus = props.onFocusedKeyChange;
  const single = props.selection?.single;
  const singleRef = useRef(single);
  singleRef.current = single;
  const openRow = model.actions.open;
  const chooseOrOpen = useCallback((key: string) => {
    const choice = singleRef.current;
    if (choice === undefined) openRow(key);
    else if (choice.value !== key) choice.onValueChange(key);
  }, [openRow]);
  const onFocus = useCallback((key: string) => {
    physicalRequest.abandon();
    authorFocus(key);
  }, [authorFocus, physicalRequest]);
  const navigationInput = {
    navigate: model.actions.navigate, presentation: 'grid' as const, columns: rowColumns, gridRows: gridRowKeys,
    store: props.selection?.multiple?.store, eligibleKeys: props.eligibleKeys,
    ...(single === undefined ? {} : { onValueChange: chooseOrOpen }),
  };
  const navigation = useRef(navigationInput);
  navigation.current = navigationInput;
  const onKey = useCallback((key: string, from: string, event: unknown): boolean => {
    const { navigate, ...input } = navigation.current;
    return navigate({ ...input, key, from, event });
  }, []);
  const focusRequest = props.focusRequest ?? model.focusRequest;
  // A grid that scrolls with its page draws only the lines near the page's window (a library of hundreds of cards
  // mounts what is on screen, not every card). A paging shelf is one line: it has nothing to window.
  const pageTracker = useOptionalPluginUiScrollActivityTracker();
  const windowTracker = props.pageScroll === true && !paged ? pageTracker : null;
  useEffect(() => {
    if (focusRequest === null) return;
    if (!keys.includes(focusRequest.key)) return;
    physicalRequest.claim(focusRequest.key);
    const target = targets.current.get(focusRequest.key);
    if (target !== undefined) physicalRequest.consume(focusRequest.key, target);
    model.actions.consumeFocusRequest(focusRequest);
    // The physical adapter retains an unmounted target request until that target registers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, physicalRequest]);

  if (props.loading === true && keys.length === 0) {
    // The last known count, else the rows the caller knows are coming, else as many rows as fill what is on
    // screen (the table's skeleton rule).
    const rowsOnScreen = props.loadingRows !== undefined
      ? Math.max(1, props.loadingRows)
      : props.height === null || props.height === undefined
        ? 1
        : Math.max(1, Math.ceil(props.height / (geometry.cardHeight + CARD_GAP)));
    const count = lastKnownCount.current > 0 ? lastKnownCount.current : geometry.columns * rowsOnScreen;
    // A paging shelf reserves its one row, the next card's edge showing as it will.
    const perRow = paged ? count : geometry.columns;
    const rows: number[][] = [];
    for (let index = 0; index < count; index += 1) {
      if (index % perRow === 0) rows.push([]);
      rows[rows.length - 1]!.push(index);
    }
    return (
      <GridScroller singleChoice={single !== undefined} pageScroll={props.pageScroll === true} viewport={viewport} request={scrollRequest} accessibilityLabel={props.accessibilityLabel}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={paged ? [gridRowStyle, pagedSkeletonRowStyle] : gridRowStyle}>
            {row.map((index) => (
              <HappierSkeletonBlock
                key={index}
                color={palette.skeleton ?? theme.colors.control}
                width={geometry.cardWidth}
                height={geometry.cardHeight}
                radius={RADIUS}
                {...(props.testID === undefined ? {} : { testID: `${props.testID}:skeleton-card` })}
              />
            ))}
          </View>
        ))}
      </GridScroller>
    );
  }
  if (keys.length === 0 && props.empty !== undefined) return <View style={props.pageScroll === true ? null : fillStyle}>{props.empty}</View>;

  const selectedKey = props.selectedKey;
  return (
    <GridScroller singleChoice={single !== undefined} pageScroll={props.pageScroll === true} viewport={viewport} request={scrollRequest} accessibilityLabel={props.accessibilityLabel}>
      {inner === null ? null : model.sections.map((section, sectionIndex) => {
        const group = section.group;
        const shelf = group !== null && group.title !== '';
        const rows = gridRows[sectionIndex] ?? [];
        const renderCard = (row: readonly Item[], rowIndex: number, item: Item, itemIndex: number, onHeight?: (key: string, height: number) => void): ReactElement => {
          const key = keyOf(item);
          const rowGeometry = rowGeometries[sectionIndex]?.[rowIndex] ?? geometry;
          return (
            <GridCard
              key={key}
              item={item}
              itemKey={key}
              anatomy={anatomy}
              geometry={rowGeometry}
              count={keys.length}
              activatable={props.selection?.isItemActivatable?.(item) !== false && single?.isItemSelectable?.(item) !== false}
              selectable={props.selection?.multiple !== undefined && props.selection.multiple.isItemSelectable?.(item) !== false}
              multipleStore={props.selection?.multiple?.store ?? null}
              singleChoice={single !== undefined}
              unavailableReason={single?.unavailableReason?.(item)}
              useRowActions={props.useRowActions}
              useRowItem={props.useRowItem}
              rowIndex={rowIndices.get(key)!}
              rowEndSpace={!paged && itemIndex === row.length - 1 ? (geometry.columns - row.length) * (geometry.cardWidth + CARD_GAP) : 0}
              selected={key === selectedKey}
              tabStop={key === tabStopKey}
              onOpen={chooseOrOpen}
              onFocus={onFocus}
              onKey={onKey}
              register={register}
              {...(onHeight === undefined || !rowGeometry.fitContent ? {} : { onHeight })}
            />
          );
        };
        return (
          <View
            key={group?.key ?? `collection-${sectionIndex}`}
            role={shelf ? 'group' : undefined}
            aria-label={shelf ? group.title : undefined}
            style={shelfStyle}
            {...(props.testID === undefined || !shelf ? {} : { testID: `${props.testID}:shelf:${group.key}` })}
          >
            {!shelf ? null : (
              <View style={card.shelfHeaderStyle}>
                <View style={shrinkStyle}>
                  <HappierText variant="label" tone="neutral" numberOfLines={1} style={titleStyle}>{group.title}</HappierText>
                  {group.description === undefined ? null : (
                    <HappierText variant="meta" tone="muted" numberOfLines={1}>{group.description}</HappierText>
                  )}
                </View>
                <CollectionGroupActionButton
                  action={props.groupAction?.(group.key) ?? null}
                  groupKey={group.key}
                  groupTitle={group.title}
                  {...(props.testID === undefined ? {} : { testID: props.testID })}
                />
              </View>
            )}
            {windowTracker !== null ? (
              <PageWindowedGridRow
                tracker={windowTracker}
                rows={rows}
                keyOf={keyOf}
                cardWidth={geometry.cardWidth}
                estimate={(rowIndex) => (rowGeometries[sectionIndex]?.[rowIndex] ?? geometry).cardHeight}
                pinnedKeys={[tabStopKey, selectedKey, focusRequest?.key ?? null]}
                revealKey={focusRequest?.key ?? null}
                renderCard={(item, rowIndex, itemIndex, onHeight) => renderCard(rows[rowIndex]!, rowIndex, item, itemIndex, onHeight)}
                {...(props.testID === undefined ? {} : { testID: `${props.testID}:grid-row` })}
              />
            ) : (
            <GridRow paged={paged} snapInterval={geometry.cardWidth + CARD_GAP}
              {...(props.testID === undefined ? {} : { testID: `${props.testID}:grid-row` })}>
            {rows.flatMap((row, rowIndex) => row.map((item, itemIndex) => renderCard(row, rowIndex, item, itemIndex)))}
            </GridRow>
            )}
          </View>
        );
      })}
    </GridScroller>
  );
}

const NO_HEIGHTS: ReadonlyMap<string, number> = new Map();

/**
 * A group's cards wrapped into the grid's columns, drawn only where its lines are near the page's window (the page
 * List's rule, `usePageWindow`): each run of far lines stands as one spacer of their exact height, so the page keeps
 * its length and scroll position. Every drawn card stays a child of this one row, so a re-flow (a pane opening beside
 * the grid) moves cards without remounting them. The open card, the tab stop and a focus target stay drawn wherever
 * they are; a focus target out of the window is scrolled to.
 */
function PageWindowedGridRow<Item>(props: Readonly<{
  tracker: PluginUiScrollActivityTracker;
  rows: readonly (readonly Item[])[];
  keyOf: (item: Item) => string;
  /** The current card width: a content-sized card's measured height belongs to it. */
  cardWidth: number;
  /** A line's height before its cards are drawn: the grid's exact card geometry. */
  estimate: (rowIndex: number) => number;
  pinnedKeys: readonly (string | null)[];
  revealKey: string | null;
  renderCard: (item: Item, rowIndex: number, itemIndex: number, onHeight: (key: string, height: number) => void) => ReactElement;
  testID?: string;
}>): ReactElement {
  const { rows, keyOf, estimate, cardWidth, tracker } = props;
  const { root, span, window, measure, near: nearPage } = usePageWindow(tracker);
  const [measured, setMeasured] = useState<Readonly<{ cardWidth: number; heights: ReadonlyMap<string, number> }>>(
    () => ({ cardWidth, heights: NO_HEIGHTS }),
  );
  const heights = measured.cardWidth === cardWidth ? measured.heights : NO_HEIGHTS;
  const onHeight = useCallback((key: string, height: number) => {
    setMeasured(current => {
      const base = current.cardWidth === cardWidth ? current.heights : NO_HEIGHTS;
      if (height <= 0 || base.get(key) === height) return current;
      return { cardWidth, heights: new Map(base).set(key, height) };
    });
  }, [cardWidth]);
  const lines = useMemo(() => {
    let offset = 0;
    return rows.map((row, rowIndex) => {
      const height = Math.max(...row.map(item => heights.get(keyOf(item)) ?? estimate(rowIndex)));
      const line = { offset, height };
      offset += height + CARD_GAP;
      return line;
    });
    // `estimate` is a new closure each render; the geometry it reads arrives through `rows` and `cardWidth`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, heights, keyOf, cardWidth]);
  const near = (line: Readonly<{ offset: number; height: number }>) => nearPage(line.offset, line.height);
  const lineOf = (key: string | null) => key === null ? -1 : rows.findIndex(row => row.some(item => keyOf(item) === key));
  const pinnedLines = new Set(props.pinnedKeys.map(lineOf).filter(index => index >= 0));
  const revealLine = lineOf(props.revealKey);
  useLayoutEffect(() => {
    const line = lines[revealLine];
    if (line === undefined || span === null || window === null || near(line)) return;
    tracker.scrollToOffset?.(Math.max(0, span.top + line.offset));
    // Only a new focus target asks for the page to move; scrolling never re-reveals it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.revealKey, span !== null]);

  const content: ReactNode[] = [];
  let skipFrom = -1;
  const flush = (end: number) => {
    if (skipFrom < 0) return;
    const first = lines[skipFrom]!;
    const last = lines[end - 1]!;
    content.push(
      <View key={`gap:${keyOf(rows[skipFrom]![0]!)}`} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ width: '100%', height: last.offset + last.height - first.offset }} />,
    );
    skipFrom = -1;
  };
  rows.forEach((row, rowIndex) => {
    if (near(lines[rowIndex]!) || pinnedLines.has(rowIndex)) {
      flush(rowIndex);
      row.forEach((item, itemIndex) => content.push(props.renderCard(item, rowIndex, itemIndex, onHeight)));
    } else if (skipFrom < 0) skipFrom = rowIndex;
  });
  flush(rows.length);
  return (
    <View ref={root} onLayout={() => { void measure(); }} style={[gridRowStyle, GRID_ROW_WRAP_STYLE]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}>
      {content}
    </View>
  );
}

/**
 * A group's cards: wrapped into the grid's columns, or, on a paging shelf, one row that scrolls sideways and
 * settles on a card's start. The row runs out to the page edge so the next card's edge shows; the web pages by
 * each card's snap point, native by the card interval.
 */
function GridRow(props: Readonly<{ paged: boolean; snapInterval: number; testID?: string; children?: ReactNode }>): ReactElement {
  if (!props.paged) {
    // On the web each wrapped line stretches its cards to the tallest (lab nav-N3, QA-DESIGN-R2 G1). Native keeps
    // `flex-start`: Yoga's wrapped-row erratum stretches a growing child to the whole grid's height.
    return <View style={[gridRowStyle, GRID_ROW_WRAP_STYLE]} {...(props.testID === undefined ? {} : { testID: props.testID })}>{props.children}</View>;
  }
  return (
    <ScrollView horizontal pagingEnabled snapToInterval={props.snapInterval} snapToAlignment="start"
      decelerationRate="fast" showsHorizontalScrollIndicator={false}
      style={pagedRowStyle} contentContainerStyle={[gridRowStyle, pagedRowContentStyle]}
      {...(props.testID === undefined ? {} : { testID: props.testID })}>
      {props.children}
    </ScrollView>
  );
}

/** The grid's own scroller, or, where the grid scrolls with its page, just its content box. */
function GridScroller(props: Readonly<{ singleChoice?: boolean; pageScroll: boolean; viewport: HappierCollectionViewport; request: Readonly<{ offset: number }>; accessibilityLabel: string; children?: ReactNode }>): ReactElement {
  const scroll = useRef<ScrollView | null>(null);
  useLayoutEffect(() => {
    if (!props.pageScroll) scroll.current?.scrollTo({ y: props.request.offset, animated: false });
  }, [props.pageScroll, props.request]);
  const content = <View role={props.singleChoice ? 'radiogroup' : 'grid'} accessibilityLabel={props.accessibilityLabel} style={gridContentStyle}>{props.children}</View>;
  return props.pageScroll ? content
    : <ScrollView ref={scroll} style={fillStyle} scrollEventThrottle={16}
        onScroll={event => { props.viewport.offsetRef.current = event.nativeEvent.contentOffset.y; }}>{content}</ScrollView>;
}

/** A group header's one action ("See all"), named with its group for assistive technology. */
/** A group link's onward caret: the same step "All jobs ›" and every destination title action draw. */
const GROUP_LINK_CHEVRON_PX = 14;
const groupLinkStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 4 };

export function CollectionGroupActionButton(props: Readonly<{
  action: CollectionGroupAction | null;
  groupKey: string;
  groupTitle: string;
  testID?: string;
}>): ReactElement | null {
  const theme = useHappierUiTheme();
  const action = props.action;
  if (action === null) return null;
  if (action.kind === 'operation') {
    return (
      <Button
        variant="secondary"
        size="small"
        title={action.label}
        accessibilityLabel={`${action.label}, ${props.groupTitle}`}
        onPress={action.onPress}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:group:${props.groupKey}:action` })}
      />
    );
  }
  return (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={`${action.label}, ${props.groupTitle}`}
      onPress={action.onPress}
      {...(props.testID === undefined ? {} : { testID: `${props.testID}:group:${props.groupKey}:action` })}
      style={(state) => ({ opacity: state.pressed ? 0.6 : 1 })}
    >
      <View style={groupLinkStyle}>
        <HappierText variant="meta" tone="secondary">{action.label}</HappierText>
        <HappierChevron direction="right" color={theme.colors.secondaryText} size={GROUP_LINK_CHEVRON_PX} />
      </View>
    </HappierPressable>
  );
}


export function CollectionCards<Item>(props: CollectionCardsProps<Item>): ReactElement {
  return props.presentation === 'board' ? <View role={props.selection?.single === undefined ? undefined : 'radiogroup'}
    accessibilityLabel={props.selection?.single === undefined ? undefined : props.accessibilityLabel} style={fillStyle}>
    <CollectionBoard {...props} />
  </View> : <CollectionGrid {...props} />;
}

type RevealTarget = Readonly<{ scrollIntoView?: (options: Readonly<{ block: 'nearest' }>) => void }>;

function revealNearest(node: unknown): void {
  (node as RevealTarget | null)?.scrollIntoView?.({ block: 'nearest' });
}

const fillStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0 };
const shrinkStyle: HappierPortableStyle = { flex: 1, minWidth: 0, flexShrink: 1 };
const lineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', minWidth: 0 };
const titleStyle: HappierPortableStyle = { fontWeight: '600' };
const ringStyle: HappierPortableStyle = {
  position: 'absolute',
  top: -1,
  left: -1,
  right: -1,
  bottom: -1,
  borderWidth: 2,
  borderRadius: RADIUS + 1,
};
const boardRowStyle: HappierPortableStyle = { flex: 1, flexDirection: 'row', minWidth: 0, minHeight: 0 };
const boardRowScrollStyle: HappierPortableStyle = { flexGrow: 1, flexDirection: 'row' };
const boardCardStyle: HappierPortableStyle = { borderWidth: 1, borderRadius: RADIUS, overflow: 'visible' };
const gridContentStyle: HappierPortableStyle = { padding: GUTTER, gap: HAPPIER_PAGE_METRICS.sectionGapPx };
const shelfStyle: HappierPortableStyle = { gap: GUTTER };
const shelfHeaderStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: HAPPIER_PAGE_METRICS.headingOpticalInsetPx };
// Row peers start on one edge. A card taller than its track (a body has no clipping cap) must not centre its shorter
// neighbours' frames, which sit inside rows that centre their content, or leave their selection ring around empty room.
const gridRowStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'flex-start', gap: CARD_GAP };// A paging shelf runs out through the grid's end gutter to the page edge, its last card ending on the gutter.
const pagedRowStyle: HappierPortableStyle = { marginRight: -GUTTER, flexGrow: 0 };
const pagedRowContentStyle: HappierPortableStyle = { paddingRight: GUTTER };
const pagedSkeletonRowStyle: HappierPortableStyle = { overflow: 'hidden', marginRight: -GUTTER };
const gridCardStyle: HappierPortableStyle = { borderRadius: RADIUS };
const GRID_CARD_ITEM_STYLE = Platform.OS === 'web'
  ? { padding: 0, borderRadius: RADIUS - 1, height: '100%' } as const : { padding: 0, borderRadius: RADIUS - 1 } as const;
const GRID_ROW_WRAP_STYLE: HappierPortableStyle = Platform.OS === 'web' ? { flexWrap: 'wrap', alignItems: 'stretch' } : { flexWrap: 'wrap' };
const CELL_FILL_STYLE: HappierPortableStyle = { height: '100%' };
// Inside the row layer's ring and the frame's 1 px edge, so the band reads as the card's top and the edge runs
// around it (its corners are `RADIUS - 2`, concentric with the frame).
const PREVIEW_INSET = CARD.rowLayerEdge / 2 + 1;
const gridPreviewStyle: HappierPortableStyle = {
  position: 'absolute',
  left: PREVIEW_INSET,
  right: PREVIEW_INSET,
  top: PREVIEW_INSET,
  overflow: 'hidden',
  borderBottomWidth: 1,
};
