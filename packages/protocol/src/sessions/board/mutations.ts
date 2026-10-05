import { z } from 'zod';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import { SessionSurfaceItemIdSchema } from './ids.js';
import { SessionSurfaceItemV1Schema, isSessionSurfaceItemIdentityCorrespondingV1 } from './item.js';
import { SessionBoardLayoutV1Schema } from './layout.js';

const SessionBoardEncryptedRecordContentV1Schema = z.object({
  t: z.literal('encrypted'),
  c: z.string().min(1),
}).strict();

export const SessionBoardItemRecordContentV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: SessionSurfaceItemV1Schema }).strict(),
  SessionBoardEncryptedRecordContentV1Schema,
]);

export const SessionBoardLayoutRecordContentV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: SessionBoardLayoutV1Schema }).strict(),
  SessionBoardEncryptedRecordContentV1Schema,
]);

/**
 * The existing item row that participates in an `item.place` layout write.
 * The aggregate verifies this exact revision in the same transaction as the
 * layout CAS, so a concurrent item removal cannot leave a dangling placement.
 */
export const SessionBoardItemPlacementParticipantV1Schema = z.object({
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema,
}).strict();
export type SessionBoardItemPlacementParticipantV1 = Readonly<
  z.infer<typeof SessionBoardItemPlacementParticipantV1Schema>
>;

export const SessionBoardMutationV1Schema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('upsert_item'),
    itemId: SessionSurfaceItemIdSchema,
    itemContent: SessionBoardItemRecordContentV1Schema,
    expectedItemRevision: SessionSystemRecordRevisionSchema.nullable(),
    placement: z.object({
      layoutContent: SessionBoardLayoutRecordContentV1Schema,
      expectedLayoutRevision: SessionSystemRecordRevisionSchema.nullable(),
    }).strict().optional(),
  }).strict(),
  z.object({
    operation: z.literal('remove_item'),
    itemId: SessionSurfaceItemIdSchema,
    expectedItemRevision: SessionSystemRecordRevisionSchema,
    layoutContent: SessionBoardLayoutRecordContentV1Schema,
    expectedLayoutRevision: SessionSystemRecordRevisionSchema,
  }).strict(),
  z.object({
    operation: z.literal('update_layout'),
    layoutContent: SessionBoardLayoutRecordContentV1Schema,
    expectedLayoutRevision: SessionSystemRecordRevisionSchema.nullable(),
    /** Present only when the semantic edit adds an existing item placement. */
    itemPlacementParticipant: SessionBoardItemPlacementParticipantV1Schema.optional(),
  }).strict(),
]).superRefine((mutation, context) => {
  if (mutation.operation === 'upsert_item' && mutation.itemContent.t === 'plain'
    && !isSessionSurfaceItemIdentityCorrespondingV1(mutation.itemId, mutation.itemContent.v)) {
    context.addIssue({ code: 'custom', path: ['itemContent', 'v', 'source', 'instance', 'id'], message: 'Widget instance identity must match its Board item identity' });
  }
  if (mutation.operation === 'upsert_item' && mutation.expectedItemRevision === null && !mutation.placement) {
    context.addIssue({ code: 'custom', path: ['placement'], message: 'Item creation requires an atomic first placement' });
  }
});
export type SessionBoardMutationV1 = Readonly<z.infer<typeof SessionBoardMutationV1Schema>>;

export const SessionBoardMutationResultV1Schema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('upsert_item'),
    itemId: SessionSurfaceItemIdSchema,
    outcome: z.enum(['created', 'updated', 'unchanged']),
    itemRevision: SessionSystemRecordRevisionSchema,
    layoutRevision: SessionSystemRecordRevisionSchema.optional(),
  }).strict(),
  z.object({
    operation: z.literal('remove_item'),
    itemId: SessionSurfaceItemIdSchema,
    outcome: z.literal('removed'),
    layoutRevision: SessionSystemRecordRevisionSchema,
  }).strict(),
  z.object({
    operation: z.literal('update_layout'),
    outcome: z.enum(['created', 'updated', 'unchanged']),
    layoutRevision: SessionSystemRecordRevisionSchema,
  }).strict(),
]);
export type SessionBoardMutationResultV1 = Readonly<z.infer<typeof SessionBoardMutationResultV1Schema>>;

/** A valid response shape alone does not establish acknowledgement of this request. */
export function isSessionBoardMutationResultCorresponding(
  request: SessionBoardMutationV1,
  result: SessionBoardMutationResultV1,
): boolean {
  if (request.operation !== result.operation) return false;
  if (request.operation === 'update_layout') return true;
  if (result.operation === 'update_layout' || request.itemId !== result.itemId) return false;
  return request.operation !== 'upsert_item' || !request.placement
    || (result.operation === 'upsert_item' && result.layoutRevision !== undefined);
}
