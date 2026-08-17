import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  | Readonly<{ kind: 'edge'; edge: 'start' | 'end' }>
  | Readonly<{ kind: 'activate' }>
  | Readonly<{ kind: 'close' }>
  | Readonly<{ kind: 'typeahead'; value: string }>
  | Readonly<{ kind: 'none' }>;

export function resolveHappierMenuKeyAction(key: string): HappierMenuKeyAction {
  if (key === 'Escape') return { kind: 'close' };
  if (key === 'ArrowDown') return { kind: 'move', direction: 1 };
  if (key === 'ArrowUp') return { kind: 'move', direction: -1 };
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
}>): number {
  const query = input.query.trim().toLocaleLowerCase();
  if (!query) return input.selectedIndex;
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
}>;

function resolveHappierMenuInitialSelection<Item extends HappierMenuInteractionItem>(input: Readonly<{
  items: readonly Item[];
  initialSelectedId?: string | null;
  allowEmptySelection: boolean;
}>): number {
  const preferredId = input.initialSelectedId ?? null;
  if (preferredId) {
    const preferredIndex = input.items.findIndex((item) => item.id === preferredId && !item.disabled);
    if (preferredIndex >= 0) return preferredIndex;
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
    initialSelectedId: input.initialSelectedId,
    allowEmptySelection,
  }), [allowEmptySelection, input.initialSelectedId, input.items]);
  const [selectedIndex, setSelectedIndexState] = useState(initialSelectedIndex);
  const itemsRef = useRef(input.items);
  itemsRef.current = input.items;
  const selectedItemIdRef = useRef<string | null>(input.items[initialSelectedIndex]?.id ?? null);
  const typeaheadRef = useRef<{ value: string; timer: ReturnType<typeof setTimeout> | null }>({ value: '', timer: null });
  const typeaheadItems = useMemo(() => input.items.map((item) => ({
    id: item.id,
    disabled: item.disabled,
    label: input.getItemLabel(item),
  })), [input.getItemLabel, input.items]);

  const clearTypeahead = useCallback(() => {
    if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    typeaheadRef.current.value = '';
    typeaheadRef.current.timer = null;
  }, []);
  const commitSelection = useCallback((index: number) => {
    selectedItemIdRef.current = itemsRef.current[index]?.id ?? null;
    setSelectedIndexState(index);
  }, []);

  useEffect(() => clearTypeahead, [clearTypeahead]);
  useEffect(() => {
    if (input.open === false) {
      clearTypeahead();
      return;
    }
    commitSelection(initialSelectedIndex);
  }, [clearTypeahead, commitSelection, initialSelectedIndex, input.open, input.resetKey]);

  // Keep a highlighted logical item current across reorder, removal, or a
  // newly-disabled row. This observes item identity, not raw array identity,
  // so an inline array rerender cannot steal a user's current highlight.
  useEffect(() => {
    const selectedId = selectedItemIdRef.current;
    if (!selectedId) return;
    const currentIndex = input.items.findIndex((item) => item.id === selectedId && !item.disabled);
    if (currentIndex >= 0) {
      if (currentIndex !== selectedIndex) commitSelection(currentIndex);
      return;
    }
    commitSelection(initialSelectedIndex);
  }, [commitSelection, initialSelectedIndex, input.items, selectedIndex]);

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
      case 'move':
        selectFromKeyboard(resolveHappierMenuSelection({
          items: input.items,
          selectedIndex: activeIndex,
          direction: action.direction,
          wrap: false,
        }));
        return true;
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
          items: typeaheadItems,
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
  }, [input, selectFromKeyboard, selectedIndex, typeaheadItems]);

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
    return input.available.right >= input.available.left ? 'right' : 'left';
  }
  if (input.placement !== 'auto') return input.placement;
  const entries = Object.entries(input.available) as Array<[HappierResolvedPopoverPlacement, number]>;
  entries.sort((left, right) => right[1] - left[1]);
  return entries[0]?.[0] ?? 'top';
}
