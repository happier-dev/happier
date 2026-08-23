import {
  PureComponent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { FlatList, I18nManager, Platform, SectionList, View } from 'react-native';

import { useOptionalHappierUiLocalization } from '../environment/context.js';
import type {
  HappierFocusable,
  HappierGestureResponderEvent,
  HappierPortableStyle,
  HappierStyleProp,
} from '../presentation/portableTypes.js';
import {
  readHappierPointerModifiers,
  resolveHappierListMultiSelectionKeyboardIntent,
  resolveHappierListMultiSelectionPointerAction,
  resolveHappierPointerPlatform,
} from '../presentation/collection/multiSelection.js';
import {
  resolveHappierItemBehavior,
  resolveHappierRovingSelection,
  resolveHappierRovingTabStop,
  type HappierRovingCollectionItem,
  type HappierRovingEntry,
} from '../presentation/collection/semantics.js';
import {
  HappierList,
  HappierListItem,
  HappierListSection,
} from '../presentation/collection/List.js';
import {
  HappierItemGroup,
} from '../presentation/collection/ItemGroup.js';
import {
  HappierItemOverflow,
} from '../presentation/collection/ItemOverflow.js';
import type { HappierTone } from '../presentation/semantics.js';
import { Field, TextField } from './Form.js';
import {
  ListMultiSelectionProvider,
  ListSelectionActionBar,
  useListMultiSelectionStoreSnapshot,
  type ListMultiSelectionStore,
} from './ListMultiSelection.js';
import { Stack } from './Layout.js';
import { Menu } from './Overlay.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

const LIST_MORE_ACTIONS_TRANSLATION_KEY = 'happier.plugin-ui.list.moreActions';

type ListBaseProps = Readonly<{
  /** Names the collection for assistive technology. */
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
  style?: HappierStyleProp;
  density?: 'compact' | 'regular';
}>;

type ListSearchBaseProps<Item> = Readonly<{
  /** Visible and assistive-technology name for List's owned search input. */
  label: string;
  placeholder?: string;
  testID?: string;
  /** Decides whether one author item stays in the virtualized data window. */
  filter: (item: Item, query: string) => boolean;
}>;

/**
 * A bounded search state for a virtualized List. An empty query retains the
 * original item array, so selection updates do not rebuild the data window.
 */
export type ListSearchProps<Item> = ListSearchBaseProps<Item> & (
  | Readonly<{
      value: string;
      defaultValue?: never;
      onValueChange: (value: string) => void;
    }>
  | Readonly<{
      value?: never;
      defaultValue?: string;
      onValueChange?: (value: string) => void;
    }>
);

type ListSelectionBaseProps<Item> = Readonly<{
  /**
   * Marks a row the author renders disabled, so keyboard navigation steps over
   * it. Only this List sees the rows its virtualizer has not mounted, so the
   * predicate — not each rendered row — is what makes arrow keys agree with
   * what a reader can actually choose.
   */
  isItemDisabled?: (item: Item, index: number) => boolean;
  /**
   * Observes the logical focus cursor, which is not the selection: keyboard
   * traversal moves focus alone, pointer/touch activation moves both, and a
   * background refresh moves neither. This List owns the movement — only it can
   * see the rows its virtualizer has not mounted — so an author who needs to
   * know where the reader is reads it here rather than keeping a second cursor.
   */
  onFocusedKeyChange?: (key: string) => void;
  /**
   * Opt in to keyed MULTI-selection beside the single selected key.
   *
   * The two cursors stay independent and neither derives from the other: the
   * single `selectedKey` remains "which row's detail is open", the multi
   * selection is "which rows a bulk action will act on", and moving one never
   * moves the other. That independence is why this is an opt-in capability
   * rather than a second meaning stuffed into `selectedKey`.
   *
   * The List owns the rows the capability sees — its flattened traversal order
   * and, for retention, every row the author supplied before search narrowed it
   * — because only the List can see the rows its virtualizer has not mounted.
   */
  multiple?: ListMultiSelectionCapabilityProps<Item>;
}>;

export type ListMultiSelectionCapabilityProps<Item = unknown> = Readonly<{
  /** Created with `useListMultiSelectionController({ rows: 'collection' })`. */
  store: ListMultiSelectionStore;
  /**
   * Which rows a bulk action may act on. A row excluded here can still be read
   * and opened; it simply never joins a selection, which is what a section's
   * continuation or placeholder row needs. Defaults to every row.
   */
  isItemSelectable?: (item: Item, index: number) => boolean;
}>;

/** One selected semantic List.Item key, controlled or initially author-owned. */
export type ListSelectionProps<Item = unknown> = ListSelectionBaseProps<Item> & (
  | Readonly<{
      selectedKey: string | null;
      defaultSelectedKey?: never;
      onSelectedKeyChange: (key: string) => void;
    }>
  | Readonly<{
      selectedKey?: never;
      defaultSelectedKey?: string | null;
      onSelectedKeyChange?: (key: string) => void;
    }>
);

/** The current selected row exposed to an optional virtualized List header. */
export type ListHeaderContext<Item> = Readonly<{
  selectedItem: Item | null;
}>;

/**
 * One labelled group of rows inside a virtualized List.
 *
 * `key` is the group's stable identity; the platform section virtualizer
 * namespaces its cell keys with it, so two sections may contain rows whose
 * author keys collide without the virtualizer confusing their cells. The
 * public `selectedKey` still addresses one row across the whole list, so
 * `keyForItem` must stay unique within a List.
 */
export type ListSectionData<Item> = Readonly<{
  key: string;
  /** Visible and semantic group name. */
  title: string;
  data: readonly Item[];
}>;

type VirtualizedListSharedProps<Item> = Readonly<{
  /** Stable identity is mandatory for inserts/reorders and virtualized state retention. */
  keyForItem: (item: Item, index: number) => string;
  /**
   * One signature across both virtualized arms, so a row component never
   * branches on which arm mounted it. `index` and `sectionKey` describe the
   * row's own collection unit: the whole list in the flat arm, where
   * `sectionKey` is `null`, or its section in the sectioned arm.
   */
  renderItem: (item: Item, index: number, sectionKey: string | null) => ReactNode;
  /** Content, or content derived from List's filtered selected row, above the collection. */
  header?: ReactNode | ((context: ListHeaderContext<Item>) => ReactNode);
  /** Search/filter state owned by this List before the native virtualizer receives rows. */
  search?: ListSearchProps<Item>;
  /** Makes one semantic List.Item per row an accessible selected option. */
  selection?: ListSelectionProps<Item>;
  /** Content shown beside the collection when it has no rows. */
  empty?: ReactNode;
  /** Content below the collection. */
  footer?: ReactNode;
  /** Additive container layout for a virtualized collection. */
  contentContainerStyle?: HappierStyleProp;
  children?: never;
}>;

type FlatVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
  items: readonly Item[];
  sections?: never;
}>;

type SectionedVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
  items?: never;
  /** Labelled groups virtualized together; sections and rows share one scroller. */
  sections: readonly ListSectionData<Item>[];
}>;

type VirtualizedListProps<Item> =
  | FlatVirtualizedListProps<Item>
  | SectionedVirtualizedListProps<Item>;

type StaticListProps = Readonly<{
  items?: never;
  sections?: never;
  keyForItem?: never;
  renderItem?: never;
  header?: never;
  search?: never;
  selection?: never;
  empty?: never;
  footer?: never;
  contentContainerStyle?: never;
  children?: ReactNode;
}>;

/**
 * One row in the flattened traversal order shared by both virtualized arms.
 *
 * `index` and `setSize` are the row's own collection unit — the list, or its
 * section — which is what a screen reader announces and what an author's
 * `keyForItem`/`renderItem`/`isItemDisabled` callbacks receive. The row's
 * position in this array is the collection-wide navigation position, so a
 * section boundary never becomes a second navigation owner.
 */
type ListRow<Item> = Readonly<{
  item: Item;
  key: string;
  index: number;
  setSize: number;
  sectionKey: string | null;
  sectionIndex: number;
}>;

export type ListProps<Item> = ListBaseProps & (VirtualizedListProps<Item> | StaticListProps);

export type ListSectionProps = Readonly<{
  children?: ReactNode;
  /** Visible and semantic group name. */
  title: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

type ItemSecondaryAction = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
}>;

type ItemSecondaryActionsProps =
  | Readonly<{
      secondaryActions: readonly ItemSecondaryAction[];
      secondaryActionAccessibilityLabel?: string;
      onSecondaryAction: (id: string) => void;
    }>
  | Readonly<{
      secondaryActions?: undefined;
      secondaryActionAccessibilityLabel?: never;
      onSecondaryAction?: undefined;
    }>;

/**
 * Curated author row props. Theme, target size, secondary-action state,
 * accessory placement and ItemGroup indexing remain adapter-owned facts.
 */
export type ItemProps = Readonly<{
  /**
   * The row's content. Alone it owns the whole row; beside `title`/`subtitle`
   * it is the row body and renders after them. Either way it is rendered.
   */
  children?: ReactNode;
  title?: string;
  subtitle?: string;
  detail?: string;
  icon?: ReactNode;
  accessory?: ReactNode;
  tone?: HappierTone;
  /**
   * The activation event travels with the press. A single-select list ignores
   * it; the multi-selection capability reads its modifier keys to tell an open
   * from a toggle or a range extension.
   */
  onPress?: (event?: HappierGestureResponderEvent) => unknown;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
  accessibilityRole?: 'radio' | 'option' | 'button';
  accessibilityExpanded?: boolean;
  accessibilityPositionInSet?: number;
  accessibilitySetSize?: number;
  density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
  showDivider?: boolean;
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  /**
   * Describes the row beside its name — what activating it does, or what makes
   * this row different from its neighbours. The title remains the accessible
   * name, so a reader hears the row's identity first and its description after.
   */
  accessibilityHint?: string;
  accessibilityHintKey?: string;
  testID?: string;
  style?: HappierStyleProp;
}> & ItemSecondaryActionsProps;
export type ListItemProps = ItemProps;

type ListItemSelectionContextValue = Readonly<{
  selected: boolean;
  /** The activation event carries the modifier keys one press means something by. */
  select: (event?: HappierGestureResponderEvent) => void;
  positionInSet: number;
  setSize: number;
  roving: HappierRovingCollectionItem;
}>;

const ListItemSelectionContext = createContext<ListItemSelectionContextValue | null>(null);

type VirtualizedListRowProps<Item> = Readonly<{
  item: Item;
  /** Position in the collection-wide traversal order, which keyboard navigation addresses. */
  rowIndex: number;
  /** Position within the row's own collection unit, which authors and readers see. */
  index: number;
  itemKey: string;
  sectionKey: string | null;
  setSize: number;
  renderItem: (item: Item, index: number, sectionKey: string | null) => ReactNode;
  selectionEnabled: boolean;
  selected: boolean;
  /**
   * Resolved per row rather than passed as the collection's tab-stop index, so
   * moving the stop commits only the two rows whose tab order actually changed
   * instead of every mounted row.
   */
  isTabStop: boolean;
  onSelect: (key: string, event?: HappierGestureResponderEvent) => void;
  onRovingKey: (index: number, key: string, event: unknown) => boolean;
  registerTarget: (key: string, target: HappierFocusable | null) => void;
}>;

/**
 * FlatList may revisit mounted cells when its surrounding chrome changes. Keep
 * the row boundary narrow so the public List's selected key changes only the
 * formerly selected and newly selected semantic rows.
 */
class VirtualizedListRow<Item> extends PureComponent<VirtualizedListRowProps<Item>> {
  render(): ReactElement {
    const props = this.props;
    const selection: ListItemSelectionContextValue | null = props.selectionEnabled
      ? {
          selected: props.selected,
          select: (event) => props.onSelect(props.itemKey, event),
          positionInSet: props.index + 1,
          setSize: props.setSize,
          roving: {
            isTabStop: props.isTabStop,
            onKeyDown: (key, event) => props.onRovingKey(props.rowIndex, key, event),
            register: (target) => props.registerTarget(props.itemKey, target),
          },
        }
      : null;
    const renderedItem = props.renderItem(props.item, props.index, props.sectionKey);
    // A primitive item has no React Native text host or row semantics. Route it
    // through the selectable List.Item owner when selection is active; authored
    // semantic rows already consume that context and must not be wrapped again.
    const row = typeof renderedItem === 'string' || typeof renderedItem === 'number'
      ? selection === null
        ? <HappierListItem>{renderedItem}</HappierListItem>
        : <ListItem>{renderedItem}</ListItem>
      : <>{renderedItem}</>;

    return selection === null
      ? row
      : <ListItemSelectionContext.Provider value={selection}>{row}</ListItemSelectionContext.Provider>;
  }
}

function isVirtualizedList<Item>(
  props: ListProps<Item>,
): props is ListBaseProps & VirtualizedListProps<Item> {
  return props.items !== undefined || props.sections !== undefined;
}

function resolveVirtualizedHeader<Item>(
  header: VirtualizedListProps<Item>['header'],
  context: ListHeaderContext<Item>,
): ReactNode {
  return typeof header === 'function' ? header(context) : header;
}

/**
 * The one owner of a virtualized collection's in-flight physical focus request.
 *
 * A native virtualizer mounts a revealed cell one or more frames after the
 * scroll it was asked for, so the request has to outlive the commit that made
 * it. Exactly one request exists at a time, and it is retired by exactly one of
 * three events — which is why no generation counter and no timer are needed:
 *
 * - `consume`, when the requested row registers its own target: the reveal
 *   landed, and this is the ONLY event that moves physical focus;
 * - `claim`, when a newer navigation supersedes an older unlanded request;
 * - `abandon`, when the request can no longer be honoured — the row left the
 *   filtered collection, or a pointer interaction has already placed native
 *   focus itself and a later arrival would yank it away from the reader.
 *
 * Clearing at the next commit instead would pass a synchronously-mounting test
 * double and silently drop the focus move on device; never clearing on the
 * pointer path leaves a request that steals focus after the interaction. Both
 * are the same missing lifecycle, not two bugs.
 */
type RowFocusRequest = Readonly<{
  claim: (key: string) => void;
  abandon: () => void;
  requestedKey: () => string | null;
  /** Moves physical focus only when `key` is the row still being waited for. */
  consume: (key: string, target: HappierFocusable) => void;
}>;

/** Mirrors the React Native scroll view's own growth, which used to be the List's outer box. */
const virtualizedListBoxStyle: HappierPortableStyle = { flexGrow: 1, flexShrink: 1, minWidth: 0 };

function useRowFocusRequest(): RowFocusRequest {
  const requested = useRef<string | null>(null);
  return useMemo<RowFocusRequest>(() => ({
    claim: (key) => {
      requested.current = key;
    },
    abandon: () => {
      requested.current = null;
    },
    requestedKey: () => requested.current,
    consume: (key, target) => {
      if (requested.current !== key) return;
      requested.current = null;
      target.focus?.();
    },
  }), []);
}

function VirtualizedList<Item>(props: ListBaseProps & VirtualizedListProps<Item>): ReactElement {
  // Density changes only the spacing between authored rows. It does not select
  // a separate item implementation or carry core row policy into the public
  // component surface.
  const densityStyle: HappierPortableStyle = props.density === 'compact' ? { gap: 4 } : { gap: 8 };
  const [uncontrolledQuery, setUncontrolledQuery] = useState(props.search?.defaultValue ?? '');
  const controlledQuery = props.search?.value;
  const query = controlledQuery === undefined ? uncontrolledQuery : controlledQuery;
  const filter = props.search?.filter;
  const authorItems = props.items;
  const authorSections = props.sections;
  const visibleItems = useMemo(() => {
    // Keep the caller's input identity intact unless a non-empty query truly
    // derives a smaller window. This is the one measured large-list derivation;
    // selection itself must not trigger it again.
    if (authorItems === undefined) return undefined;
    if (query === '' || filter === undefined) return authorItems;
    return authorItems.filter((item) => filter(item, query));
  }, [authorItems, filter, query]);
  // Same rule for the sectioned arm, with one addition: a section with no rows
  // leaves no group behind. A labelled header over nothing announces a group a
  // reader cannot enter, and the platform still counts its header cell, so the
  // collection would never reach the empty slot either. The rule is the section's
  // own, not the query's: an author-empty section and a filtered-empty one are
  // the same fact, so one owner drops both.
  const visibleSections = useMemo(() => {
    if (authorSections === undefined) return undefined;
    if (query === '' || filter === undefined) {
      return authorSections.every((section) => section.data.length > 0)
        ? authorSections
        : authorSections.filter((section) => section.data.length > 0);
    }
    return authorSections.flatMap((section) => {
      const data = section.data.filter((item) => filter(item, query));
      return data.length === 0 ? [] : [{ ...section, data }];
    });
  }, [authorSections, filter, query]);

  const keyForItem = props.keyForItem;
  // ONE flattened traversal order for both arms. The roving tab stop, arrow
  // movement and pending focus all address a row by its position here, so a
  // section boundary never becomes a second navigation owner.
  const rows = useMemo<readonly ListRow<Item>[]>(() => {
    if (visibleSections !== undefined) {
      return visibleSections.flatMap((section, sectionIndex) => section.data.map((item, index) => ({
        item,
        key: keyForItem(item, index),
        index,
        setSize: section.data.length,
        sectionKey: section.key,
        sectionIndex,
      })));
    }
    const items = visibleItems ?? [];
    return items.map((item, index) => ({
      item,
      key: keyForItem(item, index),
      index,
      setSize: items.length,
      sectionKey: null,
      sectionIndex: -1,
    }));
  }, [keyForItem, visibleItems, visibleSections]);
  // One keyed lookup replaces the per-fact linear scans selection, focus and
  // the pending-focus prune would each otherwise run over the whole array.
  const rowIndexByKey = useMemo(() => {
    const indexes = new Map<string, number>();
    rows.forEach((row, rowIndex) => {
      if (!indexes.has(row.key)) indexes.set(row.key, rowIndex);
    });
    return indexes;
  }, [rows]);
  const sectionRowOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = 0;
    for (const section of visibleSections ?? []) {
      offsets.set(section.key, offset);
      offset += section.data.length;
    }
    return offsets;
  }, [visibleSections]);

  // ---- Opt-in keyed multi-selection ---------------------------------------
  // The store is the single owner of the selected set; this List owns only the
  // ROWS it can see, which is the half a store can never know for itself.
  const multiCapability = props.selection?.multiple;
  const multiStore = multiCapability?.store ?? null;
  const multiStoreRef = useRef<ListMultiSelectionStore | null>(multiStore);
  multiStoreRef.current = multiStore;
  const multiSnapshot = useListMultiSelectionStoreSnapshot(multiStore);
  const isItemSelectable = multiCapability?.isItemSelectable;
  const visibleSelectionKeys = useMemo(
    () => rows.map((row) => row.key),
    [rows],
  );
  // Eligibility is derived from the AUTHOR's rows, not the filtered ones, so a
  // reader who selects six rows and then types in the search box still has six
  // rows selected when they clear it. Memoized on the dataset identity, so a
  // selection change never reprojects it.
  const eligibleSelectionKeys = useMemo(() => {
    if (multiStore === null) return [];
    const authorRows = authorSections !== undefined
      ? authorSections.flatMap((section) => section.data.map((item, index) => ({ item, index })))
      : (authorItems ?? []).map((item, index) => ({ item, index }));
    return authorRows
      .filter((entry) => isItemSelectable?.(entry.item, entry.index) !== false)
      .map((entry) => keyForItem(entry.item, entry.index));
  }, [authorItems, authorSections, isItemSelectable, keyForItem, multiStore]);
  useEffect(() => {
    multiStore?.setVisibleRows({
      visibleOrderedKeys: visibleSelectionKeys,
      eligibleKeys: eligibleSelectionKeys,
    });
  }, [eligibleSelectionKeys, multiStore, visibleSelectionKeys]);

  const [uncontrolledSelectedKey, setUncontrolledSelectedKey] = useState<string | null>(
    props.selection?.defaultSelectedKey ?? null,
  );
  const controlledSelectedKey = props.selection?.selectedKey;
  const selectedKey = controlledSelectedKey === undefined ? uncontrolledSelectedKey : controlledSelectedKey;
  const selectionIsControlled = controlledSelectedKey !== undefined;
  const selectionEnabled = props.selection !== undefined;
  // Logical focus is its own fact. Keyboard navigation moves it alone, so a
  // reader can traverse a 2,000-row listbox without committing a selection the
  // rest of the surface would immediately act on, and a background refresh,
  // scan arrival or watch update moves neither.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // One owner for "focus moved", so both movement paths report the same fact
  // and neither reads the author's callback through a memoized closure that an
  // inline arrow would invalidate on every render.
  const requestFocus = (key: string) => {
    setFocusedKey(key);
    // One cursor, reported twice: the store's focus is what a bulk-action bar
    // and a row checkbox read, and letting it drift from the List's own focus
    // would be the second cursor this capability exists to avoid.
    multiStoreRef.current?.setFocusedKey(key);
    props.selection?.onFocusedKeyChange?.(key);
  };
  const requestFocusRef = useRef(requestFocus);
  requestFocusRef.current = requestFocus;
  const requestSelection = (key: string) => {
    if (key === selectedKey) return;
    if (!selectionIsControlled) setUncontrolledSelectedKey(key);
    props.selection?.onSelectedKeyChange?.(key);
  };
  const requestSelectionRef = useRef(requestSelection);
  requestSelectionRef.current = requestSelection;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  // Held behind a ref for the same reason the selected key is: the row renderer
  // must not be invalidated by a selection change, or every mounted cell is
  // rebuilt on each toggle. `extraData` below is what commits the rows.
  const multiSelectedKeysRef = useRef(multiSnapshot.selectedKeys);
  multiSelectedKeysRef.current = multiSnapshot.selectedKeys;
  const rowFocusRequest = useRowFocusRequest();

  // Pointer and touch activation is one gesture that both focuses and selects;
  // only the keyboard separates the two. The gesture has already placed native
  // focus on the row it landed on, so it also RETIRES any request still waiting
  // for a reveal — otherwise that row's later registration pulls focus off the
  // row the reader just chose, one or more frames after the interaction.
  const selectItem = useCallback((key: string, event?: HappierGestureResponderEvent) => {
    rowFocusRequest.abandon();
    const store = multiStoreRef.current;
    if (store !== null) {
      const modifiers = readHappierPointerModifiers(event);
      const action = resolveHappierListMultiSelectionPointerAction({
        isSelectionMode: store.getSnapshot().isSelectionMode,
        platform: resolveHappierPointerPlatform(Platform.OS),
        ...modifiers,
      });
      if (action !== 'open') {
        // A modified press builds a SET. Moving the single selected key here
        // would open a detail the reader did not ask for and discard the set
        // they were assembling, which is exactly the two cursors collapsing
        // into one.
        requestFocusRef.current(key);
        if (action === 'toggle') store.toggle(key);
        else if (action === 'selectRange') store.selectRange(key);
        else store.addRange(key);
        return;
      }
    }
    requestFocusRef.current(key);
    requestSelectionRef.current(key);
  }, [rowFocusRequest]);
  const requestQueryChange = (nextQuery: string) => {
    if (controlledQuery === undefined) setUncontrolledQuery(nextQuery);
    props.search?.onValueChange?.(nextQuery);
  };

  // ---- Collection keyboard navigation -------------------------------------
  // A listbox is one composite widget, so it owns a single roving tab stop and
  // arrow/Home/End movement over the WHOLE filtered array. Only this owner can
  // do that: a row cannot reach the rows the virtualizer has not mounted. The
  // navigation rule itself stays in the shared collection semantics owner, the
  // same one HappierItemGroup's radio groups use.
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const isItemDisabled = props.selection?.isItemDisabled;
  const rovingEntries = useMemo<readonly HappierRovingEntry[]>(
    () => rows.map((row) => ({ disabled: isItemDisabled?.(row.item, row.index) === true })),
    [isItemDisabled, rows],
  );
  // A range extension steps over what it cannot SELECT, which is a larger set
  // than what it cannot reach: a continuation row is readable and focusable and
  // still never joins a selection. Reusing the reading entries here would stop
  // an extension dead on the first such row.
  const multiRovingEntries = useMemo<readonly HappierRovingEntry[]>(
    () => (multiStore === null
      ? rovingEntries
      : rows.map((row, rowIndex) => ({
          disabled: rovingEntries[rowIndex]?.disabled === true
            || isItemSelectable?.(row.item, row.index) === false,
        }))),
    [isItemSelectable, multiStore, rovingEntries, rows],
  );
  const selectedIndex = selectedKey === null ? -1 : rowIndexByKey.get(selectedKey) ?? -1;
  const focusedIndex = focusedKey === null ? -1 : rowIndexByKey.get(focusedKey) ?? -1;
  // The single tab stop follows logical focus. Before the reader has moved it —
  // and after a query filters the focused row away — the selected row is the
  // collection's current choice, so Tab still returns to something meaningful.
  const tabStopIndex = resolveHappierRovingTabStop({
    entries: rovingEntries,
    selectedIndex: focusedIndex >= 0 ? focusedIndex : selectedIndex,
  });
  const tabStopIndexRef = useRef(tabStopIndex);
  tabStopIndexRef.current = tabStopIndex;

  const listRef = useRef<FlatList<Item> | null>(null);
  const sectionListRef = useRef<SectionList<Item, ListSectionData<Item>> | null>(null);
  const rowTargets = useRef(new Map<string, HappierFocusable>());
  const registerTarget = useCallback((key: string, target: HappierFocusable | null) => {
    if (target === null) {
      rowTargets.current.delete(key);
      return;
    }
    rowTargets.current.set(key, target);
    // The request survives until ITS OWN row registers a real target, which is
    // the one event that proves the reveal landed.
    rowFocusRequest.consume(key, target);
  }, [rowFocusRequest]);
  // A row that has left the collection can never register, so its request must
  // not stay alive: a later scroll back into range would steal focus long after
  // the reader moved on. Only a live request pays for the lookup.
  useEffect(() => {
    const key = rowFocusRequest.requestedKey();
    if (key === null) return;
    if (!rowIndexByKey.has(key)) rowFocusRequest.abandon();
  }, [rowFocusRequest, rowIndexByKey]);

  const revealRow = (rowIndex: number) => {
    const row = rows[rowIndex];
    if (row === undefined) return;
    if (row.sectionKey !== null) {
      // A section virtualizer has no whole-list index: a cell is addressed by
      // its section and its position inside that section.
      sectionListRef.current?.scrollToLocation({
        sectionIndex: row.sectionIndex,
        itemIndex: row.index,
        animated: false,
        viewPosition: 0.5,
      });
      return;
    }
    const list = listRef.current;
    if (list === null) return;
    // Home and End land far outside the measured window, where `scrollToIndex`
    // has no frame to target; both ends are always reachable by offset.
    if (rowIndex === 0) list.scrollToOffset({ offset: 0, animated: false });
    else if (rowIndex === rows.length - 1) list.scrollToEnd({ animated: false });
    else list.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.5 });
  };
  /**
   * Ask for physical focus on one logical row.
   *
   * Recording the request before the reveal is what makes a newer request
   * supersede an older unlanded one: the second overwrite is the whole
   * mechanism, so no generation counter or timer is needed.
   */
  const requestRowFocus = (key: string, index: number) => {
    rowFocusRequest.claim(key);
    revealRow(index);
    const mounted = rowTargets.current.get(key);
    if (mounted === undefined) return;
    rowFocusRequest.consume(key, mounted);
  };
  const moveFocus = (fromIndex: number, key: string, event: unknown): boolean => {
    const currentRowIndex = focusedIndex >= 0 ? focusedIndex : fromIndex;
    const multiStoreForKey = multiStoreRef.current;
    if (multiStoreForKey !== null) {
      const snapshot = multiStoreForKey.getSnapshot();
      const intent = resolveHappierListMultiSelectionKeyboardIntent({
        key,
        ...readHappierPointerModifiers(event),
        platform: resolveHappierPointerPlatform(Platform.OS),
        entries: multiRovingEntries,
        currentIndex: currentRowIndex,
        rtl,
      });
      // Escape belongs to whatever the reader is actually in. With no live
      // selection it is the host's — a dialog, a detail pane — so the capability
      // declines it rather than swallowing a key it has nothing to close.
      const claimed = intent !== null && (intent.kind !== 'exit' || snapshot.isSelectionMode);
      if (claimed && intent !== null) {
        const currentKey = rows[currentRowIndex]?.key ?? null;
        if (intent.kind === 'exit') multiStoreForKey.exit();
        else if (intent.kind === 'selectAllVisible') multiStoreForKey.selectAllVisible();
        else if (intent.kind === 'toggleFocused') {
          if (currentKey !== null) multiStoreForKey.toggle(currentKey);
        } else {
          const nextRow = rows[intent.toIndex];
          if (nextRow !== undefined) {
            // Shift+Arrow before anything is selected has no anchor to measure
            // from, so the row the reader is standing on becomes it. Without
            // this the first extension selects one row and the second selects
            // from there, which reads as a dropped keypress.
            if (snapshot.selectedKeys.size === 0 && currentKey !== null) {
              multiStoreForKey.replaceWith(currentKey);
            }
            multiStoreForKey.addRange(nextRow.key);
            requestFocusRef.current(nextRow.key);
            requestRowFocus(nextRow.key, intent.toIndex);
          }
        }
        return true;
      }
    }
    // Activation stays with the shared row pressable. This owner claims only
    // collection navigation, so Space and Enter still select through the
    // author's row action rather than through a second activation path.
    if (key === ' ' || key === 'Spacebar') return false;
    // Logical focus, not the row the key event happened to reach, is where the
    // reader is. While a reveal is in flight the requested row has not mounted,
    // so the keydown still arrives at the previous row's element; navigating
    // from there would silently discard the move the reader already made.
    const currentIndex = currentRowIndex;
    const next = resolveHappierRovingSelection({
      entries: rovingEntries,
      currentIndex,
      key,
      rtl,
      listNavigationKeys: true,
    });
    if (next === null || next === currentIndex) return false;
    const nextRow = rows[next];
    if (nextRow === undefined) return false;
    const nextKey = nextRow.key;
    // Selection is deliberately untouched: arrow and j/k movement is a reading
    // gesture, and committing a selection per keypress would make every step
    // through the list act on the rest of the surface.
    requestFocusRef.current(nextKey);
    requestRowFocus(nextKey, next);
    return true;
  };
  const moveFocusRef = useRef(moveFocus);
  moveFocusRef.current = moveFocus;
  // Held behind a ref so a focus or selection change never invalidates the row
  // renderer and forces the virtualizer to rebuild its mounted cells.
  const onRovingKey = useCallback(
    (index: number, key: string, event: unknown) => moveFocusRef.current(index, key, event),
    [],
  );

  const headerRenderer = typeof props.header === 'function' ? props.header : undefined;
  const selectedItem = useMemo(() => {
    if (headerRenderer === undefined || selectedKey === null) return null;
    const rowIndex = rowIndexByKey.get(selectedKey);
    return rowIndex === undefined ? null : rows[rowIndex]?.item ?? null;
  }, [headerRenderer, rowIndexByKey, rows, selectedKey]);
  const authorHeader = resolveVirtualizedHeader(props.header, { selectedItem });
  const searchControl = props.search ? (
    <Field label={props.search.label}>
      <TextField
        label={props.search.label}
        value={query}
        onChange={requestQueryChange}
        placeholder={props.search.placeholder}
        testID={props.search.testID}
      />
    </Field>
  ) : null;
  const headerContent = searchControl === null && (authorHeader === null || authorHeader === undefined)
    ? null
    : <Stack gap="small">{searchControl}{authorHeader}</Stack>;
  // Chrome is a SIBLING of the collection element, never a cell inside it. A
  // listbox admits groups and options and a list admits list items; a search
  // textbox, an author header or an empty-state block placed in the scroller
  // becomes an unpermitted child and invalidates the whole control for a
  // reader. The empty slot is a sibling for a second reason: the platform
  // section virtualizer counts a header cell per section, so its own empty slot
  // never fires for a sectioned collection.
  const emptyContent = rows.length === 0 ? props.empty : null;
  const renderItem = props.renderItem;
  // One row projection for both arms. `rowIndex` is the collection-wide
  // navigation position; `index` and `setSize` stay unit-local, which is what a
  // reader hears and what the author's callbacks already receive.
  const renderRow = useCallback((input: Readonly<{
    item: Item;
    rowIndex: number;
    index: number;
    setSize: number;
    sectionKey: string | null;
  }>) => {
    const itemKey = keyForItem(input.item, input.index);
    return (
      <VirtualizedListRow
        item={input.item}
        rowIndex={input.rowIndex}
        index={input.index}
        itemKey={itemKey}
        sectionKey={input.sectionKey}
        setSize={input.setSize}
        renderItem={renderItem}
        selectionEnabled={selectionEnabled}
        // With the capability mounted, `aria-selected` is the multi-selection —
        // the standard meaning in a multi-selectable listbox. The single key
        // stays the open detail and keeps owning the tab stop.
        selected={multiStore === null
          ? selectedKeyRef.current === itemKey
          : multiSelectedKeysRef.current.has(itemKey)}
        isTabStop={selectionEnabled && tabStopIndexRef.current === input.rowIndex}
        onSelect={selectItem}
        onRovingKey={onRovingKey}
        registerTarget={registerTarget}
      />
    );
  }, [keyForItem, multiStore, onRovingKey, registerTarget, renderItem, selectItem, selectionEnabled]);

  const flatSetSize = visibleItems?.length ?? 0;
  const renderFlatRow = useCallback(({ item, index }: Readonly<{ item: Item; index: number }>) => (
    renderRow({ item, rowIndex: index, index, setSize: flatSetSize, sectionKey: null })
  ), [flatSetSize, renderRow]);
  const renderSectionRow = useCallback(({ item, index, section }: Readonly<{
    item: Item;
    index: number;
    section: ListSectionData<Item>;
  }>) => renderRow({
    item,
    rowIndex: (sectionRowOffsets.get(section.key) ?? 0) + index,
    index,
    setSize: section.data.length,
    sectionKey: section.key,
  }), [renderRow, sectionRowOffsets]);
  const collectionRole = selectionEnabled ? 'listbox' : 'list';
  // The shared section owner, told which collection element the virtualizer
  // makes this header a direct child of. The rows are its siblings there, so
  // the header has to be a child that collection role actually permits.
  const renderSectionHeader = useCallback(({ section }: Readonly<{ section: ListSectionData<Item> }>) => (
    <HappierListSection title={section.title} virtualizedCollectionRole={collectionRole} />
  ), [collectionRole]);

  // Both facts reach the mounted cells: the tab stop follows focus, so a
  // focus-only move must still commit the two rows whose tab order changed.
  const extraData = selectionEnabled
    ? `${selectedKey ?? ''}\u0000${focusedKey ?? ''}\u0000${multiStore === null ? '' : multiSnapshot.version}`
    : undefined;

  const collection = visibleSections !== undefined ? (
    <SectionList
      ref={sectionListRef}
      sections={visibleSections}
      keyExtractor={keyForItem}
      accessibilityRole={selectionEnabled ? undefined : 'list'}
      // @ts-expect-error React Native's role union omits RNW's standard listbox role.
      role={collectionRole}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={props.style}
      contentContainerStyle={[densityStyle, props.contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
      stickySectionHeadersEnabled
      extraData={extraData}
      renderItem={renderSectionRow}
      renderSectionHeader={renderSectionHeader}
      onScrollToIndexFailed={(info) => {
        // Same rule as the flat arm: approach an unmeasured cell by the
        // measured average and let the pending focus resolve when the row
        // mounts. A section list moves its own scroll responder rather than
        // exposing a whole-list offset method.
        sectionListRef.current?.getScrollResponder()?.scrollTo({
          y: info.averageItemLength * info.index,
          animated: false,
        });
      }}
    />
  ) : (
    <FlatList
      ref={listRef}
      data={visibleItems}
      keyExtractor={keyForItem}
      accessibilityRole={selectionEnabled ? undefined : 'list'}
      // @ts-expect-error React Native's role union omits RNW's standard listbox role.
      role={collectionRole}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={props.style}
      contentContainerStyle={[densityStyle, props.contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
      extraData={extraData}
      renderItem={renderFlatRow}
      onScrollToIndexFailed={(info) => {
        // Without a fixed row height the virtualizer cannot land on a row it has
        // never measured. Approach it by the measured average; the pending focus
        // resolves once the row mounts.
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: false,
        });
      }}
    />
  );

  // One box around the collection and its chrome. It is unconditional so that
  // gaining or losing chrome never changes the React tree shape around the
  // virtualizer, which would remount it and throw away its scroll position.
  // The provider is UNCONDITIONAL for the same reason the box is: a tree shape
  // that changed with the capability would remount the virtualizer and throw
  // away its scroll position. It publishes the store to the rows, to an author's
  // own row affordance, and to `List.SelectionActionBar` in the footer.
  return (
    <ListMultiSelectionProvider store={multiStore}>
      <View style={virtualizedListBoxStyle}>
        {headerContent}
        {collection}
        {emptyContent}
        {props.footer}
      </View>
    </ListMultiSelectionProvider>
  );
}

function ListRoot<Item>(props: ListProps<Item>): ReactElement {
  const { accessibilityLabel, accessibilityLabelKey, ...rest } = props;
  const resolvedAccessibilityLabel = resolveAuthorText(
    usePluginTranslation(),
    accessibilityLabel,
    accessibilityLabelKey,
  );
  const resolvedProps = { ...rest, accessibilityLabel: resolvedAccessibilityLabel } as ListProps<Item>;
  if (isVirtualizedList(resolvedProps)) return <VirtualizedList {...resolvedProps} />;
  const densityStyle: HappierPortableStyle = props.density === 'compact' ? { gap: 4 } : { gap: 8 };
  return (
    <HappierList
      accessibilityLabel={resolvedAccessibilityLabel}
      testID={props.testID}
      style={[densityStyle, props.style]}
    >
      {props.children}
    </HappierList>
  );
}

function ListSection(props: ListSectionProps): ReactElement {
  return <HappierListSection {...props} />;
}

function renderListItem(
  props: ItemProps & Readonly<{ rovingCollectionItem?: HappierRovingCollectionItem }>,
  defaultSecondaryActionAccessibilityLabel: string,
  suppressListItemRole = false,
): ReactElement {
  const { secondaryActions, secondaryActionAccessibilityLabel, onSecondaryAction, accessory, ...item } = props;
  const hasSecondaryActions = secondaryActions !== undefined
    && secondaryActions.length > 0
    && onSecondaryAction !== undefined;
  // Disabled/busy row-action admission is a shared collection decision, not a
  // Menu-local condition. The overflow retains its own individual-action guard.
  const secondaryActionsEnabled = resolveHappierItemBehavior({
    disabled: item.disabled,
    busy: item.busy,
    hasPrimaryAction: item.onPress !== undefined,
    hasSecondaryActions,
  }).secondaryActionsEnabled;
  const overflow = hasSecondaryActions ? (
    <HappierItemOverflow
      actions={secondaryActions}
      secondaryActionsEnabled={secondaryActionsEnabled}
      accessibilityLabel={secondaryActionAccessibilityLabel ?? defaultSecondaryActionAccessibilityLabel}
      onSelect={onSecondaryAction}
      renderMenu={(input) => (
        <Menu
          open={input.open}
          onOpenChange={input.onOpenChange}
          trigger={input.trigger}
          triggerAccessibilityLabel={input.triggerAccessibilityLabel}
          testID={input.testID}
          disabled={input.disabled}
          items={input.actions.map((action) => ({ id: action.id, label: action.label, disabled: action.disabled }))}
          onSelect={input.onSelect}
        />
      )}
    />
  ) : null;
  const composedAccessory = accessory === undefined || accessory === null
    ? overflow
    : overflow === null
      ? accessory
      : <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>{accessory}{overflow}</View>;
  return (
    <HappierListItem
      {...item}
      accessory={composedAccessory}
      hasSecondaryActions={hasSecondaryActions}
      accessoryOutsidePressable={hasSecondaryActions}
      suppressListItemRole={suppressListItemRole}
    />
  );
}

function ListItem(props: ListItemProps): ReactElement {
  const translate = usePluginTranslation();
  const selection = useContext(ListItemSelectionContext);
  const defaultSecondaryActionAccessibilityLabel = translate(LIST_MORE_ACTIONS_TRANSLATION_KEY, 'More actions');
  const { accessibilityLabelKey, accessibilityHintKey, ...authorProps } = props;
  const resolvedProps = {
    ...authorProps,
    accessibilityLabel: resolveAuthorText(translate, props.accessibilityLabel, accessibilityLabelKey),
    accessibilityHint: resolveAuthorText(translate, props.accessibilityHint, accessibilityHintKey),
  } as ListItemProps;
  if (selection === null) return renderListItem(resolvedProps, defaultSecondaryActionAccessibilityLabel);
  return renderListItem({
    ...resolvedProps,
    selected: selection.selected,
    accessibilityRole: 'option',
    accessibilityPositionInSet: selection.positionInSet,
    accessibilitySetSize: selection.setSize,
    rovingCollectionItem: selection.roving,
    onPress: (event) => {
      selection.select(event);
      return props.onPress?.(event);
    },
  }, defaultSecondaryActionAccessibilityLabel, true);
}

/** Standalone semantic row; identical owner and behavior to `List.Item`. */
export function Item(props: ListItemProps): ReactElement {
  return <ListItem {...props} />;
}

export type ItemGroupProps = Readonly<{
  children?: ReactNode;
  accessibilityRole?: 'radiogroup';
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

/** Standalone group semantics; app-private card/grid chrome is intentionally absent. */
export function ItemGroup(props: ItemGroupProps): ReactElement {
  const { accessibilityLabel, accessibilityLabelKey, ...rest } = props;
  return (
    <HappierItemGroup
      {...rest}
      accessibilityLabel={resolveAuthorText(
        usePluginTranslation(),
        accessibilityLabel,
        accessibilityLabelKey,
      )}
    />
  );
}

/**
 * A bounded compound collection API. Search/filter/selection state stays at
 * the virtualized List owner; each semantic `List.Item` delegates activation,
 * keyboard behavior, focus and pending state to the shared HappierPressable.
 */
export const List = Object.assign(ListRoot, {
  Section: ListSection,
  Item: ListItem,
  /**
   * The bulk action bar for the multi-selection capability. Placed in `footer`,
   * it reads the same store the rows do and renders only while a selection is
   * live.
   */
  SelectionActionBar: ListSelectionActionBar,
});
