import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

import {
  resolveHappierUiPalette,
  useHappierUiAccessibility,
  useHappierUiTheme,
  useOptionalHappierUiPalette,
  useOptionalHappierUiTypography,
} from '../environment/context.js';
import type { HappierTypeRole } from '../environment/types.js';
import type { HappierCollectionKey, HappierCollectionSection } from '../presentation/collection/collectionModel.js';
import { resolveHappierCollectionGridGeometry } from '../presentation/collection/collectionTable.js';
import { useHappierCollectionViewport, type HappierCollectionModel, type HappierCollectionViewport } from '../presentation/collection/useCollection.js';
import { HappierSkeletonBlock } from '../presentation/feedback/Skeleton.js';
import { HappierSegmentedChoice } from '../presentation/form/SegmentedChoice.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import type { HappierFocusable, HappierPortableStyle, HappierStyleProp } from '../presentation/portableTypes.js';
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

/** Card geometry at normal text size. Gutters and the card's radius come from the page metrics owner. */
const CARD = Object.freeze({
  padding: 14,
  markSize: 32,
  gap: 10,
  footerHeight: 28,
  /** The preview band's height: about seven preview lines, enough to recognise the item at a glance. */
  previewHeight: 128,
  // Compact tracks still leave room for the mark, a readable title and the card insets.
  boardColumnMinWidth: 160,
  boardCardInsetX: 10,
  boardCardInsetY: 4,
  /** The default narrowest grid card; one column at a 390 pt phone. */
  gridMinCardWidth: 280,
});
const GUTTER = HAPPIER_PAGE_METRICS.sheetInsetPx;
const RADIUS = HAPPIER_PAGE_METRICS.sheetRadiusPx;

export type CollectionCardsProps<Item> = Readonly<{
  presentation: 'board' | 'grid';
  selection?: CollectionProps<Item>['selection'];
  useRowActions?: CollectionProps<Item>['useRowActions'];
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
  /** The grid's narrowest card. */
  minCardWidth?: number;
  /** A shelf's one header action, by group key. */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
  /** Items are still arriving: the grid holds its geometry with skeleton cards. */
  loading?: boolean;
  empty?: ReactNode;
  /** The grid scrolls with the page around it (the Collection's `scroll="page"`): it draws no scroller of its own. */
  pageScroll?: boolean;
  testID?: string;
}>;

type CardText = Readonly<{ title: number; meta: number; label: number }>;

function useCardText(): CardText {
  const theme = useHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const { textScale } = useHappierUiAccessibility();
  return useMemo(() => ({
    // The host's row anatomy on a card: the row title role over the row meta role.
    title: readCollectionLineHeight('label', theme, typography, textScale),
    meta: readCollectionLineHeight('body', theme, typography, textScale),
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
      <HappierText variant="body" tone={props.tone ?? 'secondary'} numberOfLines={1} tabularNumbers style={shrinkStyle}>
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

function BoardCard<Item>(props: Readonly<{ item: Item; anatomy: CollectionAnatomy<Item>; selected: boolean }>): ReactElement {
  const { item, anatomy } = props;
  const { theme, palette } = useCardColors();
  const where = anatomy.where?.(item);
  const age = anatomy.age?.(item) ?? null;
  const reason = anatomy.reason?.(item);
  const signal = anatomy.signal?.(item);
  const agent = anatomy.agent?.(item);
  const hasFacts = (reason !== null && reason !== undefined) || (signal !== null && signal !== undefined);
  const hasAgent = agent !== null && agent !== undefined;
  if (anatomy.boardContent) return <View>{anatomy.boardContent(item)}{props.selected ? <SelectedRing color={palette.selection} /> : null}</View>;
  return (
    <View style={[boardCardStyle, { backgroundColor: palette.sheet, borderColor: palette.sheetBorder }]}>
      <View style={boardCardBodyStyle}>
        <View style={lineStyle}>
          <View style={markStyle}>{anatomy.glyph(item)}</View>
          <HappierText variant="label" tone="neutral" numberOfLines={2} style={[titleStyle, shrinkStyle]}>{anatomy.title(item)}</HappierText>
        </View>
        {where === undefined && age === null ? null : (
          <View style={lineStyle}>
            <View style={[lineStyle, shrinkStyle]}><Slot value={where} /></View>
            {age === null ? null : <HappierText variant="caption" tone="muted" numberOfLines={1} tabularNumbers>{age}</HappierText>}
          </View>
        )}
        {!hasFacts ? null : (
          <View style={[lineStyle, { flexWrap: 'wrap' }]}>
            <Slot value={reason} />
            <Slot value={signal} />
          </View>
        )}
      </View>
      {!hasAgent ? null : (
        <View style={[agentStripStyle, { borderTopColor: theme.colors.divider }]}>
          <Slot value={agent} />
        </View>
      )}
      {props.selected ? <SelectedRing color={palette.selection} /> : null}
    </View>
  );
}

function BoardCardRow<Item>(props: Readonly<{
  item: Item;
  anatomy: CollectionAnatomy<Item>;
  selected: boolean;
  useRowActions?: CollectionProps<Item>['useRowActions'];
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const { item, anatomy } = props;
  const actions = props.useRowActions?.(item) ?? {};
  const row: ReactElement<ItemProps> = <List.Item
    {...actions} density="compact" showDivider={false} accessoryOutsidePressable
    accessibilityLabel={anatomy.accessibilityLabel(item)}
    accessibilityHint={anatomy.accessibilityHint?.(item)}
    testID={anatomy.testID?.(item)} style={boardItemStyle}
  ><BoardCard item={item} anatomy={anatomy} selected={props.selected} /></List.Item>;
  return <>{renderCollectionItemDestination(host, anatomy, item, row)}</>;
}

function BoardColumn<Item>(props: Readonly<{
  section: HappierCollectionSection<Item>;
  selection?: CollectionProps<Item>['selection'];
  useRowActions?: CollectionProps<Item>['useRowActions'];
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
  const translate = usePluginTranslation();
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
    selected={keyOf(item) === selected} useRowActions={props.useRowActions} />, [anatomy, keyOf, props.useRowActions, selected]);
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
  return (
    <View style={props.style} testID={props.testID}>
      {!props.showHeader || group === null || group.title === '' ? null : (
        <View style={columnHeaderStyle}>
          <View style={lineStyle}>
            <HappierText variant="label" tone={HAPPIER_WORK_STATUS_SEMANTIC_TONE[section.items.length > 0 ? group.tone ?? 'neutral' : 'neutral']} style={[titleStyle, { flexShrink: 1 }]}>{group.title}</HappierText>
            <HappierText variant="caption" tone="muted" tabularNumbers>{String(section.items.length)}</HappierText>
          </View>
          {group.description === undefined ? null : (
            <HappierText variant="caption" tone="muted" numberOfLines={2}>{group.description}</HappierText>
          )}
        </View>
      )}
      {section.items.length === 0 ? (
        <HappierText variant="caption" tone="muted" style={{ paddingHorizontal: CARD.boardCardInsetX }}>
          {translate('happier.plugin-ui.collection.board.empty', 'None')}
        </HappierText>
      ) : null}
      <View style={props.pageScroll ? undefined : fillStyle}>
        <ListCollectionControlContext.Provider value={control}>
          <List<Item>
            accessibilityLabel={props.label}
            accessibilityPattern="grid"
            density="compact"
            contentContainerStyle={boardListContentStyle}
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
    </View>
  );
}

function CollectionBoard<Item>(props: CollectionCardsProps<Item>): ReactElement {
  const { model } = props;
  const { theme, palette } = useCardColors();
  const translate = usePluginTranslation();
  const { textScale } = useHappierUiAccessibility();
  const sections = model.sections;
  const narrow = props.boardLayout === undefined && props.narrow;
  const stacked = props.boardLayout === 'stacked';
  const boardViewport = model.viewport('board');
  const stackedScroll = useRef<ScrollView | null>(null);
  const horizontalScroll = useRef<ScrollView | null>(null);
  const minColumn = CARD.boardColumnMinWidth * textScale;
  // Empty and populated buckets keep the same track; arrivals never resize their neighbours.
  const availableWidth = props.width === null ? null : Math.max(0, props.width - 2 * (GUTTER - CARD.boardCardInsetX));
  const fits = availableWidth === null || sections.length * minColumn <= availableWidth;
  const columnWidth = availableWidth === null ? null : Math.max(minColumn, availableWidth / Math.max(1, sections.length));
  useLayoutEffect(() => {
    horizontalScroll.current?.scrollTo({ x: boardViewport.horizontalOffsetRef.current, animated: false });
    stackedScroll.current?.scrollTo({ y: boardViewport.offsetRef.current, animated: false });
  }, [boardViewport, fits, narrow, stacked]);
  const columnKeys = useMemo(() => sections.map((section, index) => section.group?.key ?? `collection-${index}`), [sections]);
  const page = model.boardColumnKey;
  const pageKey = page !== null && columnKeys.includes(page) ? page : columnKeys[0] ?? null;
  const focusRequest = props.focusRequest ?? model.focusRequest;
  useEffect(() => {
    if (focusRequest === null) return;
    const column = sections.findIndex(section => section.items.some(item => model.keyOf(item) === focusRequest.key));
    const key = columnKeys[column];
    if (key !== undefined) model.actions.showColumn(key);
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

  if (stacked) return <ScrollView ref={stackedScroll} style={fillStyle} contentContainerStyle={{ gap: CARD.gap,
    paddingVertical: CARD.padding, paddingHorizontal: GUTTER - CARD.boardCardInsetX }}
    scrollEventThrottle={16} onScroll={event => { boardViewport.offsetRef.current = event.nativeEvent.contentOffset.y; }}>
    {sections.map((section, index) => columnFor(section, index, {}, true))}
  </ScrollView>;

  if (narrow) {
    // A phone pages the columns: one column at a time, chosen by name and count.
    const index = pageKey === null ? -1 : columnKeys.indexOf(pageKey);
    const section = index < 0 ? undefined : sections[index];
    return (
      <View style={fillStyle}>
        {sections.length < 2 ? null : (
          <View style={pagerStyle}>
            <HappierSegmentedChoice
              accessibilityLabel={translate('happier.plugin-ui.collection.board.columns', 'Columns')}
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
    <View style={boardRowStyle}>{columns}</View>
  ) : (
    <ScrollView ref={horizontalScroll} horizontal style={fillStyle} contentContainerStyle={boardRowScrollStyle} scrollEventThrottle={16}
      onScroll={event => { boardViewport.horizontalOffsetRef.current = event.nativeEvent.contentOffset.x; }}>{columns}</ScrollView>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------------------------------------------

type GridGeometry = Readonly<{
  columns: number;
  cardWidth: number;
  cardHeight: number;
  /** Zero when no card in the grid has a description: the grid keeps no empty lines. */
  descriptionHeight: number;
  /** False when no card in the grid has a status or an action: the grid keeps no empty footer. */
  footer: boolean;
  /** Zero when the anatomy draws no preview band. */
  previewHeight: number;
}>;

/** Which of a card's optional slots this grid keeps: those at least one of its cards fills (every card keeps them). */
type GridSlots = Readonly<{ description: boolean; footer: boolean; preview: boolean }>;

function present(value: ReactNode): boolean {
  return value !== null && value !== undefined && value !== false;
}

function useGridSlots<Item>(model: HappierCollectionModel<Item>, anatomy: CollectionAnatomy<Item>): GridSlots {
  return useMemo(() => {
    const items = model.sections.flatMap((section) => section.items);
    if (items.length === 0) {
      // Nothing to read yet (loading): hold the anatomy's declared shape, so the skeleton matches what arrives.
      return {
        description: anatomy.description !== undefined,
        footer: anatomy.reason !== undefined || anatomy.action !== undefined,
        preview: anatomy.preview !== undefined,
      };
    }
    let description = false;
    let footer = false;
    for (const item of items) {
      if (!description && (anatomy.description?.(item) ?? null) !== null) description = true;
      if (!footer && (present(anatomy.reason?.(item)) || present(anatomy.action?.(item)))) footer = true;
      if (description && footer) break;
    }
    return { description, footer, preview: anatomy.preview !== undefined };
  }, [anatomy, model.sections]);
}

function useGridGeometry(width: number | null, minCardWidth: number, slots: GridSlots): GridGeometry {
  const text = useCardText();
  const { textScale } = useHappierUiAccessibility();
  return useMemo(() => {
    const inner = Math.max(0, (width ?? 0) - 2 * GUTTER);
    const { columns, cardWidth } = resolveHappierCollectionGridGeometry({ width: inner, minCardWidth: minCardWidth * textScale, gap: GUTTER });
    const descriptionHeight = slots.description ? 2 * text.meta : 0;
    // Exact per text size, never measured per card: every card is the same height, so rows are equal and footers align.
    const head = Math.max(CARD.markSize, text.title + text.meta);
    const previewHeight = slots.preview ? CARD.previewHeight : 0;
    const cardHeight = 2 + 2 * CARD.padding + head + previewHeight
      + (slots.description ? CARD.gap + descriptionHeight : 0)
      + (slots.footer ? CARD.gap + CARD.footerHeight : 0);
    return { columns, cardWidth, cardHeight, descriptionHeight, footer: slots.footer, previewHeight };
  }, [minCardWidth, slots, text, textScale, width]);
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
  rowIndex: number;
  register: (key: string, target: HappierFocusable | null) => void;
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const { item, itemKey, anatomy, geometry } = props;
  const { theme, palette } = useCardColors();
  const testID = anatomy.testID?.(item);
  const where = anatomy.where?.(item);
  const description = anatomy.description?.(item) ?? null;
  const status = anatomy.reason?.(item);
  const action = anatomy.action?.(item);
  const hasAction = action !== null && action !== undefined && action !== false;
  const register = props.register;
  const onKey = props.onKey;
  const onFocus = props.onFocus;
  const multi = useListMultiSelectionRow(itemKey);
  const actions = props.useRowActions?.(item) ?? {};
  const { activatable, selectable } = props;
  const select = (event?: import('../presentation/portableTypes.js').HappierGestureResponderEvent): 'handled' | 'open' => {
    if (props.singleChoice) {
      onFocus(itemKey);
      props.onOpen(itemKey);
      return 'handled';
    }
    return activateListItem({ key: itemKey, event, store: props.multipleStore,
      focus: onFocus, open: props.onOpen });
  };
  const row: ReactElement<ItemProps> = (
    <List.Item {...actions} showDivider={false} density="compact" accessoryOutsidePressable
      accessibilityLabel={anatomy.accessibilityLabel(item)} accessibilityHint={anatomy.accessibilityHint?.(item)}
      testID={testID} style={{ flex: 1, padding: CARD.padding,
        ...(geometry.previewHeight === 0 ? {} : { paddingTop: geometry.previewHeight + CARD.padding }), borderRadius: RADIUS - 1 }}
    >
      <View style={{ flex: 1, gap: CARD.gap }}>

        <View style={[lineStyle, { alignItems: 'flex-start' }]}>
          <View style={[markStyle, { width: CARD.markSize, height: CARD.markSize }]}>{anatomy.glyph(item)}</View>
          <View style={shrinkStyle}>
            <HappierText variant="label" tone="neutral" numberOfLines={1} style={titleStyle}>{anatomy.title(item)}</HappierText>
            <Slot value={where} />
          </View>
        </View>
        {geometry.descriptionHeight === 0 ? null : (
        <View style={{ height: geometry.descriptionHeight }}>
          {description === null ? null : (
            <HappierText
              variant="body"
              tone="secondary"
              numberOfLines={2}
              {...(testID === undefined ? {} : { testID: `${testID}:description` })}
            >
              {description}
            </HappierText>
          )}
        </View>
        )}
        {/* Keep the footer's place in the body's target; its two columns are composed beside that target below. */}
        {!geometry.footer ? null : (
          <View style={{ height: CARD.footerHeight }} />
        )}
      </View>
    </List.Item>
  );
  const card = (
    <View
      style={[gridCardStyle, { width: geometry.cardWidth, height: geometry.cardHeight, backgroundColor: palette.sheet, borderColor: palette.sheetBorder }]}
      testID={testID === undefined ? undefined : `${testID}:card`}
    >
      <ListItemSelectionContext.Provider value={{
        itemKey, multiSelectable: selectable, selected: props.multipleStore !== null ? multi.isSelected : props.selected,
        activatable, select, positionInSet: props.rowIndex + 1, setSize: props.count,
        roving: { isTabStop: props.tabStop, register: target => register(itemKey, target),
          onFocus: () => onFocus(itemKey),
          onKeyDown: (key, event) => onKey(key, itemKey, event) },
        accessibilityPattern: props.singleChoice ? 'radiogroup' : 'grid', unavailableReason: props.unavailableReason,
        rowIndex: props.rowIndex, rowCount: props.count,
      }}>
        {renderCollectionItemDestination(host, anatomy, item, row)}
      </ListItemSelectionContext.Provider>
      {geometry.previewHeight === 0 ? null : (
        // Anchor the edge-to-edge band to the card, not the padded metadata inside List.Item.
        <View
          pointerEvents="none"
          style={[gridPreviewStyle, {
            height: geometry.previewHeight,
            borderTopLeftRadius: RADIUS - 2,
            borderTopRightRadius: RADIUS - 2,
            backgroundColor: palette.fieldBackground,
            borderBottomColor: palette.sheetBorder,
          }]}
          {...(testID === undefined ? {} : { testID: `${testID}:preview` })}
        >
          {anatomy.preview?.(item)}
        </View>
      )}
      {!geometry.footer ? null : (
        // The action has its own target beside the body's, never inside it. Both columns share the available
        // width: a long status shrinks before the action, rather than running underneath an overlaid control.
        <View pointerEvents="box-none" style={gridFooterStyle}>
          <View pointerEvents="none" style={[shrinkStyle, { justifyContent: 'center' }]}><Slot value={status} /></View>
          {!hasAction ? null : <View style={gridActionStyle}>{action}</View>}
        </View>
      )}
      {props.selected ? <SelectedRing color={palette.selection} {...(testID === undefined ? {} : { testID: `${testID}:selected` })} /> : null}
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
  const { theme } = useCardColors();
  const { viewport, scrollRequest } = useHappierCollectionViewport(model, 'grid');
  const geometry = useGridGeometry(props.width, props.minCardWidth ?? CARD.gridMinCardWidth, useGridSlots(model, anatomy));
  const keyOf = model.keyOf;
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
  const onKey = useCallback((key: string, from: string, event: unknown): boolean => model.actions.navigate({
    key, from, event, presentation: 'grid', columns: geometry.columns,
    store: props.selection?.multiple?.store, eligibleKeys: props.eligibleKeys,
    ...(single === undefined ? {} : { onValueChange: chooseOrOpen }),
  }), [chooseOrOpen, geometry.columns, model.actions, props.eligibleKeys, props.selection?.multiple?.store, single === undefined]);
  const focusRequest = props.focusRequest ?? model.focusRequest;
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

  const inner = props.width === null ? null : props.width - 2 * GUTTER;
  if (props.loading === true && keys.length === 0) {
    // The last known count, else as many rows as fill what is on screen (the table's skeleton rule).
    const rowsOnScreen = props.height === null || props.height === undefined
      ? 1
      : Math.max(1, Math.ceil(props.height / (geometry.cardHeight + GUTTER)));
    const count = lastKnownCount.current > 0 ? lastKnownCount.current : geometry.columns * rowsOnScreen;
    const rows: number[][] = [];
    for (let index = 0; index < count; index += 1) {
      if (index % geometry.columns === 0) rows.push([]);
      rows[rows.length - 1]!.push(index);
    }
    return (
      <GridScroller singleChoice={single !== undefined} pageScroll={props.pageScroll === true} viewport={viewport} request={scrollRequest} accessibilityLabel={props.accessibilityLabel}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={gridRowStyle}>
            {row.map((index) => (
              <HappierSkeletonBlock
                key={index}
                color={theme.colors.control}
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
        const rows: Item[][] = [];
        section.items.forEach((item, index) => {
          if (index % geometry.columns === 0) rows.push([]);
          rows[rows.length - 1]!.push(item);
        });
        return (
          <View
            key={group?.key ?? `collection-${sectionIndex}`}
            role={shelf ? 'group' : undefined}
            aria-label={shelf ? group.title : undefined}
            style={shelfStyle}
            {...(props.testID === undefined || !shelf ? {} : { testID: `${props.testID}:shelf:${group.key}` })}
          >
            {!shelf ? null : (
              <View style={shelfHeaderStyle}>
                <View style={shrinkStyle}>
                  <HappierText variant="label" tone="neutral" numberOfLines={1} style={titleStyle}>{group.title}</HappierText>
                  {group.description === undefined ? null : (
                    <HappierText variant="caption" tone="muted" numberOfLines={1}>{group.description}</HappierText>
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
            {rows.map((row, rowIndex) => (
              <View
                key={rowIndex}
                style={gridRowStyle}
                {...(props.testID === undefined ? {} : { testID: `${props.testID}:grid-row` })}
              >
                {row.map((item) => {
                  const key = keyOf(item);
                  return (
                    <GridCard
                      key={key}
                      item={item}
                      itemKey={key}
                      anatomy={anatomy}
                      geometry={geometry}
                      count={keys.length}
                      activatable={props.selection?.isItemActivatable?.(item) !== false && single?.isItemSelectable?.(item) !== false}
                      selectable={props.selection?.multiple !== undefined && props.selection.multiple.isItemSelectable?.(item) !== false}
                      multipleStore={props.selection?.multiple?.store ?? null}
                      singleChoice={single !== undefined}
                      unavailableReason={single?.unavailableReason?.(item)}
                      useRowActions={props.useRowActions}
                      rowIndex={rowIndices.get(key)!}
                      selected={key === selectedKey}
                      tabStop={key === tabStopKey}
                      onOpen={chooseOrOpen}
                      onFocus={onFocus}
                      onKey={onKey}
                      register={register}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        );
      })}
    </GridScroller>
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
export function CollectionGroupActionButton(props: Readonly<{
  action: CollectionGroupAction | null;
  groupKey: string;
  groupTitle: string;
  testID?: string;
}>): ReactElement | null {
  const action = props.action;
  if (action === null) return null;
  return (
    <HappierPressable
      accessibilityRole="button"
      accessibilityLabel={`${action.label}, ${props.groupTitle}`}
      onPress={action.onPress}
      {...(props.testID === undefined ? {} : { testID: `${props.testID}:group:${props.groupKey}:action` })}
      style={(state) => ({ opacity: state.pressed ? 0.6 : 1 })}
    >
      <HappierText variant="caption" tone="secondary">{action.label}</HappierText>
    </HappierPressable>
  );
}


export function CollectionCards<Item>(props: CollectionCardsProps<Item>): ReactElement {
  return props.presentation === 'board' ? <View role={props.selection?.single === undefined ? undefined : 'radiogroup'}
    accessibilityLabel={props.selection?.single === undefined ? undefined : props.accessibilityLabel} style={fillStyle}>
    <CollectionBoard {...props} />
  </View> : <CollectionGrid {...props} />;
}

const fillStyle: HappierPortableStyle = { flex: 1, minWidth: 0, minHeight: 0 };
const shrinkStyle: HappierPortableStyle = { flex: 1, minWidth: 0, flexShrink: 1 };
const lineStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 };
const titleStyle: HappierPortableStyle = { fontWeight: '600' };
const markStyle: HappierPortableStyle = { alignItems: 'center', justifyContent: 'center' };
const ringStyle: HappierPortableStyle = {
  position: 'absolute',
  top: -1,
  left: -1,
  right: -1,
  bottom: -1,
  borderWidth: 2,
  borderRadius: RADIUS + 1,
};
const boardRowStyle: HappierPortableStyle = { flex: 1, flexDirection: 'row', minWidth: 0, minHeight: 0, paddingHorizontal: GUTTER - CARD.boardCardInsetX };
const boardRowScrollStyle: HappierPortableStyle = { flexGrow: 1, flexDirection: 'row', paddingHorizontal: GUTTER - CARD.boardCardInsetX };
const boardListContentStyle: HappierPortableStyle = { gap: 0, paddingBottom: CARD.padding };
const boardItemStyle: HappierPortableStyle = { paddingHorizontal: CARD.boardCardInsetX, paddingVertical: CARD.boardCardInsetY };
const boardCardStyle: HappierPortableStyle = { borderWidth: 1, borderRadius: RADIUS, overflow: 'visible' };
const boardCardBodyStyle: HappierPortableStyle = { gap: 6, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 12 };
const agentStripStyle: HappierPortableStyle = { borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center' };
const columnHeaderStyle: HappierPortableStyle = { gap: 2, paddingHorizontal: CARD.boardCardInsetX, paddingTop: 14, paddingBottom: 10 };
const pagerStyle: HappierPortableStyle = { paddingHorizontal: GUTTER, paddingVertical: 10 };
const gridContentStyle: HappierPortableStyle = { padding: GUTTER, gap: HAPPIER_PAGE_METRICS.sectionGapPx };
const shelfStyle: HappierPortableStyle = { gap: GUTTER };
const shelfHeaderStyle: HappierPortableStyle = { flexDirection: 'row', alignItems: 'flex-end', gap: 12, paddingHorizontal: HAPPIER_PAGE_METRICS.headingOpticalInsetPx };
const gridRowStyle: HappierPortableStyle = { flexDirection: 'row', gap: GUTTER };
const gridCardStyle: HappierPortableStyle = { borderWidth: 1, borderRadius: RADIUS };
const gridPreviewStyle: HappierPortableStyle = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  overflow: 'hidden',
  borderBottomWidth: 1,
};
const gridFooterStyle: HappierPortableStyle = {
  ...lineStyle,
  position: 'absolute',
  left: CARD.padding + 1,
  right: CARD.padding + 1,
  bottom: CARD.padding + 1,
  height: CARD.footerHeight,
};
const gridActionStyle: HappierPortableStyle = {
  flexShrink: 0,
  justifyContent: 'center',
};
