import type { HappierCollectionKey } from './collectionModel.js';

/**
 * The Collection's `table` presentation rules and its `detail: 'auto'` composition (COLLECTION.md §3, §4, §7).
 * Pure functions, so the component, a test and a future host virtualizer read one answer.
 */

/**
 * How the Collection draws its items: one-line aligned columns (`table`), two-line rows (`list`), one column of cards
 * per group (`board`), or cards in responsive columns with optional shelves (`grid`). All four draw the one anatomy.
 */
export type HappierCollectionPresentation = 'table' | 'list' | 'board' | 'grid';

/** Where an opened item goes. `auto` resolves by measured geometry, never by a device label. */
export type HappierCollectionDetailContainer = 'auto' | 'none';

/**
 * What the Collection shows right now:
 * - `table`: the full-width table, nothing open (wide) — or, beside the host details pane, the table
 *   narrowed with the open item in the pane;
 * - `split`: the list beside the open item's detail (wide, where the host placed the page in no pane host);
 * - `list`: the list is the page (narrow, nothing open), in list geometry: a phone never shows the table;
 * - `cards`: a board or a grid, with nothing open or with the open item in the host details pane;
 * - `detail`: the open item's detail is the page (narrow, cards without a host details pane, or a pane host whose
 *   pane is not beside the page: pushed).
 *
 * Before the first measurement it is the narrow composition, exactly as the split geometry stacks until it has
 * measured: a phone never flashes a table, and nothing claims a width it has not seen.
 */
export type HappierCollectionComposition = 'table' | 'split' | 'list' | 'cards' | 'detail';

export function resolveHappierCollectionComposition(input: Readonly<{
  presentation: HappierCollectionPresentation;
  detail: HappierCollectionDetailContainer;
  /** Whether the list and detail minima both fit side by side; `null` before the first measurement. */
  splitFits: boolean | null;
  /**
   * Beside the host details pane: whether the list minimum alone fits (the table narrows beside the pane
   * rather than splitting); `null` before the first measurement.
   */
  tableFits?: boolean | null;
  /** The host's details pane sits beside the page and takes the open item's detail. */
  pane?: boolean;
  /**
   * The host placed this page in a pane host, whether or not its pane is beside the page right now (a phone, side
   * panes turned off). The pane host decides where details go, so the page never splits in itself: without the pane
   * beside it the detail pushes.
   */
  paneHost?: boolean;
  open: boolean;
}>): HappierCollectionComposition {
  const cards = input.presentation === 'board' || input.presentation === 'grid';
  if (cards) {
    return input.open && input.detail !== 'none' && input.pane !== true ? 'detail' : 'cards';
  }
  if ((input.pane === true || input.paneHost === true) && input.detail !== 'none') {
    // The host pane takes the detail: beside it the narrowed page reads as the two-line list (the lab's Desk
    // list beside its detail), never a squeezed table; without the pane beside the page the detail pushes.
    if (input.open) return input.pane === true ? 'list' : 'detail';
    return input.tableFits === true && input.presentation === 'table' ? 'table' : 'list';
  }
  const resting: HappierCollectionComposition = input.splitFits === true && input.presentation === 'table' ? 'table' : 'list';
  if (input.detail === 'none' || !input.open) return resting;
  if (input.splitFits !== true) return 'detail';
  return 'split';
}

/**
 * The grid's columns: as many as the minimum card width allows beside the gutters, sharing the width equally, and
 * never fewer than one (a phone is one column of full-width cards).
 */
export function resolveHappierCollectionGridGeometry(input: Readonly<{
  width: number;
  minCardWidth: number;
  gap: number;
}>): Readonly<{ columns: number; cardWidth: number }> {
  const columns = Math.max(1, Math.floor((input.width + input.gap) / (input.minCardWidth + input.gap)));
  return { columns, cardWidth: (input.width - input.gap * (columns - 1)) / columns };
}

/** One table column: an anatomy slot or an extra field. */
export type HappierCollectionTableColumn = Readonly<{
  key: string;
  /** The narrowest readable width, at the current text scale. */
  minWidth: number;
  /** Lower drops first when the table is narrow. */
  priority: number;
  /** The one column that takes the remaining width (the title). It is never dropped. */
  flex?: boolean;
}>;

/**
 * The columns that fit, in declared order. Columns drop by measured width, lowest priority first (the later
 * declaration first on a tie); the flexible title column always stays.
 */
export function resolveHappierCollectionTableColumns<Column extends HappierCollectionTableColumn>(input: Readonly<{
  columns: readonly Column[];
  availableWidth: number;
  gap: number;
}>): readonly Column[] {
  const visible = [...input.columns];
  const width = (): number => visible.reduce((sum, column) => sum + column.minWidth, 0)
    + input.gap * Math.max(0, visible.length - 1);
  while (width() > input.availableWidth) {
    let drop = -1;
    visible.forEach((column, index) => {
      if (column.flex === true) return;
      if (drop < 0 || column.priority <= visible[drop]!.priority) drop = index;
    });
    if (drop < 0) break;
    visible.splice(drop, 1);
  }
  return visible.length === input.columns.length ? input.columns : visible;
}

/**
 * The table → split shared-element timeline, as fractions of the open duration (`motionTokens.durationMs.slow`,
 * 320 ms). The close plays the same timeline backwards over the close duration.
 */
const OPEN_MS = 320;
export const HAPPIER_COLLECTION_TRANSITION_TIMELINE = Object.freeze({
  /** The non-title columns, the column header and the footer hints fade out (exit easing). */
  columns: Object.freeze([0 / OPEN_MS, 120 / OPEN_MS] as const),
  /** Rows travel from table to list geometry (standard easing); the opened row stays anchored. */
  travel: Object.freeze([60 / OPEN_MS, 320 / OPEN_MS] as const),
  /** The detail slides in from 24 pt and fades in. */
  detail: Object.freeze([120 / OPEN_MS, 320 / OPEN_MS] as const),
  /** Each row's second line fades in. */
  secondLine: Object.freeze([160 / OPEN_MS, 320 / OPEN_MS] as const),
});

/** How far the detail slides in from, in points. */
export const HAPPIER_COLLECTION_DETAIL_SLIDE = 24;

export type HappierCollectionTransitionEasing = 'standard' | 'exit' | 'linear';

/** One property's course over the transition progress: its value at `input[0]` and at `input[1]`. */
export type HappierCollectionMotionTrack = Readonly<{
  input: readonly [number, number];
  output: readonly [number, number];
  easing: HappierCollectionTransitionEasing;
}>;

export type HappierCollectionMotionTracks = Readonly<{
  opacity?: HappierCollectionMotionTrack;
  translateX?: HappierCollectionMotionTrack;
  translateY?: HappierCollectionMotionTrack;
}>;

/** The tracks of the timeline, for the pieces the Collection moves. */
export const HAPPIER_COLLECTION_TRANSITION_TRACKS = Object.freeze({
  columns: Object.freeze({
    opacity: { input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.columns, output: [1, 0], easing: 'exit' },
  }) satisfies HappierCollectionMotionTracks,
  detail: Object.freeze({
    opacity: { input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.detail, output: [0, 1], easing: 'standard' },
    translateX: {
      input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.detail,
      output: [HAPPIER_COLLECTION_DETAIL_SLIDE, 0],
      easing: 'standard',
    },
  }) satisfies HappierCollectionMotionTracks,
  secondLine: Object.freeze({
    opacity: { input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.secondLine, output: [0, 1], easing: 'standard' },
  }) satisfies HappierCollectionMotionTracks,
});

/** A row's travel: from `offset` points away from its list place, to its list place. */
export function happierCollectionTravelTrack(offset: number): HappierCollectionMotionTracks {
  return { translateY: { input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.travel, output: [offset, 0], easing: 'standard' } };
}

/**
 * The reduced-motion course: a sequential cross-fade, out over the first half and in over the second, so the two
 * compositions are never on screen together.
 */
export const HAPPIER_COLLECTION_REDUCED_MOTION_TRACKS = Object.freeze({
  out: Object.freeze({ opacity: { input: [0, 0.5], output: [1, 0], easing: 'linear' } }) satisfies HappierCollectionMotionTracks,
  in: Object.freeze({ opacity: { input: [0.5, 1], output: [0, 1], easing: 'linear' } }) satisfies HappierCollectionMotionTracks,
});

function segment(progress: number, range: readonly [number, number]): number {
  return Math.max(0, Math.min(1, (progress - range[0]) / (range[1] - range[0])));
}

// The two curves the timeline names, as the host motion tokens define them (`easing.standard` = (0.2, 0, 0, 1);
// the exit curve = (0.4, 0, 1, 1)). Used only to describe a phase in words and tests; the host driver animates.
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return (t) => {
    let low = 0;
    let high = 1;
    let mid = t;
    for (let step = 0; step < 24; step += 1) {
      mid = (low + high) / 2;
      const x = 3 * (1 - mid) * (1 - mid) * mid * x1 + 3 * (1 - mid) * mid * mid * x2 + mid * mid * mid;
      if (x < t) low = mid;
      else high = mid;
    }
    return 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid;
  };
}
const STANDARD = bezier(0.2, 0, 0, 1);
const EXIT = bezier(0.4, 0, 1, 1);

export function evaluateHappierCollectionMotionTrack(track: HappierCollectionMotionTrack, progress: number): number {
  const linear = segment(progress, track.input);
  const eased = linear === 0 || linear === 1
    ? linear
    : track.easing === 'standard' ? STANDARD(linear) : track.easing === 'exit' ? EXIT(linear) : linear;
  return track.output[0] + (track.output[1] - track.output[0]) * eased;
}

/** Each piece of the timeline at one progress, as 0 (table side) to 1 (split side). */
export function resolveHappierCollectionTransitionPhase(progress: number): Readonly<{
  columns: number;
  travel: number;
  detail: number;
  secondLine: number;
}> {
  const tracks = HAPPIER_COLLECTION_TRANSITION_TRACKS;
  return {
    columns: evaluateHappierCollectionMotionTrack(tracks.columns.opacity, progress),
    travel: evaluateHappierCollectionMotionTrack(
      { input: HAPPIER_COLLECTION_TRANSITION_TIMELINE.travel, output: [0, 1], easing: 'standard' },
      progress,
    ),
    detail: evaluateHappierCollectionMotionTrack(tracks.detail.opacity, progress),
    secondLine: evaluateHappierCollectionMotionTrack(tracks.secondLine.opacity, progress),
  };
}

/** One virtualized cell (a group header or a row) and its exact height in each geometry. */
export type HappierCollectionTransitionCell = Readonly<{ key: string; table: number; list: number }>;

export type HappierCollectionTransitionPlan = Readonly<{
  /** The table's scroll offset: the current one on open, the one to restore on close. */
  tableScroll: number;
  /** The list's scroll offset that keeps the anchored row at the same screen y. */
  listScroll: number;
  /**
   * For each cell visible in either geometry: how far its table place is below its list place on screen, which
   * is where its travel starts. The anchored row's offset is 0; cells absent here do not animate.
   */
  offsets: ReadonlyMap<HappierCollectionKey, number>;
}>;

/**
 * The shared-element move between the table and the list beside a detail. Heights are exact per geometry, so
 * every place is arithmetic over the cells above it and nothing waits for a layout pass. Given the scroll of the
 * geometry being left, it answers the other geometry's scroll (the anchored row keeps its screen y, never above
 * the top) and each visible cell's starting offset.
 */
export function planHappierCollectionTransitionOffsets(input: Readonly<{
  cells: readonly HappierCollectionTransitionCell[];
  anchorKey: HappierCollectionKey;
  scroll: Readonly<{ geometry: 'table' | 'list'; offset: number }>;
  viewportHeight: number;
}>): HappierCollectionTransitionPlan {
  const tops = new Map<HappierCollectionKey, Readonly<{ table: number; list: number; tableHeight: number; listHeight: number }>>();
  let table = 0;
  let list = 0;
  for (const cell of input.cells) {
    tops.set(cell.key, { table, list, tableHeight: cell.table, listHeight: cell.list });
    table += cell.table;
    list += cell.list;
  }
  const anchor = tops.get(input.anchorKey);
  const anchorScreenY = anchor === undefined
    ? 0
    : (input.scroll.geometry === 'table' ? anchor.table : anchor.list) - input.scroll.offset;
  const tableScroll = input.scroll.geometry === 'table'
    ? input.scroll.offset
    : Math.max(0, anchor === undefined ? 0 : anchor.table - anchorScreenY);
  const listScroll = input.scroll.geometry === 'list'
    ? input.scroll.offset
    : Math.max(0, anchor === undefined ? 0 : anchor.list - anchorScreenY);
  const offsets = new Map<HappierCollectionKey, number>();
  for (const [key, place] of tops) {
    const tableY = place.table - tableScroll;
    const listY = place.list - listScroll;
    const visible = (tableY + place.tableHeight > 0 && tableY < input.viewportHeight)
      || (listY + place.listHeight > 0 && listY < input.viewportHeight);
    if (visible) offsets.set(key, tableY - listY);
  }
  return { tableScroll, listScroll, offsets };
}
