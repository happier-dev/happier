import {
  Children,
  Fragment,
  PureComponent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  I18nManager,
  Platform,
  View,
  type SectionListData as ReactNativeSectionListData,
} from 'react-native';

import { useOptionalHappierUiLocalization, useOptionalHappierUiPalette } from '../environment/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HappierPageSectionHeader, HappierPageSheet } from '../presentation/layout/PageSection.js';
import { useHappierPageChrome } from '../presentation/layout/pageChrome.js';
import type {
  HappierFocusable,
  HappierGestureResponderEvent,
  HappierPortableStyle,
  HappierStyleProp,
} from '../presentation/portableTypes.js';
import {
  readHappierPointerModifiers,
  resolveHappierListMultiSelectionKeyboardIntent,
  resolveHappierPointerPlatform,
} from '../presentation/collection/multiSelection.js';
import {
  admitHappierCollectionKeys,
  narrowHappierCollectionGroups,
} from '../presentation/collection/collectionModel.js';
import {
  encodeHappierSectionCellKey,
  encodeHappierSectionRowCellKey,
  resolveHappierItemBehavior,
  resolveHappierItemGroupConstraints,
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
  HappierItemGroupBehavior,
} from '../presentation/collection/ItemGroup.js';
import {
  HappierItemOverflow,
} from '../presentation/collection/ItemOverflow.js';
import type { HappierTone } from '../presentation/semantics.js';
import {
  ListMultiSelectionProvider,
  activateListItem,
  ListSelectionActionBar,
  useOptionalListMultiSelectionStore,
  useListMultiSelectionStoreSnapshot,
  type ListMultiSelectionKey,
  type ListMultiSelectionStore,
} from './ListMultiSelection.js';
import { ContextMenu } from './Overlay.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { ListCollectionControlContext } from './listCollectionControl.js';
import { ListCollectionHeader, useListCollectionSearch } from './listCollectionHeader.js';
import { HappierDisclosure, resolveHappierDisclosureFrameStyle } from '../presentation/collection/Disclosure.js';
import { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { useHappierUiAccessibility } from '../environment/context.js';
import {
  CollectionVirtualizerContext,
  type CollectionVirtualizer,
  type CollectionVirtualizerHandle,
} from '../presentation/collection/collectionVirtualizer.js';
import { NATIVE_COLLECTION_VIRTUALIZER } from '../presentation/collection/nativeCollectionVirtualizer.js';
import { HappierListRowOpenContext } from '../presentation/collection/CollectionList.js';

const LIST_MORE_ACTIONS_TRANSLATION_KEY = 'happier.plugin-ui.list.moreActions';

type ListBaseProps = Readonly<{
  /** Names the collection for assistive technology. */
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
  style?: HappierStyleProp;
  density?: 'compact' | 'regular';
}>;

/** A selectable virtualized List becomes an RNW listbox and must be named. */
type ListAccessibleNameProps =
  | Readonly<{
      accessibilityLabel: string;
      accessibilityLabelKey?: string;
    }>
  | Readonly<{
      accessibilityLabel?: string;
      accessibilityLabelKey: string;
    }>;

type ListSearchBaseProps<Item> = Readonly<{
  /** Visible and assistive-technology name for List's owned search input. */
  label: string;
  placeholder?: string;
  testID?: string;
  /** Decides whether one author item stays in the virtualized data window. */
  filter: (item: Item, query: string) => boolean;
  /** IME draft text, or `null` once that draft has settled. */
  onComposingValueChange?: (value: string | null) => void;
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
   * Whether a row has the collection's primary open/select action.
   *
   * This is distinct from multi-selection eligibility: a grid may contain a
   * stated continuation or placeholder row whose own sibling button remains
   * actionable while the row itself must not become a dead primary button.
   * Such rows are skipped by the collection's roving primary-action cursor.
   * In a listbox, where sibling actions are not permitted, a non-activatable
   * row is exposed as a disabled option.
   */
  isItemActivatable?: (item: Item, index: number) => boolean;
  /**
   * Marks a row the author renders disabled, so keyboard navigation steps over
   * it. Only this List sees the rows its virtualizer has not mounted, so the
   * predicate — not each rendered row — is what makes arrow keys agree with
   * what a reader can actually choose.
   */
  isItemDisabled?: (item: Item, index: number) => boolean;
  /**
   * Observes the logical focus cursor, which is not the selection: navigation
   * traversal moves focus alone, explicit single-choice traversal chooses too, and a
   * background refresh moves neither. This List owns the movement — only it can
   * see the rows its virtualizer has not mounted — so an author who needs to
   * know where the reader is reads it here rather than keeping a second cursor.
   */
  onFocusedKeyChange?: (key: string) => void;
  /**
   * Requests that this List reveal a row, make it the roving tab stop, and move
   * physical focus to its mounted target. A new request object represents a new
   * request even when the key is unchanged, such as repeatedly dismissing the
   * same row's detail surface.
   *
   * The author chooses only the key. Reveal, virtualizer positioning and the
   * eventual physical focus remain owned by List.
   */
  focusRequest?: Readonly<{ key: string }>;
}>;

/** A controlled choice, independent of row opening and the logical focus cursor. */
export type ListSingleChoiceCapabilityProps<Item = unknown> = Readonly<{
  value: string | null;
  onValueChange: (key: string) => void;
  isItemSelectable?: (item: Item, index: number) => boolean;
  unavailableReason?: (item: Item, index: number) => string | null;
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
  /**
   * Keys that stay eligible while the author's own rows do not contain them.
   *
   * The List already keeps a selection through ITS OWN search, because it can
   * see the unfiltered dataset the author handed it. A list whose rows are
   * narrowed by an owner OUTSIDE it — Triage's corpus walk matches the query
   * before a row is ever published — hands over an already-narrowed dataset, so
   * that same retention is invisible here and typing silently drops rows the
   * reader chose. Naming those keys is how such an author says "hidden, not
   * gone".
   *
   * It answers HIDDEN, never SELECTABLE: a key the author's own
   * `isItemSelectable` excludes while its row IS present stays excluded, so a
   * continuation or placeholder row cannot be admitted into a bulk action by
   * being named here.
   */
  retainedSelectionKeys?: readonly ListMultiSelectionKey[];
}>;

/** Navigation selection or an explicit controlled single-choice capability. */
export type ListSelectionProps<Item = unknown> = ListSelectionBaseProps<Item> & (
  | Readonly<{
      single: ListSingleChoiceCapabilityProps<Item>;
      multiple?: never;
      selectedKey?: never;
      defaultSelectedKey?: never;
      onSelectedKeyChange?: never;
    }>
  | (Readonly<{
      single?: never;
      /** Bulk choice stays independent of the row whose detail is open. */
      multiple?: ListMultiSelectionCapabilityProps<Item>;
    }> & (
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
    ))
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
  /** A quiet, tabular count beside the title. */
  count?: number;
  /** What the group's rows share ("You act next"), quiet at the header's end. */
  description?: string;
  data: readonly Item[];
}>;

type VirtualizedListSectionMetadata = Readonly<{
  key: string;
  title: string;
  count?: number;
  description?: string;
  authorKey: string;
}>;

type VirtualizedListSectionData<Item> = ReactNativeSectionListData<Item, VirtualizedListSectionMetadata>;

type VirtualizedListSharedProps<Item> = Readonly<{
  /** Replace platform rendering only; List keeps selection, focus and viewport custody. */
  virtualizer?: CollectionVirtualizer;
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
  /** Content shown beside the collection when it has no rows. */
  empty?: ReactNode;
  /** Fixed content below the collection; it does not scroll with the rows. */
  footer?: ReactNode;
  /** Additive container layout for a virtualized collection. */
  contentContainerStyle?: HappierStyleProp;
  /**
   * Keep the first previously visible keyed row at the same viewport offset
   * when this collection receives a pure prepend. Native delegates to the
   * platform virtualizer; RNW uses the real scroll/content metrics from this
   * same List owner.
   */
  preserveVisibleContentPositionOnPrepend?: boolean;
  /**
   * Keep retained content inside one stable keyed row at the same viewport
   * offset when an author inserts content before it inside that row.
   *
   * Change `revision` only for the insertion that names `anchorKey`. List then
   * owns the platform scroll correction from its real content metrics. This is
   * deliberately distinct from a top-level prepend: the virtualizer cannot see
   * an insertion inside an otherwise unchanged row key.
   */
  preserveVisibleContentPositionOnInsert?: Readonly<{
    anchorKey: string;
    revision: string | number;
  }>;
  children?: never;
}>;

type NonSelectableVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
  selection?: undefined;
  /**
   * Content at the end of the collection that scrolls WITH the rows, unlike
   * `footer`. It reaches the platform's own end slot, so a long trailing
   * region — a second settings section under a list, for example — is
   * reachable without nesting a second scroller inside this one.
   *
   * It is deliberately absent from the selectable arms: a `listbox` or `grid`
   * owns options and rows, and has no honest cell for author content, while a
   * `list` admits it through the `listitem` its role permits. When the
   * collection is empty the `empty` slot travels into the same region, so a
   * reader still meets "no rows" before whatever follows them.
   */
  endContent?: ReactNode;
}>;

type SelectableVirtualizedListProps<Item> = VirtualizedListSharedProps<Item>
  & ListAccessibleNameProps
  & Readonly<{
    endContent?: never;
    /** Makes one semantic List.Item per row an accessible selected collection row. */
    selection: ListSelectionProps<Item>;
    /**
     * Use `grid` when rows contain sibling actionable controls such as
     * secondary-action overflow buttons. A listbox may own only options/groups;
     * the grid pattern keeps List's roving focus and selection owner while
     * exposing row actions as real accessible buttons.
     */
    accessibilityPattern?: ListAccessibilityPattern;
  }>;

type FlatVirtualizedListProps<Item> = (
  | NonSelectableVirtualizedListProps<Item>
  | SelectableVirtualizedListProps<Item>
) & Readonly<{
  items: readonly Item[];
  sections?: never;
}>;

type SectionedVirtualizedListProps<Item> = (
  | NonSelectableVirtualizedListProps<Item>
  | SelectableVirtualizedListProps<Item>
) & Readonly<{
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
  endContent?: never;
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
 * Curated author row props. Theme, target size, secondary-action state and
 * ItemGroup indexing remain adapter-owned facts. Authors may place an
 * independently interactive accessory outside the primary row Pressable.
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
  /**
   * Optional line bounds for the three semantic text slots, off unless asked
   * for.
   *
   * A virtualized List with no fixed row height reveals an unmounted row by the
   * measured average (`onScrollToIndexFailed` below). A title free to grow to
   * any height makes that average describe no row in particular, so the reveal
   * lands short and the reader's scroll estimate drifts the further they page.
   * A collection that knows its rows should stay comparable bounds them here;
   * one that does not leaves them unbounded, exactly as before.
   */
  titleNumberOfLines?: number;
  subtitleNumberOfLines?: number;
  detailNumberOfLines?: number;
  icon?: ReactNode;
  accessory?: ReactNode;
  /**
   * Keep an independently interactive accessory beside, rather than inside,
   * the row's primary Pressable. Use this for buttons, toggles, and compound
   * controls; decorative or passive trailing content stays inside by default.
   * Selectable grids enforce this structure automatically for every accessory
   * so an omitted advisory prop cannot create nested interactive markup.
   */
  accessoryOutsidePressable?: boolean;
  /**
   * Let the accessory take its own line rather than starve the row's text.
   *
   * A row whose accessory is a small trailing affordance wants the default: one
   * line, and the text column shrinks. A row whose accessory is a set of real
   * controls wants this: at a narrow width, the reader's largest type size or a
   * long localization, the controls move below the text instead of squeezing it
   * out. Placement mirrors under RTL; render, focus and announcement order never
   * do.
   */
  accessoryWraps?: boolean;
  tone?: HappierTone;
  /**
   * Colour for the trailing `detail` when it is the row's one loud fact — an
   * attention reason or a presence problem. Omitted, the detail stays quiet.
   */
  detailTone?: HappierTone;
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
  /**
   * Opens the row in place: `expandedContent` shows under the row's text while `expanded` is true, and the
   * row lifts (the one raised object in the list). Use it for what a row is to the reader, a few calm facts
   * and the row's own actions at the bottom, never for a page. The row's press is yours: toggle `expanded`
   * in `onPress`; the row states its expanded state to assistive technology. Motion and reduced motion
   * are the host's (the same disclosure as the Collection peek).
   */
  expanded?: boolean;
  expandedContent?: ReactNode;
}> & ItemSecondaryActionsProps;
export type ListItemProps = ItemProps;

type ListItemSelectionDisposition = 'open' | 'handled';

export type ListAccessibilityPattern = 'listbox' | 'grid';
type ListRowAccessibilityPattern = ListAccessibilityPattern | 'radiogroup';

export type ListItemSelectionContextValue = Readonly<{
  itemKey: string;
  multiSelectable: boolean;
  selected: boolean;
  activatable: boolean;
  /** The activation event carries the modifier keys one press means something by. */
  select: (event?: HappierGestureResponderEvent) => ListItemSelectionDisposition;
  positionInSet: number;
  setSize: number;
  roving: HappierRovingCollectionItem;
  accessibilityPattern: ListRowAccessibilityPattern;
  unavailableReason?: string | null;
  /** Grid rows use collection-wide ARIA/native positions; listbox rows use set positions. */
  rowIndex: number;
  rowCount: number;
}>;

export const ListItemSelectionContext = createContext<ListItemSelectionContextValue | null>(null);

type VirtualizedListRowProps<Item> = Readonly<{
  item: Item;
  /** Position in the collection-wide traversal order, which keyboard navigation addresses. */
  rowIndex: number;
  /** Grid-only semantic position; keyboard traversal remains data-row based. */
  accessibilityRowIndex: number;
  /** Position within the row's own collection unit, which authors and readers see. */
  index: number;
  itemKey: string;
  sectionKey: string | null;
  setSize: number;
  /** Total grid rows, including section header rows in the sectioned arm. */
  collectionSize: number;
  renderItem: (item: Item, index: number, sectionKey: string | null) => ReactNode;
  selectionEnabled: boolean;
  multiSelectable: boolean;
  activatable: boolean;
  selected: boolean;
  /** The single selected key's row (the open detail), whatever `selected` means with a bulk set mounted. */
  open: boolean;
  /**
   * Resolved per row rather than passed as the collection's tab-stop index, so
   * moving the stop commits only the two rows whose tab order actually changed
   * instead of every mounted row.
   */
  isTabStop: boolean;
  onSelect: (key: string, event?: HappierGestureResponderEvent) => ListItemSelectionDisposition;
  onFocus: (key: string) => void;
  onRovingKey: (index: number, key: string, event: unknown) => boolean;
  registerTarget: (key: string, target: HappierFocusable | null) => void;
  accessibilityPattern: ListRowAccessibilityPattern;
  unavailableReason?: string | null;
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
          itemKey: props.itemKey,
          multiSelectable: props.multiSelectable,
          selected: props.selected,
          activatable: props.activatable,
          select: (event) => props.onSelect(props.itemKey, event),
          positionInSet: props.index + 1,
          setSize: props.setSize,
          roving: {
            isTabStop: props.isTabStop,
            onFocus: () => props.onFocus(props.itemKey),
            onKeyDown: (key, event) => props.onRovingKey(props.rowIndex, key, event),
            register: (target) => props.registerTarget(props.itemKey, target),
          },
          accessibilityPattern: props.accessibilityPattern,
          unavailableReason: props.unavailableReason,
          rowIndex: props.accessibilityRowIndex,
          rowCount: props.accessibilityPattern === 'grid' ? props.collectionSize : props.setSize,
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
      : (
        <HappierListRowOpenContext.Provider value={props.open}>
          <ListItemSelectionContext.Provider value={selection}>{row}</ListItemSelectionContext.Provider>
        </HappierListRowOpenContext.Provider>
      );
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

/**
 * Gives the native virtualizer a bounded viewport through List's own box.
 * `minHeight: 0` lets this flex child shrink below its content height instead
 * of expanding its ancestors into an unbounded page-sized scroller.
 */
/** A list whose rows scroll with the page sizes to its content instead of filling its container. */
const pageScrollListBoxStyle: HappierPortableStyle = { minWidth: 0 };

const virtualizedListBoxStyle: HappierPortableStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

export function useRowFocusRequest(): RowFocusRequest {
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
  const listRootRef = useRef<View | null>(null);
  const collectionControl = useContext(ListCollectionControlContext);
  // Density changes only the spacing between authored rows. It does not select
  // a separate item implementation or carry core row policy into the public
  // component surface.
  const densityStyle: HappierPortableStyle = props.density === 'compact' ? { gap: 4 } : { gap: 8 };
  const { query, control: searchControl } = useListCollectionSearch(props.search, listRootRef);
  const filter = props.search?.filter;
  const keyForItem = props.keyForItem;
  const [authorItems, authorSections] = useMemo(() => {
    const items = props.items;
    const sections = props.sections;
    // The Collection model's identity rule: keys are unique across the whole List.
    admitHappierCollectionKeys(
      sections !== undefined
        ? sections.flatMap((section) => section.data.map((item, index) => keyForItem(item, index)))
        : (items ?? []).map((item, index) => keyForItem(item, index)),
      'List rows',
    );
    return [items, sections] as const;
  }, [keyForItem, props.items, props.sections]);
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
    admitHappierCollectionKeys(authorSections.map((section) => section.key), 'List sections');
    // The Collection model's narrowing rule (see the comment above).
    return narrowHappierCollectionGroups(
      authorSections,
      (section) => section.data,
      (section, data) => ({ ...section, data }),
      query === '' || filter === undefined ? undefined : (item: Item) => filter(item, query),
    );
  }, [authorSections, filter, query]);
  const virtualizedSections = useMemo<readonly VirtualizedListSectionData<Item>[]>(() => (
    (visibleSections ?? []).map((section) => ({
      ...section,
      authorKey: section.key,
      key: encodeHappierSectionCellKey(section.key),
    }))
  ), [visibleSections]);

  // ONE flattened traversal order for both arms. The roving tab stop, arrow
  // movement and pending focus all address a row by its position here, so a
  // section boundary never becomes a second navigation owner.
  const rows = useMemo<readonly ListRow<Item>[]>(() => {
    return visibleSections !== undefined
      ? visibleSections.flatMap((section, sectionIndex) => section.data.map((item, index) => ({
        item,
        key: keyForItem(item, index),
        index,
        setSize: section.data.length,
        sectionKey: section.key,
        sectionIndex,
      })))
      : (visibleItems ?? []).map((item, index) => ({
          item,
          key: keyForItem(item, index),
          index,
          setSize: visibleItems?.length ?? 0,
          sectionKey: null,
          sectionIndex: -1,
        }));
  }, [keyForItem, visibleItems, visibleSections]);
  // One keyed lookup replaces the per-fact linear scans selection, focus and
  // the pending-focus prune would each otherwise run over the whole array.
  const rowIndexByKey = useMemo(() => {
    const indexes = new Map<string, number>();
    rows.forEach((row, rowIndex) => {
      indexes.set(row.key, rowIndex);
    });
    return indexes;
  }, [rows]);
  const sectionRowOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = 0;
    for (const section of virtualizedSections ?? []) {
      offsets.set(section.key, offset);
      offset += section.data.length;
    }
    return offsets;
  }, [virtualizedSections]);
  const sectionGridRowOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = 0;
    for (const section of virtualizedSections ?? []) {
      offsets.set(section.key, offset);
      // A section header is a real row in the grid projection.
      offset += 1 + section.data.length;
    }
    return offsets;
  }, [virtualizedSections]);

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
  const retainedSelectionKeys = multiCapability?.retainedSelectionKeys;
  const eligibleSelectionKeys = useMemo(() => {
    if (multiStore === null) return [];
    const authorRows = authorSections !== undefined
      ? authorSections.flatMap((section) => section.data.map((item, index) => ({ item, index })))
      : (authorItems ?? []).map((item, index) => ({ item, index }));
    const present = new Set<string>();
    const eligible: string[] = [];
    for (const entry of authorRows) {
      const key = keyForItem(entry.item, entry.index);
      present.add(key);
      if (isItemSelectable?.(entry.item, entry.index) !== false) eligible.push(key);
    }
    // A retained key is only ever about a row that is NOT here. One whose row
    // IS present has already been judged by the author's own predicate, and
    // re-admitting it would let retention override an explicit exclusion.
    for (const key of retainedSelectionKeys ?? []) {
      if (!present.has(key)) eligible.push(key);
    }
    return eligible;
  }, [authorItems, authorSections, isItemSelectable, keyForItem, multiStore, retainedSelectionKeys]);
  useEffect(() => {
    if (collectionControl?.ownsSelectionRows) return;
    multiStore?.setVisibleRows({
      visibleOrderedKeys: visibleSelectionKeys,
      eligibleKeys: eligibleSelectionKeys,
    });
  }, [collectionControl?.ownsSelectionRows, eligibleSelectionKeys, multiStore, visibleSelectionKeys]);

  const [uncontrolledSelectedKey, setUncontrolledSelectedKey] = useState<string | null>(
    props.selection?.defaultSelectedKey ?? null,
  );
  const singleChoice = props.selection?.single;
  const singleChoiceRef = useRef(singleChoice);
  singleChoiceRef.current = singleChoice;
  const controlledSelectedKey = singleChoice === undefined ? props.selection?.selectedKey : singleChoice.value;
  const selectedKey = controlledSelectedKey === undefined ? uncontrolledSelectedKey : controlledSelectedKey;
  const selectionIsControlled = controlledSelectedKey !== undefined;
  const selectionEnabled = props.selection !== undefined;
  // Logical focus is its own fact. Keyboard navigation moves it alone, so a
  // reader can traverse a 2,000-row listbox without committing a selection the
  // rest of the surface would immediately act on, and a background refresh,
  // scan arrival or watch update moves neither.
  const [localFocusedKey, setFocusedKey] = useState<string | null>(null);
  const focusedKey = collectionControl?.focus === undefined ? localFocusedKey : collectionControl.focus.key;
  const lastReportedFocus = useRef<string | null>(null);
  // One owner for "focus moved", so both movement paths report the same fact
  // and neither reads the author's callback through a memoized closure that an
  // inline arrow would invalidate on every render.
  const requestFocus = (key: string) => {
    if (collectionControl?.focus === undefined) setFocusedKey(key);
    // One cursor, reported twice: the store's focus is what a bulk-action bar
    // and a row checkbox read, and letting it drift from the List's own focus
    // would be the second cursor this capability exists to avoid.
    multiStoreRef.current?.setFocusedKey(key);
    if (lastReportedFocus.current !== key) {
      lastReportedFocus.current = key;
      props.selection?.onFocusedKeyChange?.(key);
    }
  };
  const requestFocusRef = useRef(requestFocus);
  requestFocusRef.current = requestFocus;
  const requestSelection = (key: string) => {
    if (key === selectedKey) return;
    if (!selectionIsControlled) setUncontrolledSelectedKey(key);
    if (singleChoice !== undefined) singleChoice.onValueChange(key);
    else props.selection?.onSelectedKeyChange?.(key);
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
  const observesCollectionFocus = useRef(false);
  observesCollectionFocus.current = collectionControl?.focus !== undefined;
  const observeFocus = useCallback((key: string) => {
    if (!observesCollectionFocus.current) return;
    rowFocusRequest.abandon();
    requestFocusRef.current(key);
  }, [rowFocusRequest]);

  // Pointer and touch activation is one gesture that both focuses and selects;
  // only the keyboard separates the two. The gesture has already placed native
  // focus on the row it landed on, so it also RETIRES any request still waiting
  // for a reveal — otherwise that row's later registration pulls focus off the
  // row the reader just chose, one or more frames after the interaction.
  const selectItem = useCallback((
    key: string,
    event?: HappierGestureResponderEvent,
  ): ListItemSelectionDisposition => {
    rowFocusRequest.abandon();
    if (singleChoiceRef.current !== undefined) {
      requestFocusRef.current(key);
      requestSelectionRef.current(key);
      return 'handled';
    }
    return activateListItem({ key, event, store: multiStoreRef.current,
      focus: requestFocusRef.current, open: requestSelectionRef.current });
  }, [rowFocusRequest]);
  // ---- Collection keyboard navigation -------------------------------------
  // A listbox is one composite widget, so it owns a single roving tab stop and
  // arrow/Home/End movement over the WHOLE filtered array. Only this owner can
  // do that: a row cannot reach the rows the virtualizer has not mounted. The
  // navigation rule itself stays in the shared collection semantics owner, the
  // same one HappierItemGroup's radio groups use.
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const isItemDisabled = props.selection?.isItemDisabled;
  const isSingleItemSelectable = singleChoice?.isItemSelectable;
  const isItemActivatable = props.selection?.isItemActivatable;
  const activatableRows = useMemo(
    () => rows.map((row) => isItemActivatable?.(row.item, row.index) !== false),
    [isItemActivatable, rows],
  );
  const rovingEntries = useMemo<readonly HappierRovingEntry[]>(
    () => rows.map((row, rowIndex) => ({
      disabled: isItemDisabled?.(row.item, row.index) === true
        || isSingleItemSelectable?.(row.item, row.index) === false
        || activatableRows[rowIndex] === false,
    })),
    [activatableRows, isItemDisabled, isSingleItemSelectable, rows],
  );
  // A range extension also respects bulk eligibility. Its traversal otherwise
  // shares the primary-action cursor, which already excludes action-only rows;
  // those rows remain readable and their sibling controls keep their own focus.
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
  const tabStopIndex = collectionControl?.focus === undefined ? resolveHappierRovingTabStop({
    entries: rovingEntries,
    selectedIndex: focusedIndex >= 0 && rovingEntries[focusedIndex]?.disabled !== true ? focusedIndex : selectedIndex,
  }) : rowIndexByKey.get(collectionControl.focus.tabStopKey ?? '') ?? -1;
  const tabStopIndexRef = useRef(tabStopIndex);
  tabStopIndexRef.current = tabStopIndex;

  const inheritedVirtualizer = useContext(CollectionVirtualizerContext);
  const hostVirtualizer = useOptionalPluginUiPresentationHost()?.collectionVirtualizer;
  const virtualizer = props.virtualizer ?? inheritedVirtualizer ?? hostVirtualizer ?? NATIVE_COLLECTION_VIRTUALIZER;
  const virtualizerHandle = useRef<CollectionVirtualizerHandle | null>(null);
  const onVirtualizerHandle = useCallback((handle: CollectionVirtualizerHandle | null) => {
    virtualizerHandle.current = handle;
  }, []);
  const previousRowKeysRef = useRef<readonly string[]>([]);
  const previousInsertAnchorRef = useRef<Readonly<{
    anchorKey: string;
    revision: string | number;
  }> | null>(null);
  const scrollOffsetRef = useRef(0);
  const collectionScrollOffsetRef = useRef<{ current: number } | null>(null);
  collectionScrollOffsetRef.current = collectionControl?.scroll?.offsetRef ?? null;
  const contentHeightRef = useRef<number | null>(null);
  const pendingContentPreservationRef = useRef<Readonly<{
    contentHeight: number;
    offset: number;
  }> | null>(null);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  useLayoutEffect(() => {
    const previous = previousRowKeysRef.current;
    previousRowKeysRef.current = rowKeys;
    const previousInsertAnchor = previousInsertAnchorRef.current;
    const insertAnchor = props.preserveVisibleContentPositionOnInsert ?? null;
    previousInsertAnchorRef.current = insertAnchor;
    const contentHeight = contentHeightRef.current;
    const insertedInsideStableAnchor = insertAnchor !== null
      && contentHeight !== null
      && previous.includes(insertAnchor.anchorKey)
      && rowKeys.includes(insertAnchor.anchorKey)
      && (previousInsertAnchor === null
        || previousInsertAnchor.anchorKey !== insertAnchor.anchorKey
        || !Object.is(previousInsertAnchor.revision, insertAnchor.revision));
    if (insertedInsideStableAnchor) {
      pendingContentPreservationRef.current = {
        contentHeight,
        offset: scrollOffsetRef.current,
      };
      return;
    }
    if (!props.preserveVisibleContentPositionOnPrepend || Platform.OS !== 'web') {
      pendingContentPreservationRef.current = null;
      return;
    }
    const prependedCount = rowKeys.length - previous.length;
    const purePrepend = previous.length > 0
      && prependedCount > 0
      && previous.every((key, index) => rowKeys[index + prependedCount] === key);
    pendingContentPreservationRef.current = purePrepend && contentHeight !== null
      ? { contentHeight, offset: scrollOffsetRef.current }
      : null;
  }, [
    props.preserveVisibleContentPositionOnInsert,
    props.preserveVisibleContentPositionOnPrepend,
    rowKeys,
  ]);
  const onCollectionScroll = useCallback((offset: number) => {
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return;
    scrollOffsetRef.current = offset;
    const observed = collectionScrollOffsetRef.current;
    if (observed !== null) observed.current = offset;
  }, []);
  const onCollectionContentSizeChange = useCallback((_width: number, height: number) => {
    const pending = pendingContentPreservationRef.current;
    pendingContentPreservationRef.current = null;
    contentHeightRef.current = height;
    if (pending === null || height <= pending.contentHeight) return;
    const offset = pending.offset + height - pending.contentHeight;
    scrollOffsetRef.current = offset;
    virtualizerHandle.current?.scrollToOffset(offset);
  }, []);
  const observeContentMetrics = props.preserveVisibleContentPositionOnInsert !== undefined
    || (props.preserveVisibleContentPositionOnPrepend === true && Platform.OS === 'web')
    || collectionControl?.scroll !== undefined;
  // A Collection's scroll request lands before paint, so a geometry change and the scroll that keeps its
  // anchored row in place are one frame.
  const collectionScrollRequest = collectionControl?.scroll?.request ?? null;
  useLayoutEffect(() => {
    if (collectionScrollRequest === null) return;
    const offset = collectionScrollRequest.offset;
    scrollOffsetRef.current = offset;
    const observed = collectionScrollOffsetRef.current;
    if (observed !== null) observed.current = offset;
    virtualizerHandle.current?.scrollToOffset(offset);
    // Only a new request scrolls; the sections changing under the same request do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionScrollRequest]);
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
      virtualizerHandle.current?.reveal({
        sectionIndex: row.sectionIndex,
        index: row.index,
      });
      return;
    }
    const list = virtualizerHandle.current;
    if (list === null) return;
    // Home and End land far outside the measured window, where `scrollToIndex`
    // has no frame to target; both ends are always reachable by offset.
    if (rowIndex === 0) list.scrollToOffset(0);
    else if (rowIndex === rows.length - 1) list.scrollToEnd();
    else list.reveal({ index: rowIndex });
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
  const requestRowFocusRef = useRef(requestRowFocus);
  requestRowFocusRef.current = requestRowFocus;
  const authorFocusRequest = collectionControl?.focus === undefined
    ? props.selection?.focusRequest : collectionControl.focus.request ?? undefined;
  const handledFocusRequest = useRef<typeof authorFocusRequest>(undefined);
  useEffect(() => {
    if (authorFocusRequest === undefined) return;
    if (handledFocusRequest.current === authorFocusRequest) return;
    const rowIndex = rowIndexByKey.get(authorFocusRequest.key);
    if (rowIndex === undefined) return;
    if (rovingEntries[rowIndex]?.disabled === true) return;
    handledFocusRequest.current = authorFocusRequest;
    requestFocusRef.current(authorFocusRequest.key);
    requestRowFocusRef.current(authorFocusRequest.key, rowIndex);
    collectionControl?.focus?.onRequestHandled?.(authorFocusRequest);
  }, [authorFocusRequest, rovingEntries]);
  const moveFocus = (fromIndex: number, key: string, event: unknown): boolean => {
    const currentRowIndex = focusedIndex >= 0 && rovingEntries[focusedIndex]?.disabled !== true ? focusedIndex : fromIndex;
    const controlledNavigation = collectionControl?.focus;
    if (controlledNavigation !== undefined) {
      const from = rows[currentRowIndex]?.key;
      if (from === undefined) return false;
      if (controlledNavigation.onKey?.(key, from, event)) return true;
      if (singleChoice === undefined) return collectionControl?.onRowKey?.(key, from) === true;
    }
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
            multiStoreForKey.selectRange(nextRow.key);
            requestFocusRef.current(nextRow.key);
            requestRowFocus(nextRow.key, intent.toIndex);
          }
        }
        return true;
      }
    }
    // A Collection presentation may claim a row key before navigation (the
    // table's Space peek); it names the row the reader is on, not the one the
    // event happened to reach.
    const rowKeyClaim = collectionControl?.onRowKey;
    const claimedRow = rows[currentRowIndex];
    if (rowKeyClaim !== undefined && claimedRow !== undefined && rowKeyClaim(key, claimedRow.key)) return true;
    // Activation stays with the shared row pressable. This owner claims only
    // collection navigation, so Space and Enter still select through the
    // author's row action rather than through a second activation path.
    if ((key === ' ' || key === 'Spacebar') && singleChoice === undefined) return false;
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
      listNavigationKeys: singleChoice === undefined,
    });
    if (next === null || (next === currentIndex && singleChoice === undefined)) return false;
    const nextRow = rows[next];
    if (nextRow === undefined) return false;
    const nextKey = nextRow.key;
    if (singleChoice !== undefined) requestSelectionRef.current(nextKey);
    // Navigation rows move focus alone; the explicit radio capability chooses
    // as it moves. Both use the same physical reveal and keyed focus lifecycle.
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
  const headerContent = collectionControl?.hideChrome ? authorHeader : (
    <ListCollectionHeader search={searchControl} store={multiStore} selectable={eligibleSelectionKeys.length > 0}>
      {authorHeader}
    </ListCollectionHeader>
  );
  // Chrome is a SIBLING of the collection element, never a cell inside it. A
  // listbox admits groups/options, grid admits rows, and list admits list items; a search
  // textbox, an author header or an empty-state block placed in the scroller
  // becomes an unpermitted child and invalidates the whole control for a
  // reader. The empty slot is a sibling for a second reason: the platform
  // section virtualizer counts a header cell per section, so its own empty slot
  // never fires for a sectioned collection.
  const emptyContent = rows.length === 0 ? props.empty : null;
  // `endContent` is a `list`-only affordance (see its prop documentation). An
  // untyped bundle that hands it to a selectable List keeps the fixed
  // placement below rather than invalidating the control for a reader.
  const scrollsEndContent = props.endContent !== undefined && !selectionEnabled;
  const collectionEndContent = scrollsEndContent ? (
    <View role="listitem">
      {emptyContent}
      {props.endContent}
    </View>
  ) : undefined;
  const renderItem = props.renderItem;
  const accessibilityPattern = singleChoice !== undefined ? 'radiogroup' : selectionEnabled ? props.accessibilityPattern ?? 'listbox' : 'listbox';
  const collectionRole = collectionControl?.collectionRole ?? (selectionEnabled
    ? accessibilityPattern
    : 'list');
  // One row projection for both arms. `rowIndex` is the collection-wide
  // navigation position; `index` and `setSize` stay unit-local, which is what a
  // reader hears and what the author's callbacks already receive.
  const renderRow = useCallback((input: Readonly<{
    item: Item;
    rowIndex: number;
    accessibilityRowIndex: number;
    index: number;
    setSize: number;
    collectionSize: number;
    sectionKey: string | null;
  }>) => {
    const itemKey = keyForItem(input.item, input.index);
    return (
      <VirtualizedListRow
        item={input.item}
        rowIndex={input.rowIndex}
        accessibilityRowIndex={input.accessibilityRowIndex}
        index={input.index}
        itemKey={itemKey}
        sectionKey={input.sectionKey}
        setSize={input.setSize}
        collectionSize={input.collectionSize}
        renderItem={renderItem}
        selectionEnabled={selectionEnabled}
        multiSelectable={multiStore !== null && multiRovingEntries[input.rowIndex]?.disabled === false}
        activatable={singleChoice === undefined ? activatableRows[input.rowIndex] !== false : rovingEntries[input.rowIndex]?.disabled === false}
        unavailableReason={singleChoice?.unavailableReason?.(input.item, input.index)}
        // With the capability mounted, `aria-selected` is the multi-selection —
        // the standard meaning in a multi-selectable listbox. The single key
        // stays the open detail and keeps owning the tab stop.
        selected={multiStore === null
          ? selectedKeyRef.current === itemKey
          : multiSelectedKeysRef.current.has(itemKey)}
        open={singleChoice === undefined && selectedKeyRef.current === itemKey}
        isTabStop={selectionEnabled && tabStopIndexRef.current === input.rowIndex}
        onSelect={selectItem}
        onFocus={observeFocus}
        onRovingKey={onRovingKey}
        registerTarget={registerTarget}
        accessibilityPattern={accessibilityPattern}
      />
    );
  }, [accessibilityPattern, activatableRows, keyForItem, multiRovingEntries, multiStore, observeFocus, onRovingKey, registerTarget, renderItem, rovingEntries, selectItem, selectionEnabled, singleChoice?.unavailableReason]);

  const flatSetSize = visibleItems?.length ?? 0;
  const renderFlatRow = useCallback(({ item, index }: Readonly<{ item: Item; index: number }>) => (
    renderRow({ item, rowIndex: index, accessibilityRowIndex: index, index, setSize: flatSetSize, collectionSize: flatSetSize, sectionKey: null })
  ), [flatSetSize, renderRow]);
  const renderSectionRow = useCallback(({ item, index, section }: Readonly<{
    item: Item;
    index: number;
    section: VirtualizedListSectionData<Item>;
  }>) => renderRow({
    item,
    rowIndex: (sectionRowOffsets.get(section.key) ?? 0) + index,
    accessibilityRowIndex: (sectionGridRowOffsets.get(section.key) ?? 0) + 1 + index,
    index,
    setSize: section.data.length,
    collectionSize: rows.length + (visibleSections?.length ?? 0),
    sectionKey: section.authorKey,
  }), [renderRow, rows.length, sectionGridRowOffsets, sectionRowOffsets, visibleSections?.length]);
  // A listbox that admits more than one chosen option has to say so. The
  // capability marks every chosen row `aria-selected`, and without this fact a
  // screen reader treats those as contradictory and announces the last one as
  // THE selection — while the bulk action still acts on the whole set. It is
  // present only while the capability is mounted, so an ordinary
  // single-selection list never claims a choice its reader cannot make.
  const collectionMultiSelectable = multiStore === null ? undefined : true;
  const collectionRowCount = visibleSections === undefined
    ? flatSetSize
    : rows.length + visibleSections.length;
  // `role="listbox"` is a React Native Web alias, and the selectable arm
  // deliberately withholds the native `list` role that would contradict its
  // `option` rows — so on Android a selectable list is not a collection at all
  // unless it states its extent here. React Native's Android view config accepts
  // `accessibilityCollection` while its published types omit it.
  //
  // The extent and the per-row `accessibilityCollectionItem` are ONE fact and
  // have to be counted over the same traversal. Grid rows use collection-wide
  // indices (including section headers), so the sectioned grid can publish the
  // same native extent as the flat grid. Listbox rows intentionally retain
  // section-local set positions, so that arm withholds a contradictory extent.
  const nativeCollection = Platform.OS === 'web'
    || !selectionEnabled
    || (visibleSections !== undefined && accessibilityPattern !== 'grid')
    ? undefined
    : { rowCount: collectionRowCount, columnCount: 1 };
  // The shared section owner, told which collection element the virtualizer
  // makes this header a direct child of. The rows are its siblings there, so
  // the header has to be a child that collection role actually permits.
  const sectionHeaderStyle = collectionControl?.sectionHeaderStyle;
  const wrapSectionHeader = collectionControl?.wrapSectionHeader;
  const sectionHeaderAction = collectionControl?.sectionHeaderAction;
  // A page-sized collection whose rows scroll with the page: every row mounts, and the list does not scroll.
  const pageScroll = collectionControl?.pageScroll === true;
  const pageSheet = pageScroll ? collectionControl?.pageSheet : undefined;

  const renderSectionHeader = useCallback(({ section }: Readonly<{ section: VirtualizedListSectionData<Item> }>) => {
    const header = (
      <HappierListSection
        title={section.title}
        {...(section.count === undefined ? {} : { count: section.count })}
        {...(section.description === undefined ? {} : { description: section.description })}
        {...(sectionHeaderStyle === undefined ? {} : { style: sectionHeaderStyle })}
        {...(collectionControl?.sectionHeaderTitleRole === undefined ? {} : { titleRole: collectionControl.sectionHeaderTitleRole })}
        {...(sectionHeaderAction === undefined ? {} : { action: sectionHeaderAction(section.authorKey) })}
        virtualizedCollectionRole={collectionRole}
        {...(collectionRole === 'grid'
          ? {
              accessibilityRowIndex: (sectionGridRowOffsets.get(section.key) ?? 0) + 1,
              accessibilityRowCount: collectionRowCount,
            }
          : {})}
      />
    );
    return wrapSectionHeader === undefined ? header : <>{wrapSectionHeader(section.authorKey, header)}</>;
  }, [collectionControl?.sectionHeaderTitleRole, collectionRole, collectionRowCount, sectionGridRowOffsets, sectionHeaderAction, sectionHeaderStyle, wrapSectionHeader]);

  // Both facts reach the mounted cells: the tab stop follows focus, so a
  // focus-only move must still commit the two rows whose tab order changed.
  const extraData = useMemo(() => selectionEnabled
    ? Object.freeze({
        selectedKey,
        focusedKey,
        multiSelectionVersion: multiStore === null ? null : multiSnapshot.version,
      })
    : undefined, [focusedKey, multiSnapshot.version, multiStore, selectedKey, selectionEnabled]);

  const renderVirtualizedItem = useCallback((item: Item, index: number, sectionIndex: number | null) => {
    if (sectionIndex === null) return renderFlatRow({ item, index });
    const section = virtualizedSections[sectionIndex];
    return section === undefined ? null : renderSectionRow({ item, index, section });
  }, [renderFlatRow, renderSectionRow, virtualizedSections]);
  const renderVirtualizedSectionHeader = useCallback((sectionIndex: number) => {
    const section = virtualizedSections[sectionIndex];
    return section === undefined ? null : renderSectionHeader({ section });
  }, [renderSectionHeader, virtualizedSections]);

  // A page-sized collection is not virtualized: the same headers and rows, every one mounted, in the same
  // collection element, scrolling with the page around it (no reveal is needed: every row is on the page).
  const collection = pageScroll ? (
    <View
      accessibilityRole={collectionRole === 'radiogroup' ? 'radiogroup' : selectionEnabled ? undefined : 'list'}
      // @ts-expect-error React Native's role union omits RNW's standard listbox role.
      role={collectionRole}
      aria-rowcount={collectionRole === 'grid' ? collectionRowCount : undefined}
      aria-multiselectable={collectionMultiSelectable}
      accessibilityCollection={nativeCollection}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[props.style, densityStyle, props.contentContainerStyle]}
    >
      {virtualizedSections !== undefined && visibleSections !== undefined
        ? virtualizedSections.map((section) => {
            const sectionRows = section.data.map((item, index) => (
              <Fragment key={encodeHappierSectionRowCellKey(keyForItem(item, index))}>
                {renderSectionRow({ item, index, section })}
              </Fragment>
            ));
            return (
              <Fragment key={section.key}>
                {renderSectionHeader({ section })}
                {pageSheet === undefined ? sectionRows : (
                  // The rows' own hairlines divide them; the sheet only draws its ground and edge. One plain
                  // child keeps the sheet from re-keying the rows it would otherwise flatten.
                  <HappierPageSheet colors={pageSheet.colors} rowDividers={false}><View>{sectionRows}</View></HappierPageSheet>
                )}
              </Fragment>
            );
          })
        : (visibleItems ?? []).map((item, index) => (
            <Fragment key={keyForItem(item, index)}>{renderFlatRow({ item, index })}</Fragment>
          ))}
      {collectionEndContent}
    </View>
  ) : virtualizer.render({
    ...(visibleSections === undefined
      ? { kind: 'flat', items: visibleItems ?? [] } as const
      : { kind: 'sections', sections: virtualizedSections, renderSectionHeader: renderVirtualizedSectionHeader } as const),
    keyForItem: visibleSections === undefined ? keyForItem
      : (item, index) => encodeHappierSectionRowCellKey(keyForItem(item, index)),
    renderItem: renderVirtualizedItem,
    onHandle: onVirtualizerHandle,
    accessibilityRole: collectionRole === 'radiogroup' ? 'radiogroup' : selectionEnabled ? undefined : 'list',
    role: collectionRole,
    rowCount: collectionRole === 'grid' ? collectionRowCount : undefined,
    multiSelectable: collectionMultiSelectable,
    nativeCollection,
    accessibilityLabel: props.accessibilityLabel,
    testID: props.testID,
    style: props.style,
    contentContainerStyle: [densityStyle, props.contentContainerStyle],
    extraData,
    endContent: collectionEndContent,
    preserveVisibleContentPositionOnPrepend: props.preserveVisibleContentPositionOnPrepend,
    onScroll: observeContentMetrics ? onCollectionScroll : undefined,
    onContentSizeChange: observeContentMetrics ? onCollectionContentSizeChange : undefined,
  });

  // One box around the collection and its chrome. It is unconditional so that
  // gaining or losing chrome never changes the React tree shape around the
  // virtualizer, which would remount it and throw away its scroll position.
  // The provider is UNCONDITIONAL for the same reason the box is: a tree shape
  // that changed with the capability would remount the virtualizer and throw
  // away its scroll position. It publishes the store to the rows, to an author's
  // own row affordance, and to `List.SelectionActionBar` in the footer.
  return (
    <ListMultiSelectionProvider store={multiStore}>
      <View ref={listRootRef} style={pageScroll ? pageScrollListBoxStyle : virtualizedListBoxStyle}>
        {headerContent}
        {collection}
        {scrollsEndContent ? null : emptyContent}
        {scrollsEndContent ? null : props.endContent}
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
  if (isVirtualizedList(props)) {
    if (
      props.selection !== undefined
      && (typeof resolvedAccessibilityLabel !== 'string' || resolvedAccessibilityLabel.trim().length === 0)
    ) {
      throw new Error('Selectable List requires a non-empty accessible name.');
    }
    const resolvedProps = { ...rest, accessibilityLabel: resolvedAccessibilityLabel } as ListBaseProps & VirtualizedListProps<Item>;
    return <VirtualizedList {...resolvedProps} />;
  }
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
  props: ItemProps & Readonly<{
    rovingCollectionItem?: HappierRovingCollectionItem;
    accessibilityRowIndex?: number;
    accessibilityRowCount?: number;
  }>,
  defaultSecondaryActionAccessibilityLabel: string,
  suppressListItemRole = false,
  secondaryActionsControl?: Readonly<{
    open: boolean;
    onOpenChange(open: boolean): void;
    focusReturnRef: RefObject<unknown>;
    onContextMenu(event: unknown): void;
  }>,
): ReactElement {
  const {
    secondaryActions,
    secondaryActionAccessibilityLabel,
    onSecondaryAction,
    accessory,
    accessoryOutsidePressable,
    ...item
  } = props;
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
      {...(secondaryActionsControl === undefined ? {} : {
        open: secondaryActionsControl.open,
        onOpenChange: secondaryActionsControl.onOpenChange,
        focusReturnRef: secondaryActionsControl.focusReturnRef,
      })}
      renderMenu={(input) => (
        <ContextMenu
          open={input.open}
          onOpenChange={input.onOpenChange}
          trigger={input.trigger}
          triggerIcon="more"
          triggerAccessibilityLabel={input.triggerAccessibilityLabel}
          testID={input.testID}
          disabled={input.disabled}
          triggerTabIndex={input.triggerTabIndex}
          focusReturnRef={input.focusReturnRef}
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
      onContextMenu={secondaryActionsControl?.onContextMenu}
      accessory={composedAccessory}
      hasSecondaryActions={hasSecondaryActions}
      accessoryOutsidePressable={hasSecondaryActions || accessoryOutsidePressable === true}
      suppressListItemRole={suppressListItemRole}
    />
  );
}

/**
 * A row that opens in place (plugin tabs round 2, XP / PP): the disclosure owner shared with the
 * Collection peek and the host's `ExpandableItem`, with the host's motion. The body sits under the row's
 * text column; while open, the row lifts.
 */
const EXPANDED_BODY_GLYPH_COLUMN_PX = 20;

function ListItemExpansion(props: Readonly<{
  expanded: boolean;
  hasIcon: boolean;
  row: ReactElement;
  children: ReactNode;
  testID?: string;
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  const motion = host?.disclosureMotion ?? HAPPIER_INSTANT_DISCLOSURE_MOTION;
  const inset = theme.spacing.medium + (props.hasIcon ? EXPANDED_BODY_GLYPH_COLUMN_PX + theme.spacing.small : 0);
  return (
    <View
      style={resolveHappierDisclosureFrameStyle({
        expanded: props.expanded,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.elevatedSurface,
      })}
    >
      <HappierDisclosure
        expanded={props.expanded}
        onExpandedChange={noopExpandedChange}
        header={props.row}
        showDivider={false}
        reducedMotion={reducedMotion || host?.disclosureMotion === undefined}
        motion={motion}
        {...(props.testID === undefined ? {} : { testID: `${props.testID}:expanded` })}
      >
        <View style={{ paddingLeft: inset, paddingRight: theme.spacing.medium, paddingBottom: theme.spacing.medium }}>
          {props.children}
        </View>
      </HappierDisclosure>
    </View>
  );
}

function noopExpandedChange(): void {
  // The row's own press toggles `expanded`; the disclosure's header is the row itself.
}

function ListItem(props: ListItemProps): ReactElement {
  const { expanded, expandedContent, ...rowProps } = props;
  if (expandedContent === undefined) return <ListItemRow {...rowProps} />;
  const open = expanded === true;
  return (
    <ListItemExpansion
      expanded={open}
      hasIcon={rowProps.icon !== undefined && rowProps.icon !== null}
      row={<ListItemRow {...rowProps} accessibilityExpanded={open} />}
      {...(rowProps.testID === undefined ? {} : { testID: rowProps.testID })}
    >
      {expandedContent}
    </ListItemExpansion>
  );
}

function ListItemRow(props: ListItemProps): ReactElement {
  const translate = usePluginTranslation();
  const selection = useContext(ListItemSelectionContext);
  const multiStore = useOptionalListMultiSelectionStore();
  const [secondaryActionsOpen, setSecondaryActionsOpen] = useState(false);
  const rowFocusRef = useRef<HappierFocusable | null>(null);
  const defaultSecondaryActionAccessibilityLabel = translate(LIST_MORE_ACTIONS_TRANSLATION_KEY, 'More actions');
  const { accessibilityLabelKey, accessibilityHintKey, ...authorProps } = props;
  const canSelectRow = selection?.activatable === true && selection.multiSelectable;
  const selectActionId = 'selection.select';
  const resolvedProps = {
    ...authorProps,
    accessibilityLabel: resolveAuthorText(translate, props.accessibilityLabel, accessibilityLabelKey),
    accessibilityHint: resolveAuthorText(translate, props.accessibilityHint, accessibilityHintKey),
    ...(canSelectRow ? {
      secondaryActions: props.secondaryActions?.some((action) => action.id === selectActionId)
        ? props.secondaryActions
        : [...(props.secondaryActions ?? []), {
            id: selectActionId,
            label: translate('happier.plugin-ui.list.selectItems', 'Select'),
          }],
      onSecondaryAction: (id: string) => {
        if (id === selectActionId) multiStore?.replaceWith(selection.itemKey);
        else props.onSecondaryAction?.(id);
      },
    } : {}),
  } as ListItemProps;
  const hasSecondaryActions = resolvedProps.secondaryActions !== undefined
    && resolvedProps.secondaryActions.length > 0
    && resolvedProps.onSecondaryAction !== undefined;
  const secondaryActionsEnabled = resolveHappierItemBehavior({
    disabled: resolvedProps.disabled,
    busy: resolvedProps.busy,
    hasPrimaryAction: resolvedProps.onPress !== undefined,
    hasSecondaryActions,
  }).secondaryActionsEnabled
    && resolvedProps.secondaryActions?.some((action) => action.disabled !== true) === true;
  const openSecondaryActionsFromContext = useCallback((event: unknown) => {
    if (!secondaryActionsEnabled) return;
    const candidate = event as Readonly<{
      preventDefault?: () => void;
      stopPropagation?: () => void;
    }>;
    candidate.preventDefault?.();
    candidate.stopPropagation?.();
    setSecondaryActionsOpen(true);
  }, [secondaryActionsEnabled]);
  if (selection === null) return renderListItem(resolvedProps, defaultSecondaryActionAccessibilityLabel);
  // A grid row's controls are sibling cells by contract. Keeping this at the
  // collection owner prevents an author from accidentally nesting an
  // interactive accessory (Button, toggle, overflow trigger) inside the
  // primary row Pressable merely because they omitted an advisory layout prop.
  // Passive accessories may live in their own cell as well; that structural
  // consistency is preferable to guessing whether an arbitrary ReactNode is
  // interactive.
  const gridResolvedProps = selection.accessibilityPattern === 'grid'
    && resolvedProps.accessory !== undefined
    && resolvedProps.accessory !== null
    ? { ...resolvedProps, accessoryOutsidePressable: true }
    : resolvedProps;
  const rovingCollectionItem: HappierRovingCollectionItem = {
    ...selection.roving,
    register: (target) => {
      rowFocusRef.current = target;
      selection.roving.register(target);
    },
    onKeyDown: (key, event) => {
      const opensSecondaryActions = key === 'ContextMenu'
        || (key === 'F10' && readHappierPointerModifiers(event).shiftKey);
      if (opensSecondaryActions && secondaryActionsEnabled) {
        setSecondaryActionsOpen(true);
        return true;
      }
      return selection.roving.onKeyDown(key, event);
    },
  };
  const collectionOnPress = selection.activatable
    ? (event?: HappierGestureResponderEvent) => {
        const disposition = selection.select(event);
        return disposition === 'open' ? props.onPress?.(event) : undefined;
      }
    // A listbox has options rather than sibling action cells. Preserve a
    // structural disabled option there; a grid can render a stated row with no
    // invented primary control at all.
    : selection.accessibilityPattern !== 'grid'
      ? () => undefined
      : undefined;
  return renderListItem({
    ...gridResolvedProps,
    selected: selection.selected,
    ...(selection.accessibilityPattern !== 'grid' && !selection.activatable
      ? { disabled: true }
      : {}),
    accessibilityRole: selection.accessibilityPattern === 'grid' ? 'button' : selection.accessibilityPattern === 'radiogroup' ? 'radio' : 'option',
    ...(selection.unavailableReason ? { accessibilityHint: selection.unavailableReason } : {}),
    accessibilityPositionInSet: selection.accessibilityPattern === 'grid' ? undefined : selection.positionInSet,
    accessibilitySetSize: selection.accessibilityPattern === 'grid' ? undefined : selection.setSize,
    accessibilityRowIndex: selection.accessibilityPattern === 'grid' ? selection.rowIndex + 1 : undefined,
    accessibilityRowCount: selection.accessibilityPattern === 'grid' ? selection.rowCount : undefined,
    ...(selection.activatable ? { rovingCollectionItem } : {}),
    ...(collectionOnPress === undefined ? {} : { onPress: collectionOnPress }),
  }, defaultSecondaryActionAccessibilityLabel, true, {
    open: secondaryActionsOpen,
    onOpenChange: setSecondaryActionsOpen,
    focusReturnRef: rowFocusRef,
    onContextMenu: openSecondaryActionsFromContext,
  });
}

/** Standalone semantic row; identical owner and behavior to `List.Item`. */
export function Item(props: ListItemProps): ReactElement {
  return <ListItem {...props} />;
}

export type ItemGroupProps = Readonly<{
  children?: ReactNode;
  /**
   * The section's sentence-case title. A titled group is a page section: its
   * title and description sit above one hairline sheet whose rows are divided
   * by full-width hairlines, exactly like Happier's own settings sections.
   */
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** What this section is about, read before its rows (never a footer under them). */
  description?: string;
  descriptionKey?: string;
  /** One compact section-level action ("Add", "Check now"), aligned with the title. */
  action?: ReactNode;
  /**
   * `sheet` draws the rows on the section's sheet; `none` lays them on the page
   * with the same insets and no sheet (a section whose content is its own
   * surface). Omitted, a titled section draws the sheet and an untitled group
   * stays a semantic group with no chrome.
   */
  surface?: 'sheet' | 'none';
  accessibilityRole?: 'radiogroup';
  /** The group's accessible name; a titled section defaults to its title. */
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

/**
 * A group of rows. Given a title (or an explicit `surface`) it is a page
 * section drawn by the shared page-section owner Happier's settings use;
 * otherwise it is group semantics only (radio roving, an accessible name).
 */
export function ItemGroup(props: ItemGroupProps): ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const pageChrome = useHappierPageChrome();
  const {
    accessibilityLabel,
    accessibilityLabelKey,
    title: titleText,
    titleKey,
    description: descriptionText,
    descriptionKey,
    action,
    surface,
    children,
    style,
    testID,
    ...rest
  } = props;
  const title = resolveAuthorText(translate, titleText, titleKey);
  const description = resolveAuthorText(translate, descriptionText, descriptionKey);
  const resolvedAccessibilityLabel = resolveAuthorText(translate, accessibilityLabel, accessibilityLabelKey) ?? title;
  const hasHeader = Boolean(title) || Boolean(description) || (action !== null && action !== undefined);
  const resolvedSurface = surface ?? (hasHeader ? 'sheet' : undefined);
  resolveHappierItemGroupConstraints({
    role: rest.accessibilityRole,
    accessibilityLabel: resolvedAccessibilityLabel,
    columns: 1,
    virtualized: false,
  });
  if (resolvedSurface === undefined || palette === null) {
    return (
      <HappierItemGroup
        {...rest}
        testID={testID}
        style={style}
        accessibilityLabel={resolvedAccessibilityLabel}
      >
        {children}
      </HappierItemGroup>
    );
  }
  return (
    // Centred in the page's content column, like the page header above it, so
    // the section title and sheet sit on the page title's line.
    <View testID={testID} style={[{ alignItems: 'center' }, style]}>
      <View style={{ width: '100%', maxWidth: pageChrome?.columnMaxWidthPx }}>
      {hasHeader ? (
        <HappierPageSectionHeader
          title={title}
          description={description}
          action={action}
          insetPx={HAPPIER_PAGE_METRICS.sheetInsetPx + HAPPIER_PAGE_METRICS.headingOpticalInsetPx}
        />
      ) : (
        // An untitled page section starts one section gap below what precedes it, like a titled one
        // (the header → first block distance does not depend on what the first block is).
        <View style={{ height: HAPPIER_PAGE_METRICS.sectionGapPx }} />
      )}
      <HappierItemGroupBehavior
        accessibilityRole={rest.accessibilityRole}
        accessibilityLabel={resolvedAccessibilityLabel}
        selectableItemCount={Children.count(children)}
        renderContent={(rows) => (
          <View
            role={rest.accessibilityRole ?? 'group'}
            accessibilityRole={rest.accessibilityRole}
            accessibilityLabel={resolvedAccessibilityLabel}
            aria-label={resolvedAccessibilityLabel}
            style={{ marginHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx }}
          >
            {/* The radio projection runs first, so the sheet divides the projected rows. */}
            <HappierPageSheet surface={resolvedSurface} colors={palette}>{rows}</HappierPageSheet>
          </View>
        )}
      >
        {children}
      </HappierItemGroupBehavior>
      </View>
    </View>
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
