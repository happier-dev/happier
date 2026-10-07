import { z } from 'zod';
import { getWidgetSizeFootprintV1, WIDGET_SIZE_POLICY_V1 } from '../../widgets/widgetPresentationV1.js';

import { SessionBoardErrorCodeSchema, type SessionBoardErrorCode } from './errors.js';
import { SessionBoardTabIdSchema, SessionSurfaceItemIdSchema } from './ids.js';
import {
  SessionBoardItemWidthSchema,
  SessionBoardItemFrameStyleSchema,
  SessionBoardLayoutV1Schema,
  type SessionBoardItemWidth,
  type SessionBoardItemFrameStyle,
  type SessionBoardLayoutV1,
} from './layout.js';

/**
 * The one semantic width used when a first placement does not name one. Both
 * the UI and the CLI/daemon Board adapters read it here so a Board authored by
 * an Agent and a Board authored by a person cannot disagree about the default.
 */
export const SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1: SessionBoardItemWidth = SessionBoardItemWidthSchema.parse(
  getWidgetSizeFootprintV1('sessionBoard', WIDGET_SIZE_POLICY_V1.sessionBoard.defaultSize)!.width,
);

const SessionBoardTabAnchorV1Schema = z.object({
  side: z.enum(['before', 'after']),
  tabId: SessionBoardTabIdSchema,
}).strict();

const SessionBoardItemAnchorV1Schema = z.object({
  side: z.enum(['before', 'after']),
  itemId: SessionSurfaceItemIdSchema,
}).strict();

/**
 * The closed set of Board organization edits. Positions are expressed only as
 * stable sibling anchors: an index would silently retarget when a concurrent
 * editor reordered the same view between the read and the write.
 */
export const SessionBoardLayoutOperationV1Schema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('tab.create'),
    tabId: SessionBoardTabIdSchema,
    title: z.string().trim(),
    anchor: SessionBoardTabAnchorV1Schema.optional(),
  }).strict(),
  z.object({
    op: z.literal('tab.rename'),
    tabId: SessionBoardTabIdSchema,
    title: z.string().trim(),
  }).strict(),
  z.object({
    op: z.literal('tab.move'),
    tabId: SessionBoardTabIdSchema,
    anchor: SessionBoardTabAnchorV1Schema,
  }).strict(),
  z.object({
    op: z.literal('tab.remove'),
    tabId: SessionBoardTabIdSchema,
    // Removing a view never silently decides what happens to its items.
    disposition: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move'), tabId: SessionBoardTabIdSchema }).strict(),
      z.object({ kind: z.literal('unpin') }).strict(),
    ]),
  }).strict(),
  z.object({
    op: z.literal('item.place'),
    itemId: SessionSurfaceItemIdSchema,
    tabId: SessionBoardTabIdSchema,
    width: SessionBoardItemWidthSchema,
    anchor: SessionBoardItemAnchorV1Schema.optional(),
  }).strict(),
  z.object({
    op: z.literal('item.move'),
    itemId: SessionSurfaceItemIdSchema,
    fromTabId: SessionBoardTabIdSchema,
    toTabId: SessionBoardTabIdSchema,
    anchor: SessionBoardItemAnchorV1Schema.optional(),
  }).strict(),
  z.object({
    op: z.literal('item.unpin'),
    itemId: SessionSurfaceItemIdSchema,
    tabId: SessionBoardTabIdSchema,
  }).strict(),
  z.object({
    // Explicit whole-Board reference cleanup, including an already-missing item.
    // Unlike item removal, this does not delete or require a shared item record.
    op: z.literal('item.unpinAll'),
    itemId: SessionSurfaceItemIdSchema,
  }).strict(),
  z.object({
    op: z.literal('item.resize'),
    itemId: SessionSurfaceItemIdSchema,
    tabId: SessionBoardTabIdSchema,
    width: SessionBoardItemWidthSchema,
  }).strict(),
  z.object({
    op: z.literal('item.frameStyle'),
    itemId: SessionSurfaceItemIdSchema,
    tabId: SessionBoardTabIdSchema,
    frameStyle: SessionBoardItemFrameStyleSchema.nullable(),
  }).strict(),
]);
export type SessionBoardLayoutOperationV1 = z.infer<typeof SessionBoardLayoutOperationV1Schema>;

/** The optional placement an item upsert may carry; see Plan 04 §3.2. */
export const SessionBoardItemPlacementV1Schema = z.object({
  tabId: SessionBoardTabIdSchema.optional(),
  tabTitle: z.string().trim().optional(),
  width: SessionBoardItemWidthSchema.optional(),
  frameStyle: SessionBoardItemFrameStyleSchema.optional(),
  anchor: SessionBoardItemAnchorV1Schema.optional(),
}).strict();
export type SessionBoardItemPlacementV1 = z.infer<typeof SessionBoardItemPlacementV1Schema>;

export type SessionBoardLayoutEditResultV1 =
  | Readonly<{ ok: true; layout: SessionBoardLayoutV1 }>
  | Readonly<{ ok: false; error: SessionBoardErrorCode }>;

type MutableTab = {
  id: string;
  title: string;
  items: { itemId: string; width: SessionBoardItemWidth; frameStyle?: SessionBoardItemFrameStyle }[];
};

const INVALID = Object.freeze({
  ok: false,
  error: SessionBoardErrorCodeSchema.enum.session_board_invalid,
} as const) satisfies SessionBoardLayoutEditResultV1;
const ITEM_NOT_FOUND = Object.freeze({
  ok: false,
  error: SessionBoardErrorCodeSchema.enum.session_board_item_not_found,
} as const) satisfies SessionBoardLayoutEditResultV1;

function draft(layout: SessionBoardLayoutV1): MutableTab[] {
  return layout.tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    items: tab.items.map((item) => ({ ...item })),
  }));
}

/**
 * The single exit: every edit is re-validated through the canonical layout
 * schema, so duplicate views, duplicate placements and out-of-vocabulary widths
 * cannot leave this owner even when an operation composes several steps.
 */
function seal(tabs: readonly MutableTab[]): SessionBoardLayoutEditResultV1 {
  const parsed = SessionBoardLayoutV1Schema.safeParse({ v: 1, tabs });
  return parsed.success ? { ok: true, layout: parsed.data } : INVALID;
}

function insertAt(
  items: MutableTab['items'],
  entry: MutableTab['items'][number],
  anchor: Readonly<{ side: 'before' | 'after'; itemId: string }> | undefined,
): 'inserted' | 'anchor_missing' {
  if (!anchor) {
    items.push(entry);
    return 'inserted';
  }
  const index = items.findIndex((item) => item.itemId === anchor.itemId);
  if (index < 0) return 'anchor_missing';
  items.splice(anchor.side === 'before' ? index : index + 1, 0, entry);
  return 'inserted';
}

export function applySessionBoardLayoutOperationV1(
  layout: SessionBoardLayoutV1,
  operation: SessionBoardLayoutOperationV1,
): SessionBoardLayoutEditResultV1 {
  if (operation.op === 'item.unpinAll') return removeSessionBoardItemPlacementsV1(layout, operation.itemId);
  const tabs = draft(layout);
  const tabIndex = (tabId: string): number => tabs.findIndex((tab) => tab.id === tabId);

  switch (operation.op) {
    case 'tab.create': {
      if (tabIndex(operation.tabId) >= 0) return INVALID;
      const created: MutableTab = { id: operation.tabId, title: operation.title, items: [] };
      if (!operation.anchor) {
        tabs.push(created);
        break;
      }
      const anchorIndex = tabIndex(operation.anchor.tabId);
      if (anchorIndex < 0) return INVALID;
      tabs.splice(operation.anchor.side === 'before' ? anchorIndex : anchorIndex + 1, 0, created);
      break;
    }
    case 'tab.rename': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      (tabs[index] as MutableTab).title = operation.title;
      break;
    }
    case 'tab.move': {
      const index = tabIndex(operation.tabId);
      if (index < 0 || operation.anchor.tabId === operation.tabId) return INVALID;
      const [moved] = tabs.splice(index, 1);
      const anchorIndex = tabIndex(operation.anchor.tabId);
      if (!moved || anchorIndex < 0) return INVALID;
      tabs.splice(operation.anchor.side === 'before' ? anchorIndex : anchorIndex + 1, 0, moved);
      break;
    }
    case 'tab.remove': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      const [removed] = tabs.splice(index, 1);
      if (!removed) return INVALID;
      if (operation.disposition.kind === 'move') {
        const destinationIndex = tabIndex(operation.disposition.tabId);
        if (destinationIndex < 0) return INVALID;
        const destination = tabs[destinationIndex] as MutableTab;
        for (const item of removed.items) {
          if (destination.items.some((existing) => existing.itemId === item.itemId)) continue;
          destination.items.push(item);
        }
      }
      break;
    }
    case 'item.place': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      const tab = tabs[index] as MutableTab;
      if (tab.items.some((item) => item.itemId === operation.itemId)) return INVALID;
      if (insertAt(tab.items, { itemId: operation.itemId, width: operation.width }, operation.anchor) !== 'inserted') {
        return ITEM_NOT_FOUND;
      }
      break;
    }
    case 'item.move': {
      const fromIndex = tabIndex(operation.fromTabId);
      const toIndex = tabIndex(operation.toTabId);
      if (fromIndex < 0 || toIndex < 0) return INVALID;
      const from = tabs[fromIndex] as MutableTab;
      const existingIndex = from.items.findIndex((item) => item.itemId === operation.itemId);
      if (existingIndex < 0) return ITEM_NOT_FOUND;
      const to = tabs[toIndex] as MutableTab;
      if (fromIndex !== toIndex && to.items.some((item) => item.itemId === operation.itemId)) return INVALID;
      const [moved] = from.items.splice(existingIndex, 1);
      if (!moved) return ITEM_NOT_FOUND;
      if (insertAt(to.items, moved, operation.anchor) !== 'inserted') return ITEM_NOT_FOUND;
      break;
    }
    case 'item.unpin': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      const tab = tabs[index] as MutableTab;
      const existingIndex = tab.items.findIndex((item) => item.itemId === operation.itemId);
      if (existingIndex < 0) return ITEM_NOT_FOUND;
      tab.items.splice(existingIndex, 1);
      break;
    }
    case 'item.resize': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      const tab = tabs[index] as MutableTab;
      const placement = tab.items.find((item) => item.itemId === operation.itemId);
      if (!placement) return ITEM_NOT_FOUND;
      placement.width = operation.width;
      break;
    }
    case 'item.frameStyle': {
      const index = tabIndex(operation.tabId);
      if (index < 0) return INVALID;
      const placement = tabs[index]?.items.find((item) => item.itemId === operation.itemId);
      if (!placement) return ITEM_NOT_FOUND;
      if (operation.frameStyle === null) delete placement.frameStyle;
      else placement.frameStyle = operation.frameStyle;
      break;
    }
  }

  return seal(tabs);
}

/**
 * The atomic first placement an item create requires, and the optional
 * placement change an item update may carry. A missing view is created only
 * when the caller supplies its title: the Board owner never invents user-facing
 * Board copy, and it never guesses a destination for an empty Board.
 */
export function applySessionBoardItemPlacementV1(
  layout: SessionBoardLayoutV1,
  args: Readonly<{ itemId: string; placement: SessionBoardItemPlacementV1 }>,
): SessionBoardLayoutEditResultV1 {
  const tabs = draft(layout);
  const { placement } = args;
  let index = placement.tabId === undefined ? 0 : tabs.findIndex((tab) => tab.id === placement.tabId);

  if (index < 0) {
    if (placement.tabId === undefined || placement.tabTitle === undefined) return INVALID;
    tabs.push({ id: placement.tabId, title: placement.tabTitle, items: [] });
    index = tabs.length - 1;
  }
  const tab = tabs[index];
  if (!tab) return INVALID;

  const existing = tab.items.find((item) => item.itemId === args.itemId);
  if (existing) {
    if (placement.width !== undefined) existing.width = placement.width;
    if (placement.frameStyle !== undefined) existing.frameStyle = placement.frameStyle;
    if (placement.anchor) {
      const existingIndex = tab.items.findIndex((item) => item.itemId === args.itemId);
      const [moved] = tab.items.splice(existingIndex, 1);
      if (!moved) return ITEM_NOT_FOUND;
      if (insertAt(tab.items, moved, placement.anchor) !== 'inserted') return ITEM_NOT_FOUND;
    }
    return seal(tabs);
  }

  const entry = { itemId: args.itemId, width: placement.width ?? SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
    ...(placement.frameStyle === undefined ? {} : { frameStyle: placement.frameStyle }) };
  if (insertAt(tab.items, entry, placement.anchor) !== 'inserted') return ITEM_NOT_FOUND;
  return seal(tabs);
}

/**
 * What {@link applySessionBoardItemPlacementV1} guarantees about the layout it produced, stated once
 * beside the operation that owns placement meaning so no validator re-derives it. An omitted width
 * preserves whatever the entry already carried (the default applies only to a brand-new entry), and
 * `tabTitle` is consumed only when a missing view is created, so neither is comparable from the result.
 */
export function sessionBoardItemPlacementOperandsRetainedV1(
  layout: SessionBoardLayoutV1,
  args: Readonly<{ itemId: string; placement: SessionBoardItemPlacementV1 }>,
): boolean {
  const destination = resolveSessionBoardItemPlacementDestinationV1(layout, args);
  if (!destination) return false;
  return sessionBoardPlacedDestinationRetainsPlacementV1(destination, args.placement);
}

/**
 * The view and width a placement actually targeted in the layout
 * {@link applySessionBoardItemPlacementV1} produced. An item may be placed in several views, so the
 * committed destination is the requested (or default first) view, never whichever view happens to
 * list the item first.
 */
export function resolveSessionBoardItemPlacementDestinationV1(
  layout: SessionBoardLayoutV1,
  args: Readonly<{ itemId: string; placement: SessionBoardItemPlacementV1 }>,
): Readonly<{ tabId: string; width: SessionBoardItemWidth; frameStyle?: SessionBoardItemFrameStyle }> | null {
  const { placement } = args;
  const tab = placement.tabId === undefined
    ? layout.tabs[0]
    : layout.tabs.find((candidate) => candidate.id === placement.tabId);
  const placed = tab?.items.find((entry) => entry.itemId === args.itemId);
  return tab && placed ? { tabId: tab.id, width: placed.width, ...(placed.frameStyle === undefined ? {} : { frameStyle: placed.frameStyle }) } : null;
}

/** Explicit portable frame operands, like explicit widths, must survive the committed placement. */
export function sessionBoardPlacedDestinationRetainsPlacementV1(
  destination: Readonly<{ width?: SessionBoardItemWidth; frameStyle?: SessionBoardItemFrameStyle }>,
  placement: Readonly<{ width?: SessionBoardItemWidth; frameStyle?: SessionBoardItemFrameStyle }>,
): boolean {
  return sessionBoardPlacedWidthRetainsPlacementV1(destination.width, placement)
    && (placement.frameStyle === undefined || destination.frameStyle === placement.frameStyle);
}

/**
 * The width half of {@link sessionBoardItemPlacementOperandsRetainedV1}, for the readers that observe
 * a projected destination rather than the layout itself. Only an explicitly invoked width is a fact
 * about the request; an omitted one leaves whatever the entry already carried, so comparing it against
 * {@link SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1} would reject a valid move of a non-default placement.
 */
export function sessionBoardPlacedWidthRetainsPlacementV1(
  placedWidth: SessionBoardItemWidth | undefined,
  placement: Readonly<{ width?: SessionBoardItemWidth }>,
): boolean {
  if (placement.width === undefined) return placedWidth !== undefined;
  return placedWidth === placement.width;
}

/** Whole-Board reference cleanup, shared by item deletion and already-missing item recovery. */
export function removeSessionBoardItemPlacementsV1(
  layout: SessionBoardLayoutV1,
  itemId: string,
): SessionBoardLayoutEditResultV1 {
  const tabs = draft(layout);
  for (const tab of tabs) {
    const index = tab.items.findIndex((item) => item.itemId === itemId);
    if (index >= 0) tab.items.splice(index, 1);
  }
  return seal(tabs);
}
