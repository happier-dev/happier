import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { HappierPageTextStep } from '../layout/pageText.js';
import { HAPPIER_TYPE_SCALE } from '../text/typeScale.js';

/**
 * One transient-menu scale, independent of a collection's density preference. Rows run edge to edge (owner
 * 2026-11-08, restated 2026-11-16 for the composer popovers): a row's hover and selection fill spans the menu's
 * full width with no side inset and no rounded pill, and the surface's corner clips the first and last row. The
 * menu keeps `sectionPaddingVerticalPx` top and bottom so the first row is not glued to the top (owner 2026-11-11,
 * phone #03/#05). A row's words stay on `paddingHorizontalPx` from the menu's edge, like headings, section titles and
 * footers: one text edge. Every menu row pads `paddingVerticalPx`, whatever its list's density, so a one-line row is
 * `minHeightPx` and a described row is its two lines (the description directly under the name, LAB-P8 r2). A divider
 * between a menu's sections runs edge to edge like the rows it parts (popovers are full-bleed).
 */
export const HAPPIER_MENU_ROW_METRICS = {
  iconGlyphSizePx: 16,
  iconBoxSizePx: 16,
  iconMarginRightPx: 12,
  /**
   * An identity mark in a menu row's leading column (an avatar, a Home's mark): centred on the glyph axis and
   * overhanging the 16 column by 4 on each side, so a menu's titles share one edge whether a row leads with a
   * glyph or a mark (PHONE-GEOMETRY-1110: the Home menu's identity row stood 16 right of its glyph rows).
   */
  identityMarkPx: 24,
  minHeightPx: 36,
  paddingVerticalPx: 8,
  paddingHorizontalPx: 12,
  sectionPaddingVerticalPx: 4,
  subtitleGapPx: 0,
} as const;

/** A menu row's highlight shape: edge to edge and square, with its words on the menu's text edge. */
export const HAPPIER_MENU_ROW_SHAPE = Object.freeze({
  marginHorizontal: 0,
  paddingHorizontal: HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx,
  borderRadius: 0,
});

/**
 * The text of one transient-menu row — its label and the quiet line beneath — for every menu, Happier
 * core's `SelectableRow` and a plugin's `Menu` alike, so a row ⋯ menu reads in the app's own type.
 */
export const HAPPIER_MENU_ROW_TEXT = {
  label: { weight: 'regular', fontSize: Platform.OS === 'ios' ? 16 : 15, lineHeight: 20, letterSpacing: Platform.OS === 'ios' ? -0.2 : 0 },
  // A row's description is the type scale's meta step (LAB-P8 r2), never a menu-only size.
  subtitle: {
    weight: 'regular',
    fontSize: Platform.OS === 'ios' ? HAPPIER_TYPE_SCALE.meta.ios.fontSize : HAPPIER_TYPE_SCALE.meta.fontSize,
    lineHeight: HAPPIER_TYPE_SCALE.meta.lineHeight,
  },
} as const satisfies Readonly<Record<'label' | 'subtitle', HappierPageTextStep>>;

/**
 * A menu row's trailing slot (a pin, a badge, a facepile, a check): it sits on the row's one line and never grows the
 * row. A control taller than the line overhangs it invisibly, its finger reach unchanged, so every menu keeps one
 * row pitch (owner 2026-11-11, phone 1544 #04: the More menu's pinned rows stood at 44 instead of 36).
 */
export const HAPPIER_MENU_ROW_TRAILING = Object.freeze({
  height: HAPPIER_MENU_ROW_TEXT.label.lineHeight,
  overflow: 'visible' as const,
  justifyContent: 'center' as const,
});

export type HappierMenuItemDescriptor = Readonly<{
  id: string;
  label?: string;
  disabled?: boolean;
  kind?: 'action' | 'checkbox' | 'radio';
  checked?: boolean;
  radioGroupId?: string;
}>;

/** A named semantic section whose rows participate in the menu's one selection order. */
export type HappierMenuGroupDescriptor<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
  id: string;
  accessibilityLabel: string;
  items: readonly Item[];
}>;

export type HappierMenuEntry<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
  item: Item;
  index: number;
}>;

export type HappierResolvedMenuGroup<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
  id: string;
  accessibilityLabel: string;
  entries: readonly HappierMenuEntry<Item>[];
}>;

export type HappierMenuContent<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
  /** The one ordered item list consumed by selection, keyboard and typeahead behavior. */
  items: readonly Item[];
  ungroupedEntries: readonly HappierMenuEntry<Item>[];
  groups: readonly HappierResolvedMenuGroup<Item>[];
}>;

/**
 * Normalizes public flat rows and named semantic groups before rendering.
 *
 * Grouping changes accessibility structure only: all rows flatten into one
 * stable selection order, so keyboard movement and typeahead cannot diverge at
 * a group boundary. This is also the sole public item-identity guard because
 * rendered focus refs are keyed by item id.
 */
export function resolveHappierMenuContent<Item extends HappierMenuItemDescriptor>(input: Readonly<{
  items?: readonly Item[];
  groups?: readonly HappierMenuGroupDescriptor<Item>[];
}>): HappierMenuContent<Item> {
  const seenItemIds = new Set<string>();
  const normalizedItems: Item[] = [];
  const normalizeItem = (item: Item): HappierMenuEntry<Item> => {
    if (!item.id.trim()) throw new Error('Menu item requires a non-empty menu item id.');
    if (seenItemIds.has(item.id)) throw new Error(`Duplicate menu item id "${item.id}".`);
    if (item.kind === 'checkbox' && typeof item.checked !== 'boolean') {
      throw new Error(`Checkbox menu item "${item.id}" requires a boolean checked value.`);
    }
    seenItemIds.add(item.id);
    const entry = { item, index: normalizedItems.length };
    normalizedItems.push(item);
    return entry;
  };

  const ungroupedEntries = (input.items ?? []).map(normalizeItem);
  const seenGroupIds = new Set<string>();
  const groups = (input.groups ?? []).map((group): HappierResolvedMenuGroup<Item> => {
    if (!group.id.trim()) throw new Error('Menu group requires a non-empty id.');
    if (!group.accessibilityLabel.trim()) throw new Error(`Menu group "${group.id}" requires an accessible name.`);
    if (seenGroupIds.has(group.id)) throw new Error(`Menu group "${group.id}" is declared more than once.`);
    if (group.items.length === 0) throw new Error(`Menu group "${group.id}" requires at least one item.`);
    seenGroupIds.add(group.id);
    return {
      id: group.id,
      accessibilityLabel: group.accessibilityLabel,
      entries: group.items.map(normalizeItem),
    };
  });

  return { items: normalizedItems, ungroupedEntries, groups };
}

/** A controlled, named radio selection inside one semantic menu. */
export type HappierMenuRadioGroupDescriptor = Readonly<{
  id: string;
  accessibilityLabel: string;
  selectedId: string | null;
}>;

export type HappierMenuKeyAction =
  | Readonly<{ kind: 'move'; direction: -1 | 1 }>
  /** Sideways: within a row of items (a swatch row), or into/out of a submenu by the adapter. */
  | Readonly<{ kind: 'cross'; direction: -1 | 1 }>
  | Readonly<{ kind: 'edge'; edge: 'start' | 'end' }>
  | Readonly<{ kind: 'activate' }>
  | Readonly<{ kind: 'close' }>
  | Readonly<{ kind: 'typeahead'; value: string }>
  | Readonly<{ kind: 'none' }>;

export function resolveHappierMenuKeyAction(key: string): HappierMenuKeyAction {
  if (key === 'Escape') return { kind: 'close' };
  if (key === 'ArrowDown') return { kind: 'move', direction: 1 };
  if (key === 'ArrowUp') return { kind: 'move', direction: -1 };
  if (key === 'ArrowRight') return { kind: 'cross', direction: 1 };
  if (key === 'ArrowLeft') return { kind: 'cross', direction: -1 };
  if (key === 'Home') return { kind: 'edge', edge: 'start' };
  if (key === 'End') return { kind: 'edge', edge: 'end' };
  if (key === 'Enter' || key === ' ') return { kind: 'activate' };
  if (key.length === 1 && key.trim().length === 1) return { kind: 'typeahead', value: key };
  return { kind: 'none' };
}

/** Cyclic enabled-item prefix matching shared by product and public menus. */
export function resolveHappierMenuTypeahead(input: Readonly<{
  items: readonly HappierMenuItemDescriptor[];
  selectedIndex: number;
  query: string;
  /** Already-admitted labels in lexical order; built once with the item inventory. */
  prefixIndex?: readonly Readonly<{ label: string; itemIndex: number }>[];
}>): number {
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) return input.selectedIndex;
  if (input.prefixIndex) {
    const entries = input.prefixIndex;
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle]!.label < query) low = middle + 1;
      else high = middle;
    }
    let first = Number.POSITIVE_INFINITY;
    let next = Number.POSITIVE_INFINITY;
    for (let index = low; index < entries.length && entries[index]!.label.startsWith(query); index += 1) {
      const position = entries[index]!.itemIndex;
      first = Math.min(first, position);
      if (position > input.selectedIndex) next = Math.min(next, position);
    }
    return Number.isFinite(next) ? next : Number.isFinite(first) ? first : input.selectedIndex;
  }
  for (let offset = 1; offset <= input.items.length; offset += 1) {
    const index = (Math.max(input.selectedIndex, -1) + offset) % input.items.length;
    const item = input.items[index];
    if (!item?.disabled && item.label?.toLocaleLowerCase().startsWith(query)) return index;
  }
  return input.selectedIndex;
}

/**
 * Validates the one controlled selection owner for each radio menu group.
 *
 * A radio row does not carry an independent `checked` value: the group's one
 * selected id derives every row's checked state, so contradictory sibling
 * checks cannot enter the rendered accessibility tree.
 */
export function resolveHappierMenuRadioGroups(input: Readonly<{
  items: readonly HappierMenuItemDescriptor[];
  radioGroups: readonly HappierMenuRadioGroupDescriptor[];
}>): ReadonlyMap<string, HappierMenuRadioGroupDescriptor> {
  const groups = new Map<string, HappierMenuRadioGroupDescriptor>();
  for (const group of input.radioGroups) {
    if (!group.id.trim()) throw new Error('Menu radio group requires a non-empty id.');
    if (!group.accessibilityLabel.trim()) throw new Error(`Menu radio group "${group.id}" requires an accessible name.`);
    if (groups.has(group.id)) throw new Error(`Menu radio group "${group.id}" is declared more than once.`);
    groups.set(group.id, group);
  }

  const radioItemIdsByGroup = new Map<string, Set<string>>();
  for (const item of input.items) {
    if (item.kind !== 'radio') continue;
    if (!item.radioGroupId?.trim()) throw new Error(`Radio menu item "${item.id}" requires a radioGroupId.`);
    if (!groups.has(item.radioGroupId)) {
      throw new Error(`Radio menu item "${item.id}" references unknown group "${item.radioGroupId}".`);
    }
    const itemIds = radioItemIdsByGroup.get(item.radioGroupId) ?? new Set<string>();
    itemIds.add(item.id);
    radioItemIdsByGroup.set(item.radioGroupId, itemIds);
  }

  for (const group of input.radioGroups) {
    const itemIds = radioItemIdsByGroup.get(group.id);
    if (!itemIds?.size) throw new Error(`Menu radio group "${group.id}" has no radio items.`);
    if (group.selectedId !== null && !itemIds.has(group.selectedId)) {
      throw new Error(`Menu radio group "${group.id}" selects item "${group.selectedId}" outside the group.`);
    }
  }
  return groups;
}

type HappierMenuInteractionItem = Readonly<{
  id: string;
  disabled?: boolean;
}>;

export type HappierMenuInteractionInput<Item extends HappierMenuInteractionItem> = Readonly<{
  items: readonly Item[];
  /** The data owner indexes a large inventory once; keyboard movement never re-scans ids. */
  itemIndexById?: ReadonlyMap<string, number>;
  /** A closed controlled menu forgets its transient prefix query. */
  open?: boolean;
  initialSelectedId?: string | null;
  /** A touch-first menu may deliberately start without a highlighted row. */
  allowEmptySelection?: boolean;
  /** A focused search field can retain printable keys as text input instead. */
  enableTypeahead?: boolean;
  /** Adapter-owned item/filter identity that should reset the highlighted row. */
  resetKey?: unknown;
  onRequestClose(): void;
  getItemLabel(item: Item): string | undefined;
  /** Rendering adapters own the physical focus target, not selection policy. */
  onKeyboardSelectionChange?(index: number): void;
  /** Consecutive items sharing a row (a swatch row) move sideways together and count as one vertical stop. */
  getItemRowGroup?(item: Item): string | null | undefined;
}>;

function resolveHappierMenuInitialSelection<Item extends HappierMenuInteractionItem>(input: Readonly<{
  items: readonly Item[];
  itemIndexById?: ReadonlyMap<string, number>;
  initialSelectedId?: string | null;
  allowEmptySelection: boolean;
}>): number {
  const preferredId = input.initialSelectedId ?? null;
  if (preferredId !== null) {
    const preferredIndex = input.itemIndexById
      ? input.itemIndexById.get(preferredId) ?? -1
      : input.items.findIndex((item) => item.id === preferredId && !item.disabled);
    if (preferredIndex >= 0 && !input.items[preferredIndex]?.disabled) return preferredIndex;
  }
  if (input.allowEmptySelection) return -1;
  return resolveHappierMenuSelection({
    items: input.items,
    selectedIndex: -1,
    direction: 1,
    wrap: false,
  });
}

function clampHappierMenuSelection<Item extends HappierMenuInteractionItem>(input: Readonly<{
  items: readonly Item[];
  index: number;
  allowEmptySelection: boolean;
}>): number {
  if (input.allowEmptySelection && input.index === -1) return -1;
  const item = input.items[input.index];
  if (item && !item.disabled) return input.index;
  return resolveHappierMenuSelection({
    items: input.items,
    selectedIndex: -1,
    direction: 1,
    wrap: false,
  });
}

/**
 * One controlled menu interaction owner for public and core adapters.
 *
 * It owns highlight state, enabled-row movement, prefix timeout/currentness,
 * Escape dismissal and key dispatch. Callers retain only their real boundary:
 * how an activated semantic item changes their domain state, and (for RNW)
 * which rendered row receives the resulting physical focus.
 */
export function useHappierMenuInteraction<Item extends HappierMenuInteractionItem>(
  input: HappierMenuInteractionInput<Item>,
) {
  const allowEmptySelection = input.allowEmptySelection === true;
  const initialSelectedIndex = useMemo(() => resolveHappierMenuInitialSelection({
    items: input.items,
    itemIndexById: input.itemIndexById,
    initialSelectedId: input.initialSelectedId,
    allowEmptySelection,
  }), [allowEmptySelection, input.initialSelectedId, input.itemIndexById, input.items]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(input.items[initialSelectedIndex]?.id ?? null);
  const selectedIndex = useMemo(() => {
    if (selectedItemId === null && allowEmptySelection) return -1;
    const index = input.itemIndexById && selectedItemId !== null
      ? input.itemIndexById.get(selectedItemId) ?? -1
      : input.items.findIndex((item) => item.id === selectedItemId && !item.disabled);
    return index >= 0 && !input.items[index]?.disabled ? index : initialSelectedIndex;
  }, [allowEmptySelection, initialSelectedIndex, input.itemIndexById, input.items, selectedItemId]);
  const itemsRef = useRef(input.items);
  itemsRef.current = input.items;
  const itemIndexByIdRef = useRef(input.itemIndexById);
  itemIndexByIdRef.current = input.itemIndexById;
  const typeaheadRef = useRef<{ value: string; timer: ReturnType<typeof setTimeout> | null }>({ value: '', timer: null });
  const typeahead = useMemo(() => {
    const items = input.items.map((item) => ({ id: item.id, disabled: item.disabled, label: input.getItemLabel(item) }));
    const prefixIndex = input.itemIndexById ? items.flatMap((item, itemIndex) => !item.disabled && item.label
      ? [{ label: item.label.toLocaleLowerCase(), itemIndex }] : [])
      .sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : a.itemIndex - b.itemIndex) : undefined;
    return { items, prefixIndex };
  }, [input.getItemLabel, input.itemIndexById, input.items]);

  const clearTypeahead = useCallback(() => {
    if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.value = '';
    typeaheadRef.current.timer = null;
  }, []);
  const commitSelection = useCallback((index: number) => {
    setSelectedItemId(itemsRef.current[index]?.id ?? null);
  }, []);

  useEffect(() => clearTypeahead, [clearTypeahead]);
  useEffect(() => {
    if (input.open === false) {
      clearTypeahead();
      return;
    }
    commitSelection(resolveHappierMenuInitialSelection({
      items: itemsRef.current,
      itemIndexById: itemIndexByIdRef.current,
      initialSelectedId: input.initialSelectedId,
      allowEmptySelection,
    }));
    // Item positions can change while the user's selection intent stays the same.
    // Reset by that intent; the item effect below retains the highlighted id.
  }, [allowEmptySelection, clearTypeahead, commitSelection, input.initialSelectedId, input.open, input.resetKey]);

  // Resolve indices from the logical id during render, before row layout can
  // reveal a different item at the old index. Retire removed/disabled ids to
  // the existing fallback so their later return cannot reclaim the highlight.
  useEffect(() => {
    const resolvedId = input.items[selectedIndex]?.id ?? null;
    if (resolvedId !== selectedItemId) commitSelection(selectedIndex);
  }, [commitSelection, input.items, selectedIndex, selectedItemId]);

  const setSelectedIndex = useCallback((index: number) => {
    commitSelection(clampHappierMenuSelection({
      items: itemsRef.current,
      index,
      allowEmptySelection,
    }));
  }, [allowEmptySelection, commitSelection]);

  const selectFromKeyboard = useCallback((index: number) => {
    commitSelection(index);
    input.onKeyboardSelectionChange?.(index);
  }, [commitSelection, input]);

  const handleKeyPress = useCallback((
    key: string,
    onActivate: (item: Item) => void,
    activeIndex = selectedIndex,
  ): boolean => {
    const action = resolveHappierMenuKeyAction(key);
    switch (action.kind) {
      case 'close':
        input.onRequestClose();
        return true;
      case 'move': {
        const rowIndex = input.getItemRowGroup
          ? resolveHappierMenuRowNavigation({ items: input.items, selectedIndex: activeIndex, action, getRowGroup: input.getItemRowGroup })
          : null;
        selectFromKeyboard(rowIndex ?? resolveHappierMenuSelection({
          items: input.items,
          selectedIndex: activeIndex,
          direction: action.direction,
          wrap: false,
        }));
        return true;
      }
      case 'cross': {
        // Outside a row the key is the adapter's (open or leave a submenu).
        const rowIndex = input.getItemRowGroup
          ? resolveHappierMenuRowNavigation({ items: input.items, selectedIndex: activeIndex, action, getRowGroup: input.getItemRowGroup })
          : null;
        if (rowIndex === null) return false;
        selectFromKeyboard(rowIndex);
        return true;
      }
      case 'edge':
        selectFromKeyboard(resolveHappierMenuSelection({
          items: input.items,
          selectedIndex: -1,
          direction: action.edge === 'start' ? 1 : -1,
          wrap: false,
        }));
        return true;
      case 'activate': {
        const item = input.items[activeIndex];
        if (item && !item.disabled) onActivate(item);
        return true;
      }
      case 'typeahead': {
        if (input.enableTypeahead === false) return false;
        if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
        typeaheadRef.current.value += action.value.toLocaleLowerCase();
        selectFromKeyboard(resolveHappierMenuTypeahead({
          items: typeahead.items,
          prefixIndex: typeahead.prefixIndex,
          selectedIndex: activeIndex,
          query: typeaheadRef.current.value,
        }));
        typeaheadRef.current.timer = setTimeout(() => {
          typeaheadRef.current.value = '';
          typeaheadRef.current.timer = null;
        }, 700);
        return true;
      }
      case 'none':
        return false;
    }
  }, [input, selectFromKeyboard, selectedIndex, typeahead]);

  return {
    selectedIndex,
    setSelectedIndex,
    handleKeyPress,
  } as const;
}

export function matchesHappierMenuQuery(input: Readonly<{
  label: string;
  description?: string;
  query: string;
}>): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) return true;
  return input.label.toLocaleLowerCase().includes(query)
    || input.description?.toLocaleLowerCase().includes(query) === true;
}

/** Shared enabled-item movement for core Dropdown, ContextMenu and public Menu. */
/**
 * Movement in a menu whose consecutive items may share a row (a row of colour swatches).
 * Sideways keys move within a row and return null outside one or at its edge (the adapter may open
 * or leave a submenu); vertical keys treat a row as one stop and enter the next row at its start.
 */
export function resolveHappierMenuRowNavigation<Item extends HappierMenuItemDescriptor>(input: Readonly<{
  items: readonly Item[];
  selectedIndex: number;
  action: Readonly<{ kind: 'move' | 'cross'; direction: -1 | 1 }>;
  getRowGroup(item: Item): string | null | undefined;
}>): number | null {
  const { items, selectedIndex, action } = input;
  const rowOf = (index: number): string | null => {
    const item = items[index];
    return item ? input.getRowGroup(item) ?? null : null;
  };
  const enabledIn = (from: number, step: -1 | 1, stop: (index: number) => boolean): number | null => {
    for (let index = from; index >= 0 && index < items.length && !stop(index); index += step) {
      if (!items[index]!.disabled) return index;
    }
    return null;
  };
  const row = selectedIndex >= 0 ? rowOf(selectedIndex) : null;
  if (action.kind === 'cross') {
    if (row === null) return null;
    // At a row's edge the key passes to the adapter too (Left from a submenu's first swatch leaves it).
    return enabledIn(selectedIndex + action.direction, action.direction, (index) => rowOf(index) !== row);
  }
  let edge = selectedIndex;
  if (row !== null) {
    while (rowOf(edge + action.direction) === row) edge += action.direction;
  }
  const next = enabledIn(edge + action.direction, action.direction, () => false);
  if (next === null) return selectedIndex;
  const nextRow = rowOf(next);
  if (nextRow === null) return next;
  // Enter a row at its start, whichever direction it was reached from.
  let start = next;
  while (rowOf(start - 1) === nextRow) start -= 1;
  return enabledIn(start, 1, (index) => rowOf(index) !== nextRow) ?? next;
}

export function resolveHappierMenuSelection(input: Readonly<{
  items: readonly HappierMenuItemDescriptor[];
  selectedIndex: number;
  direction: -1 | 1;
  wrap: boolean;
}>): number {
  const enabled = input.items.flatMap((item, index) => item.disabled ? [] : [index]);
  if (enabled.length === 0) return -1;
  const current = enabled.indexOf(input.selectedIndex);
  if (current < 0) return input.direction > 0 ? enabled[0]! : enabled.at(-1)!;
  const raw = current + input.direction;
  const next = input.wrap
    ? (raw + enabled.length) % enabled.length
    : Math.max(0, Math.min(enabled.length - 1, raw));
  return enabled[next]!;
}

export type HappierResolvedPopoverPlacement = 'top' | 'bottom' | 'left' | 'right';
export type HappierPopoverPlacement = HappierResolvedPopoverPlacement | 'auto' | 'auto-vertical' | 'auto-horizontal';

const OPPOSITE_POPOVER_PLACEMENT: Readonly<Record<HappierResolvedPopoverPlacement, HappierResolvedPopoverPlacement>> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Pure placement policy shared by the core Popover adapter and plugin-facing
 * overlay semantics. Portal target, measurements, focus, Escape and Android
 * Back remain app-private; once available space is known, choosing the side is
 * portable presentation behavior.
 */
export function resolveHappierPopoverPlacement(input: Readonly<{
  placement: HappierPopoverPlacement;
  available: Readonly<Record<HappierResolvedPopoverPlacement, number>>;
  preferredMinAvailable?: number;
  /**
   * An explicit side that has less than `preferredMinAvailable` moves to the opposite side when
   * that one has more room (a tooltip on a control at the window's top edge opens below it).
   */
  flip?: boolean;
}>): HappierResolvedPopoverPlacement {
  if (input.placement === 'auto-vertical') {
    const preferredMinAvailable = Math.max(0, input.preferredMinAvailable ?? 0);
    if (input.available.bottom >= preferredMinAvailable) return 'bottom';
    return input.available.top > input.available.bottom ? 'top' : 'bottom';
  }
  if (input.placement === 'auto-horizontal') {
    const preferredMinAvailable = Math.max(0, input.preferredMinAvailable ?? 0);
    if (input.available.right >= preferredMinAvailable) return 'right';
    if (input.available.left >= preferredMinAvailable) return 'left';
    // Neither side holds it (a submenu from a menu that fills a phone): squeezed beside the anchor it reads as
    // a sliver, so it opens over the larger vertical room at full width and scrolls within that height.
    return input.available.top > input.available.bottom ? 'top' : 'bottom';
  }
  if (input.placement !== 'auto') {
    if (input.flip !== true) return input.placement;
    const opposite = OPPOSITE_POPOVER_PLACEMENT[input.placement];
    const preferredMinAvailable = Math.max(0, input.preferredMinAvailable ?? 0);
    return input.available[input.placement] < preferredMinAvailable
      && input.available[opposite] > input.available[input.placement]
      ? opposite
      : input.placement;
  }
  // Auto reads like a menu from its trigger: below, else above, and beside only when neither holds it. Most room
  // alone put a top-of-page popover beside its trigger, over the page title, because a wide window has more room
  // on a side than below it.
  const preferredMinAvailable = Math.max(0, input.preferredMinAvailable ?? 0);
  const fitting = (['bottom', 'top', 'right', 'left'] as const).find(side => input.available[side] >= preferredMinAvailable);
  if (fitting) return fitting;
  return input.available.top > input.available.bottom ? 'top' : 'bottom';
}
