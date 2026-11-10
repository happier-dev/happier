import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionSurfaceItemIdSchema } from '../../sessions/board/ids.js';
import { SessionSurfaceItemDestinationV1Schema } from '../../sessions/board/item.js';
import { SessionBoardAuthoredItemUpsertInputV1Schema, SessionBoardItemUpsertInputV1Schema, SessionVisualCopySourceV1Schema } from '../../sessions/board/actions.js';
import {
  SessionBoardItemPlacementV1Schema,
  SessionBoardLayoutOperationV1Schema,
} from '../../sessions/board/layoutOperations.js';
import { SessionSystemRecordRevisionSchema } from '../../sessions/system/records/sessionSystemRecordRevision.js';
import { actionCliDerivedDefault, type ActionCliProjection } from '../actionCliProjection.js';
import type { ActionInputFieldHint } from '../actionInputHints.js';

/** One reading for a visual's destination across the Action form and CLI projection. */
export const SESSION_VISUAL_DESTINATION_HINT: ActionInputFieldHint = {
  path: 'destination', title: 'Destination', widget: 'select', options: [
    { value: 'transcript', label: 'Conversation' },
    { value: 'board', label: 'Board' },
    { value: 'both', label: 'Conversation and Board' },
  ],
};

/**
 * The canonical Board Actions leave `sessionId` optional because an in-Session
 * executor stamps the current Session. A command line has no such ambient
 * Session — `executeCommand` derives its default from this very field — so the
 * friendly spelling takes the Session as its first positional and requires it.
 */
const SessionSelectorSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const SessionBoardGetCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionSelectorSchema,
  itemIds: z.optional(z.array(SessionSurfaceItemIdSchema)),
  cursor: z.optional(z.string().check(z.trim(), z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1))),
}));
export type SessionBoardGetCliInput = z.infer<typeof SessionBoardGetCliInputSchema>;

/**
 * Creation is spelled by leaving the expected revision out, not by typing the
 * JSON literal `null`. The canonical Action keeps `expectedItemRevision` as a
 * required nullable optimistic-concurrency operand, so the binder supplies that
 * `null`; the canonical schema still validates the bound result.
 */
export const SessionBoardItemUpsertCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionSelectorSchema,
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: z.optional(SessionSystemRecordRevisionSchema),
  destination: z.optional(SessionSurfaceItemDestinationV1Schema),
  item: z.optional(z.lazy(() => SessionBoardAuthoredItemUpsertInputV1Schema.shape.item)),
  copySource: z.optional(SessionVisualCopySourceV1Schema),
  placement: z.optional(SessionBoardItemPlacementV1Schema),
}).check(z.superRefine((input, context) => {
  const canonical = SessionBoardItemUpsertInputV1Schema.safeParse({ ...input, expectedItemRevision: input.expectedItemRevision ?? null });
  if (!canonical.success) for (const issue of canonical.error.issues) context.addIssue({
    code: 'custom', path: issue.path, message: issue.message,
  });
})));
export type SessionBoardItemUpsertCliInput = z.infer<typeof SessionBoardItemUpsertCliInputSchema>;

export const SessionBoardItemRemoveCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionSelectorSchema,
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema,
  expectedLayoutRevision: z.optional(SessionSystemRecordRevisionSchema),
}));
export type SessionBoardItemRemoveCliInput = z.infer<typeof SessionBoardItemRemoveCliInputSchema>;

/** Same rule as the item upsert: an omitted expected revision means "no layout yet". */
export const SessionBoardLayoutUpdateCliInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionSelectorSchema,
  expectedLayoutRevision: z.optional(SessionSystemRecordRevisionSchema),
  operation: SessionBoardLayoutOperationV1Schema,
}));
export type SessionBoardLayoutUpdateCliInput = z.infer<typeof SessionBoardLayoutUpdateCliInputSchema>;

export function bindSessionBoardItemUpsertCliInput(
  value: SessionBoardItemUpsertCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    itemId: value.itemId,
    expectedItemRevision: value.expectedItemRevision ?? actionCliDerivedDefault(null),
    ...(value.item ? { item: value.item } : {}),
    ...(value.copySource ? { copySource: value.copySource } : {}),
    ...(value.destination ? { destination: value.destination } : {}),
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
      SESSION_VISUAL_DESTINATION_HINT,
      { path: 'item', title: 'Item (or copy source)', widget: 'json' },
      { path: 'copySource', title: 'Exact other-Session visual to copy', widget: 'json' },
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
      { path: 'expectedLayoutRevision', title: 'Expected layout revision', widget: 'text' },
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
