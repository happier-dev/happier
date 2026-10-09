import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionSurfaceItemIdSchema } from '../../sessions/board/ids.js';
import { SessionSurfaceItemV1Schema } from '../../sessions/board/item.js';
import {
  SessionBoardItemPlacementV1Schema,
  SessionBoardLayoutOperationV1Schema,
} from '../../sessions/board/layoutOperations.js';
import { SessionSystemRecordRevisionSchema } from '../../sessions/system/records/sessionSystemRecordRevision.js';
import { actionCliDerivedDefault, type ActionCliProjection } from '../actionCliProjection.js';

/**
 * The canonical Board Actions leave `sessionId` optional because an in-Session
 * executor stamps the current Session. A command line has no such ambient
 * Session — `executeCommand` derives its default from this very field — so the
 * friendly spelling takes the Session as its first positional and requires it.
 */
const SessionSelectorSchema = lazyZodSchema(() => z.string().trim().min(1));

export const SessionBoardGetCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  itemIds: z.array(SessionSurfaceItemIdSchema).optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).optional(),
}).strict());
export type SessionBoardGetCliInput = z.infer<typeof SessionBoardGetCliInputSchema>;

/**
 * Creation is spelled by leaving the expected revision out, not by typing the
 * JSON literal `null`. The canonical Action keeps `expectedItemRevision` as a
 * required nullable optimistic-concurrency operand, so the binder supplies that
 * `null`; the canonical schema still validates the bound result.
 */
export const SessionBoardItemUpsertCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema.optional(),
  item: z.lazy(() => SessionSurfaceItemV1Schema),
  placement: SessionBoardItemPlacementV1Schema.optional(),
}).strict());
export type SessionBoardItemUpsertCliInput = z.infer<typeof SessionBoardItemUpsertCliInputSchema>;

export const SessionBoardItemRemoveCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema,
  expectedLayoutRevision: SessionSystemRecordRevisionSchema,
}).strict());
export type SessionBoardItemRemoveCliInput = z.infer<typeof SessionBoardItemRemoveCliInputSchema>;

/** Same rule as the item upsert: an omitted expected revision means "no layout yet". */
export const SessionBoardLayoutUpdateCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: SessionSelectorSchema,
  expectedLayoutRevision: SessionSystemRecordRevisionSchema.optional(),
  operation: SessionBoardLayoutOperationV1Schema,
}).strict());
export type SessionBoardLayoutUpdateCliInput = z.infer<typeof SessionBoardLayoutUpdateCliInputSchema>;

export function bindSessionBoardItemUpsertCliInput(
  value: SessionBoardItemUpsertCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    itemId: value.itemId,
    expectedItemRevision: value.expectedItemRevision ?? actionCliDerivedDefault(null),
    item: value.item,
    ...(value.placement ? { placement: value.placement } : {}),
  };
}

export function bindSessionBoardLayoutUpdateCliInput(
  value: SessionBoardLayoutUpdateCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    expectedLayoutRevision: value.expectedLayoutRevision ?? actionCliDerivedDefault(null),
    operation: value.operation,
  };
}

export const SESSION_BOARD_GET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{ path: ['session', 'board', 'show'], positionals: ['sessionId'], visibility: 'canonical' }],
  inputSchema: SessionBoardGetCliInputSchema,
  inputHints: {
    title: 'Read Board',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'itemIds', title: 'Exact item ids', widget: 'text_list', listSeparator: 'comma' },
      { path: 'cursor', title: 'Page cursor', widget: 'text' },
      { path: 'limit', title: 'Page size', widget: 'integer' },
    ],
  },
};

export const SESSION_BOARD_ITEM_UPSERT_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'board', 'item', 'set'],
    positionals: ['sessionId', 'itemId'],
    visibility: 'canonical',
  }],
  inputSchema: SessionBoardItemUpsertCliInputSchema,
  inputHints: {
    title: 'Save a Board item',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'itemId', title: 'Item id', widget: 'text', required: true },
      { path: 'expectedItemRevision', title: 'Expected item revision (omit to create)', widget: 'text' },
      { path: 'item', title: 'Item', widget: 'json', required: true },
      { path: 'placement', title: 'Placement', widget: 'json' },
    ],
  },
  bindInput: (value) => bindSessionBoardItemUpsertCliInput(value as SessionBoardItemUpsertCliInput),
};

export const SESSION_BOARD_ITEM_REMOVE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'board', 'item', 'remove'],
    positionals: ['sessionId', 'itemId'],
    visibility: 'canonical',
  }],
  inputSchema: SessionBoardItemRemoveCliInputSchema,
  inputHints: {
    title: 'Remove a Board item',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'itemId', title: 'Item id', widget: 'text', required: true },
      { path: 'expectedItemRevision', title: 'Expected item revision', widget: 'text', required: true },
      { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text', required: true },
    ],
  },
};

export const SESSION_BOARD_LAYOUT_UPDATE_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'board', 'layout', 'update'],
    positionals: ['sessionId'],
    visibility: 'canonical',
  }],
  inputSchema: SessionBoardLayoutUpdateCliInputSchema,
  inputHints: {
    title: 'Organize the Board',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'expectedLayoutRevision', title: 'Expected layout revision (omit when no layout exists yet)', widget: 'text' },
      { path: 'operation', title: 'Layout operation', widget: 'json', required: true },
    ],
  },
  bindInput: (value) => bindSessionBoardLayoutUpdateCliInput(value as SessionBoardLayoutUpdateCliInput),
};
