import type { HappierFocusable } from '../portableTypes.js';

export type HappierSelectableRole = 'radio' | 'option' | 'button' | undefined;

/**
 * The row-side half of a composite collection's roving-focus contract.
 *
 * A row never decides where focus goes: it publishes its real focus target to
 * the collection owner and forwards a navigation key to it. `HappierItemGroup`
 * supplies this from its projected children; the virtualized public List
 * supplies it from the full item array, including the rows its virtualizer has
 * not mounted. One row-side consumer, two providers — not two owners.
 */
export type HappierRovingCollectionItem = Readonly<{
  isTabStop: boolean;
  onKeyDown: (key: string) => boolean;
  register: (target: HappierFocusable | null) => void;
}>;

export type HappierItemSemanticInput = Readonly<{
  role?: HappierSelectableRole;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
  groupedIndex?: number;
  tabStopIndex?: number | null;
  /**
   * Whether this row is its composite collection's single roving tab stop.
   *
   * A virtualized collection cannot supply `groupedIndex`/`tabStopIndex` to its
   * rows without re-rendering every mounted row whenever the tab stop moves, so
   * its owner resolves the comparison once and reports the per-row answer. The
   * two channels are not two decisions: `resolveHappierItemBehavior` derives
   * this value from the grouped indices when the caller does not supply it.
   */
  isTabStop?: boolean;
}>;

export type HappierItemSemanticState = Readonly<{
  checked?: boolean;
  selected?: boolean;
  disabled?: boolean;
  busy?: boolean;
  expanded?: boolean;
}>;

export type HappierItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';

export type HappierItemBehaviorInput = HappierItemSemanticInput & Readonly<{
  focused?: boolean;
  selectableItemCount?: number;
  density?: HappierItemDensity;
  hasPrimaryAction: boolean;
  hasSecondaryActions?: boolean;
  hasAccessory?: boolean;
  accessoryOutsidePressable?: boolean;
  showNavigationAccessory?: boolean;
  keepNavigationAccessoryWithAccessory?: boolean;
  showDivider?: boolean;
}>;

export type HappierItemBehavior = Readonly<{
  accessibilityState?: HappierItemSemanticState;
  tabIndex: -1 | 0;
  interactive: boolean;
  secondaryActionsEnabled: boolean;
  density: HappierItemDensity;
  dividerVisible: boolean;
  selectionVisible: boolean;
  accessoryPlacement: 'inside' | 'outside';
  navigationAccessoryVisible: boolean;
}>;

/**
 * Canonical row behavior consumed by core Item, public Item/List.Item and the
 * declarative adapter. Rendering stays adapter-owned; selection, disabled and
 * busy state, density, divider, accessory placement and row-action policy do
 * not fork between those renderers.
 */
export function resolveHappierItemBehavior(input: HappierItemBehaviorInput): HappierItemBehavior {
  const isRadio = input.role === 'radio';
  const hasState = isRadio
    || input.selected !== undefined
    || input.disabled === true
    || input.busy === true
    || input.expanded !== undefined;
  const accessibilityState = hasState ? {
    ...(isRadio ? { checked: input.selected === true } : input.selected !== undefined ? { selected: input.selected } : {}),
    ...(input.disabled === true || input.busy === true ? { disabled: true } : {}),
    ...(input.busy === true ? { busy: true } : {}),
    ...(input.expanded !== undefined ? { expanded: input.expanded } : {}),
  } : undefined;
  const grouped = typeof input.groupedIndex === 'number' && input.tabStopIndex !== undefined;
  // One roving decision with two input shapes: an explicit per-row answer from a
  // virtualized collection owner, otherwise the grouped-index comparison. A row
  // outside any composite collection is an ordinary independent tab stop.
  const rovingTabStop = input.isTabStop ?? (grouped ? input.groupedIndex === input.tabStopIndex : null);
  const tabIndex = input.disabled === true || input.busy === true
    ? -1
    : rovingTabStop === null || rovingTabStop
      ? 0
      : -1;
  const enabled = input.disabled !== true && input.busy !== true;
  const hasAccessory = input.hasAccessory === true;

  return {
    accessibilityState,
    tabIndex,
    // Interaction ownership is structural. Disabled/busy state suppresses
    // activation but must not remount a button/radio/option as plain content,
    // which would drop focus and its accessible role mid-operation.
    interactive: input.hasPrimaryAction,
    secondaryActionsEnabled: enabled && input.hasSecondaryActions === true,
    density: input.density ?? 'comfortable',
    dividerVisible: input.showDivider === true,
    selectionVisible: (input.selected === true || input.focused === true)
      && (input.selectableItemCount ?? 2) > 1,
    accessoryPlacement: hasAccessory && input.accessoryOutsidePressable === true ? 'outside' : 'inside',
    navigationAccessoryVisible: input.showNavigationAccessory === true
      && input.hasPrimaryAction
      && (input.keepNavigationAccessoryWithAccessory === true || !hasAccessory),
  };
}

/** Shared selected/disabled/busy and roving-tab projection for every item row. */
export function resolveHappierItemSemantics(input: HappierItemSemanticInput): Readonly<{
  accessibilityState?: HappierItemSemanticState;
  tabIndex: -1 | 0;
}> {
  const behavior = resolveHappierItemBehavior({
    ...input,
    hasPrimaryAction: true,
  });
  return { accessibilityState: behavior.accessibilityState, tabIndex: behavior.tabIndex };
}

export type HappierRovingEntry = Readonly<{ disabled: boolean }>;

/**
 * The single roving tab-stop rule for every composite collection: the current
 * choice keeps the stop, and a collection with no current choice offers its
 * first selectable entry so the widget stays reachable with one Tab press.
 */
export function resolveHappierRovingTabStop(input: Readonly<{
  entries: readonly HappierRovingEntry[];
  /**
   * The collection's current roving choice, or -1 when it has none.
   *
   * A collection whose focus and selection are one fact passes its selected
   * entry. A listbox that separates them passes its FOCUSED entry: the tab stop
   * follows the roving focus, which is what returns the reader to where they
   * were rather than to a selection they navigated away from.
   */
  selectedIndex: number;
}>): number | null {
  const selected = input.entries[input.selectedIndex];
  if (selected !== undefined && !selected.disabled) return input.selectedIndex;
  const first = input.entries.findIndex((entry) => !entry.disabled);
  return first >= 0 ? first : null;
}

/** Shared Home/End/arrow navigation, including RTL horizontal direction. */
export function resolveHappierRovingSelection(input: Readonly<{
  entries: readonly HappierRovingEntry[];
  currentIndex: number;
  key: string;
  rtl: boolean;
  /**
   * Whether this collection also answers to the vertical `j`/`k` list idiom.
   *
   * It is opt-in rather than universal because `j` and `k` are ordinary
   * characters in a radio group or tablist, where a reader may be typing to
   * jump to a label. Keeping the alias here rather than translating it at each
   * caller leaves one owner that knows which key means which direction.
   */
  listNavigationKeys?: boolean;
}>): number | null {
  const enabled = input.entries.flatMap((entry, index) => entry.disabled ? [] : [index]);
  const position = enabled.indexOf(input.currentIndex);
  if (position < 0 || enabled.length === 0) return null;
  // A radio group's current choice is activated in place; the ItemGroup owner
  // still owns its onPress and focus target instead of each row inventing a
  // Space fallback.
  if (input.key === ' ' || input.key === 'Spacebar') return input.currentIndex;
  if (input.key === 'Home') return enabled[0] ?? null;
  if (input.key === 'End') return enabled.at(-1) ?? null;
  const key = input.listNavigationKeys === true && (input.key === 'j' || input.key === 'k')
    ? input.key === 'j' ? 'ArrowDown' : 'ArrowUp'
    : input.key;
  const step = key === 'ArrowDown'
    ? 1
    : key === 'ArrowUp'
      ? -1
      : key === 'ArrowRight'
        ? input.rtl ? -1 : 1
        : key === 'ArrowLeft'
          ? input.rtl ? 1 : -1
          : 0;
  if (step === 0) return null;
  return enabled[(position + step + enabled.length) % enabled.length] ?? null;
}

/** One constraint owner for public and core group composition. */
export function resolveHappierItemGroupConstraints(input: Readonly<{
  role?: 'radiogroup';
  accessibilityLabel?: string;
  columns: number;
  virtualized: boolean;
}>): void {
  if (input.role === 'radiogroup' && !input.accessibilityLabel?.trim()) {
    throw new Error('ItemGroup radiogroup requires a non-empty accessible name');
  }
  if (input.columns > 1 && input.virtualized) {
    throw new Error('ItemGroup cannot combine columns with virtualized content');
  }
  if (input.columns > 1 && input.role === 'radiogroup') {
    throw new Error('ItemGroup cannot combine columns with a radiogroup');
  }
}
