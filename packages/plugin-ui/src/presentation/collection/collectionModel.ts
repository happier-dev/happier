import { useSyncExternalStore } from 'react';

import { resolveHappierRovingSelection } from './semantics.js';
import type { HappierWorkStatusTone } from '../work/workStatus.js';

/**
 * The Collection's pure model rules (COLLECTION.md §2). `useHappierCollection` composes them; they
 * stay plain functions so the list engine, a landing route and the tests read the same answer.
 */
export type HappierCollectionKey = string;

/**
 * The grid's rows, per section: up to `columns` items each, and a new row wherever an item's band
 * shape changes (`compact`: a tile with no description or footer), so a compact tile never stretches
 * to its described neighbours' height. The grid draws these rows and keyboard movement walks them.
 */
export function resolveHappierCollectionGridRows<Item>(input: Readonly<{
  sections: readonly (readonly Item[])[];
  columns: number;
  compact?: (item: Item) => boolean;
}>): Item[][][] {
  const columns = Math.max(1, input.columns);
  return input.sections.map((section) => {
    const rows: Item[][] = [];
    let rowCompact: boolean | null = null;
    for (const item of section) {
      const compact = input.compact?.(item) ?? false;
      const current = rows[rows.length - 1];
      if (current === undefined || current.length >= columns || compact !== rowCompact) {
        rows.push([item]);
        rowCompact = compact;
      } else {
        current.push(item);
      }
    }
    return rows;
  });
}

/** Spatial movement belongs to the keyed model, not to mounted columns or card cells. */
export function resolveHappierCollectionSpatialFocus(input: Readonly<{
  key: string;
  from: string;
  sections: readonly (readonly string[])[];
  presentation: 'table' | 'list' | 'board' | 'grid';
  columns?: number;
  /** The grid's drawn rows ({@link resolveHappierCollectionGridRows}); else rows of `columns`. */
  gridRows?: readonly (readonly string[])[];
  eligibleKeys?: ReadonlySet<string>;
  /** Navigation collections admit j/k; radio choices leave ordinary characters unclaimed. */
  listNavigationKeys?: boolean;
  rtl: boolean;
}>): string | null {
  const keys = input.sections.flat();
  const enabled = (key: string) => input.eligibleKeys === undefined || input.eligibleKeys.has(key);
  const index = keys.indexOf(input.from);
  if (index < 0) return null;
  if (input.presentation === 'board') {
    const column = input.sections.findIndex(section => section.includes(input.from));
    const row = input.sections[column]!.indexOf(input.from);
    if (input.key === 'ArrowLeft' || input.key === 'ArrowRight') {
      const direction = (input.key === 'ArrowRight') !== input.rtl ? 1 : -1;
      for (let nextColumn = column + direction; nextColumn >= 0 && nextColumn < input.sections.length; nextColumn += direction) {
        const next = input.sections[nextColumn]!;
        let candidate: string | null = null;
        let distance = Infinity;
        next.forEach((key, index) => {
          const nextDistance = Math.abs(row - index);
          if (enabled(key) && nextDistance < distance) { candidate = key; distance = nextDistance; }
        });
        if (candidate !== null) return candidate;
      }
      return input.from;
    }
    const section = input.sections[column]!;
    const next = resolveHappierRovingSelection({ entries: section.map(key => ({ disabled: !enabled(key) })), currentIndex: row,
      key: input.key, rtl: input.rtl, listNavigationKeys: input.listNavigationKeys !== false });
    return next === null ? null : section[next] ?? input.from;
  }
  if (input.presentation === 'grid' && (input.key === 'ArrowUp' || input.key === 'ArrowDown')) {
    const rows = input.gridRows
      ?? resolveHappierCollectionGridRows({ sections: input.sections, columns: input.columns ?? 1 }).flat();
    const row = rows.findIndex(candidate => candidate.includes(input.from));
    const column = rows[row]!.indexOf(input.from);
    const direction = input.key === 'ArrowDown' ? 1 : -1;
    for (let nextRow = row + direction; nextRow >= 0 && nextRow < rows.length; nextRow += direction) {
      const next = rows[nextRow]!;
      const candidate = next[Math.min(column, next.length - 1)];
      if (candidate !== undefined && enabled(candidate)) return candidate;
    }
    return input.from;
  }
  const next = resolveHappierRovingSelection({ entries: keys.map(key => ({ disabled: !enabled(key) })), currentIndex: index,
    key: input.key, rtl: input.rtl, listNavigationKeys: input.listNavigationKeys !== false });
  return next === null ? null : keys[next] ?? input.from;
}

export type HappierCollectionGroup = Readonly<{
  key: string;
  /** The group's visible and semantic name. An empty title groups the rows without a label. */
  title: string;
  description?: string;
  /** Work groups may announce attention with the same semantic tone as their rows. */
  tone?: HappierWorkStatusTone;
  /**
   * The page section this group is one part of, when groups nest one level ("Deployed by Happier · 3 environments"
   * › "shop · Production"). In a page list, consecutive groups naming one section share its heading and one sheet,
   * each group under its own sub-heading; other presentations draw the groups as usual.
   */
  section?: HappierCollectionGroupSection;
}>;

export type HappierCollectionGroupSection = Readonly<{
  key: string;
  title: string;
  /** A quiet fact beside the title ("3 environments"). */
  detail?: string;
}>;


/**
 * What the loaded rows cover. The model never computes "N of M": a partial window names its own
 * continuations, and "no matches" at `partial` means "no matches in what's loaded".
 */
export type HappierCollectionWindow =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{
      kind: 'partial';
      /** Each way to read more; `busy` while the read it asked for runs. */
      continuations: readonly Readonly<{ key: string; label: string; load: () => void; busy?: boolean }>[];
    }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

export const HAPPIER_COLLECTION_WINDOW_COMPLETE: HappierCollectionWindow = Object.freeze({ kind: 'complete' });

export type HappierCollectionSection<Item> = Readonly<{
  group: HappierCollectionGroup | null;
  items: readonly Item[];
}>;

export type HappierCollectionGrouping<Item> = Readonly<{
  axis: readonly HappierCollectionGroup[];
  groupOf: (item: Item) => string;
  /** Status boards retain empty columns so each status keeps its position. */
  retainEmpty?: boolean;
}>;

export type HappierCollectionSectionsInput<Item> = Readonly<{
  items: readonly Item[];
  keyOf: (item: Item) => HappierCollectionKey;
  /** One axis for list sections, board columns and grid shelves; a view cannot re-group. */
  groups?: HappierCollectionGrouping<Item>;
  /** Caller-owned order; the model never scores. */
  order?: (left: Item, right: Item) => number;
  /** Window-local: coverage is reported by `window`, never implied. */
  filter?: (item: Item) => boolean;
  /**
   * The item's parent row (same group), for a nested table: each group flattens depth-first, a parent's
   * descendants after it, siblings in order. A parent outside the items or in another group makes a root.
   */
  parentKey?: (item: Item) => HappierCollectionKey | null;
}>;

/** A row's place in its group's tree; present only when the Collection nests (`parentKey`). */
export type HappierCollectionTreeNode = Readonly<{
  key: HappierCollectionKey;
  parentKey: HappierCollectionKey | null;
  /** Ancestor count: 0 for an owner. */
  depth: number;
  /** Children listed in this (narrowed) window. */
  childCount: number;
  /** Position among its listed siblings, 1-based, and their count. */
  posInSet: number;
  setSize: number;
  /** Listed only to place a match below it: the item itself does not match the filter. */
  context: boolean;
  /** The filter narrows inside it, so it reads as open while the narrowing lasts. */
  held: boolean;
}>;

export type HappierCollectionTree = ReadonlyMap<HappierCollectionKey, HappierCollectionTreeNode>;

/**
 * The one identity rule for every Collection surface: keys are unique, so a presentation can key its
 * cells (and a virtualizer retain them) by them. `subject` names the rows in the error.
 */
export function admitHappierCollectionKeys(keys: Iterable<HappierCollectionKey>, subject: string): void {
  const seen = new Set<HappierCollectionKey>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`${subject} contain duplicate key "${key}".`);
    seen.add(key);
  }
}

/**
 * The one narrowing rule for grouped rows: a predicate narrows each group, and a group left with no
 * rows is dropped, whether the caller or the predicate emptied it (a labelled group over nothing
 * announces a group a reader cannot enter). With nothing to narrow or drop, the caller's array is
 * returned as is, so a selection change never rebuilds the rows a virtualizer holds.
 */
export function narrowHappierCollectionGroups<Group, Item>(
  groups: readonly Group[],
  rowsOf: (group: Group) => readonly Item[],
  withRows: (group: Group, rows: readonly Item[]) => Group,
  predicate?: (item: Item) => boolean,
): readonly Group[] {
  if (predicate === undefined) {
    return groups.every((group) => rowsOf(group).length > 0)
      ? groups
      : groups.filter((group) => rowsOf(group).length > 0);
  }
  return groups.flatMap((group) => {
    const rows = rowsOf(group).filter(predicate);
    return rows.length === 0 ? [] : [withRows(group, rows)];
  });
}

/**
 * Items → sections along the group axis. With nothing to group, order or narrow, the single section
 * keeps the caller's array.
 */
export function deriveHappierCollectionSections<Item>(
  input: HappierCollectionSectionsInput<Item>,
): readonly HappierCollectionSection<Item>[] {
  return deriveHappierCollectionTree(input).sections;
}

/**
 * Items → sections, and with `parentKey` each section's tree: a filter keeps a match's ancestors as context
 * (held open, so the match stays inside its owner) and never adds a matching parent's other children.
 */
export function deriveHappierCollectionTree<Item>(input: HappierCollectionSectionsInput<Item>): Readonly<{
  sections: readonly HappierCollectionSection<Item>[];
  tree: HappierCollectionTree | null;
}> {
  if (input.parentKey === undefined) return { sections: deriveFlatSections(input), tree: null };
  admitHappierCollectionKeys(input.items.map(input.keyOf), 'Collection items');
  const { keyOf, parentKey } = input;
  const byKey = new Map(input.items.map((item) => [keyOf(item), item]));
  const groupOf = (item: Item) => input.groups?.groupOf(item) ?? '';
  const parentOf = new Map<HappierCollectionKey, HappierCollectionKey | null>();
  for (const item of input.items) {
    const key = keyOf(item);
    const parent = parentKey(item);
    const parentItem = parent === null ? undefined : byKey.get(parent);
    parentOf.set(key, parentItem !== undefined && parent !== key && groupOf(parentItem) === groupOf(item) ? parent : null);
  }
  // A cycle (a stale parent reported by the caller) roots its first member rather than hiding the loop.
  for (const key of parentOf.keys()) {
    const seen = new Set<HappierCollectionKey>([key]);
    for (let parent = parentOf.get(key) ?? null; parent !== null; parent = parentOf.get(parent) ?? null) {
      if (seen.has(parent)) { parentOf.set(key, null); break; }
      seen.add(parent);
    }
  }
  const allChildren = new Map<HappierCollectionKey, HappierCollectionKey[]>();
  for (const [key, parent] of parentOf) {
    if (parent !== null) (allChildren.get(parent) ?? allChildren.set(parent, []).get(parent)!).push(key);
  }
  const filter = input.filter;
  const listed = new Set(filter === undefined ? parentOf.keys() : input.items.filter(filter).map(keyOf));
  const context = new Set<HappierCollectionKey>();
  if (filter !== undefined) {
    for (const key of [...listed]) {
      for (let parent = parentOf.get(key) ?? null; parent !== null && !listed.has(parent); parent = parentOf.get(parent) ?? null) {
        listed.add(parent);
        context.add(parent);
      }
    }
  }
  const narrowed = new Map<HappierCollectionKey, boolean>();
  const isNarrowed = (key: HappierCollectionKey): boolean => {
    const known = narrowed.get(key);
    if (known !== undefined) return known;
    const result = (allChildren.get(key) ?? []).some((child) => !listed.has(child) || isNarrowed(child));
    narrowed.set(key, result);
    return result;
  };
  const items = input.items.filter((item) => listed.has(keyOf(item)));
  const ordered = input.order ? [...items].sort(input.order) : items;
  const tree = new Map<HappierCollectionKey, HappierCollectionTreeNode>();
  const flatten = (rows: readonly Item[]): Item[] => {
    const childrenOf = new Map<HappierCollectionKey | null, Item[]>();
    for (const item of rows) {
      const parent = parentOf.get(keyOf(item)) ?? null;
      (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(item);
    }
    const out: Item[] = [];
    const visit = (siblings: readonly Item[], parent: HappierCollectionKey | null, depth: number) => {
      siblings.forEach((item, index) => {
        const key = keyOf(item);
        const children = childrenOf.get(key) ?? [];
        tree.set(key, {
          key,
          parentKey: parent,
          depth,
          childCount: children.length,
          posInSet: index + 1,
          setSize: siblings.length,
          context: context.has(key),
          held: filter !== undefined && children.length > 0 && (context.has(key) || isNarrowed(key)),
        });
        out.push(item);
        visit(children, key, depth + 1);
      });
    };
    visit(childrenOf.get(null) ?? [], null, 0);
    return out;
  };
  return { sections: deriveFlatSections({ ...input, items: ordered, filter: undefined, order: undefined }, flatten), tree };
}

/**
 * The rows a nested table shows: every row whose ancestors are all open (opened by the reader, or held open by
 * the narrowing), in the sections' order.
 */
export function resolveHappierCollectionTreeShown(
  tree: HappierCollectionTree,
  openBranches: ReadonlySet<HappierCollectionKey>,
  key: HappierCollectionKey,
): boolean {
  for (let parent = tree.get(key)?.parentKey ?? null; parent !== null; parent = tree.get(parent)?.parentKey ?? null) {
    if (!isHappierCollectionTreeBranchOpen(tree, openBranches, parent)) return false;
  }
  return true;
}

export function isHappierCollectionTreeBranchOpen(
  tree: HappierCollectionTree,
  openBranches: ReadonlySet<HappierCollectionKey>,
  key: HappierCollectionKey,
): boolean {
  const node = tree.get(key);
  return node !== undefined && node.childCount > 0 && (node.held || openBranches.has(key));
}

function deriveFlatSections<Item>(
  input: HappierCollectionSectionsInput<Item>,
  arrange: (rows: readonly Item[]) => readonly Item[] = (rows) => rows,
): readonly HappierCollectionSection<Item>[] {
  if (input.parentKey === undefined) admitHappierCollectionKeys(input.items.map(input.keyOf), 'Collection items');
  const filtered = input.filter ? input.items.filter(input.filter) : input.items;
  const ordered = input.order ? [...filtered].sort(input.order) : filtered;
  if (!input.groups) return [{ group: null, items: arrange(ordered) }];

  const byGroup = new Map<string, Item[]>();
  for (const group of input.groups.axis) byGroup.set(group.key, []);
  for (const item of ordered) {
    const groupKey = input.groups.groupOf(item);
    const bucket = byGroup.get(groupKey);
    if (!bucket) throw new Error(`Collection item "${input.keyOf(item)}" names undeclared group "${groupKey}".`);
    bucket.push(item);
  }
  const sections = input.groups.axis.map((group): HappierCollectionSection<Item> => ({ group, items: arrange(byGroup.get(group.key) ?? []) }));
  if (input.groups.retainEmpty) return sections;
  return narrowHappierCollectionGroups(
    sections,
    (section) => section.items,
    (section, items) => ({ ...section, items }),
  );
}

/**
 * The wide-screen "always selected" policy (COLLECTION-REQUIREMENTS §2.1): the last visited item
 * while it is still listed, else the first. `null` only when there is nothing to select.
 */
export function resolveHappierCollectionInitialKey(input: Readonly<{
  keys: readonly HappierCollectionKey[];
  lastVisited: HappierCollectionKey | null;
}>): HappierCollectionKey | null {
  if (input.lastVisited !== null && input.keys.includes(input.lastVisited)) return input.lastVisited;
  return input.keys[0] ?? null;
}

/**
 * The item last opened in a Collection during this app session. Session memory only: a navigation
 * convenience, not a preference, so it is neither persisted nor synced. Each Collection has its own.
 */
export type HappierCollectionVisitMemory<T> = Readonly<{
  record: (visit: T) => void;
  read: () => T | null;
}>;

export function createHappierCollectionVisitMemory<T>(): HappierCollectionVisitMemory<T> {
  let lastVisited: T | null = null;
  return {
    record: (visit) => {
      lastVisited = visit;
    },
    read: () => lastVisited,
  };
}

/**
 * The name typed into a Collection's open draft (a new item being added), carried from the editor in
 * the detail to the draft row in the list. The editor owns the draft; this carries only its name, and
 * a keystroke re-renders the draft row and nothing else.
 */
export type HappierCollectionDraftTitleStore = Readonly<{
  publish: (title: string) => void;
  useTitle: () => string;
}>;

export function createHappierCollectionDraftTitleStore(): HappierCollectionDraftTitleStore {
  let title = '';
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const read = (): string => title;
  return {
    publish: (next) => {
      if (next === title) return;
      title = next;
      for (const listener of listeners) listener();
    },
    useTitle: () => useSyncExternalStore(subscribe, read, read),
  };
}

/** A draft row's title: the name as typed, or the placeholder (drawn quieter) until there is one. */
export function resolveHappierCollectionDraftTitle(typed: string, placeholder: string): Readonly<{
  title: string;
  untitled: boolean;
}> {
  const title = typed.trim();
  return title ? { title, untitled: false } : { title: placeholder, untitled: true };
}

export type HappierCollectionKeyCommand =
  | Readonly<{ kind: 'focus'; key: HappierCollectionKey }>
  | Readonly<{ kind: 'open'; key: HappierCollectionKey }>
  | Readonly<{ kind: 'toggleExpanded'; key: HappierCollectionKey }>
  | Readonly<{ kind: 'close' }>;

/**
 * The `list` presentation's keys. Arrows, `j`/`k`, Home and End move focus only, through the one
 * roving owner; Enter opens the focused row; Space peeks where the Collection allows peek; Escape
 * closes the open item.
 */
export function resolveHappierCollectionKeyCommand(input: Readonly<{
  key: string;
  /** Traversal order of the rows the reader can reach. */
  keys: readonly HappierCollectionKey[];
  focusKey: HappierCollectionKey | null;
  openKey: HappierCollectionKey | null;
  expandable: boolean;
  rtl: boolean;
}>): HappierCollectionKeyCommand | null {
  if (input.key === 'Escape') return input.openKey === null ? null : { kind: 'close' };
  const current = input.focusKey ?? input.openKey ?? input.keys[0] ?? null;
  if (current === null) return null;
  if (input.key === 'Enter') return { kind: 'open', key: current };
  if (input.key === ' ' || input.key === 'Spacebar') {
    return input.expandable ? { kind: 'toggleExpanded', key: current } : null;
  }
  const currentIndex = input.keys.indexOf(current);
  // Nothing focused yet: the first move lands next to the open item rather than skipping past it.
  const next = resolveHappierRovingSelection({
    entries: input.keys.map(() => ({ disabled: false })),
    currentIndex,
    key: input.key,
    rtl: input.rtl,
    listNavigationKeys: true,
  });
  if (next === null) return null;
  const nextKey = input.keys[next];
  return nextKey === undefined ? null : { kind: 'focus', key: nextKey };
}
