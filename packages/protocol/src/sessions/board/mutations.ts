import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionSystemRecordRevisionSchema } from '../system/records/sessionSystemRecordRevision.js';
import { SessionSurfaceItemIdSchema } from './ids.js';
import { SessionSurfaceItemV1Schema, SessionSurfaceItemDestinationV1Schema, isSessionSurfaceItemIdentityCorrespondingV1 } from './item.js';
import { SessionBoardLayoutV1Schema } from './layout.js';

const SessionBoardEncryptedRecordContentV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.literal('encrypted'),
  c: z.string().check(z.minLength(1)),
}));

export const SessionBoardItemRecordContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionSurfaceItemV1Schema }),
  SessionBoardEncryptedRecordContentV1Schema,
]));

export const SessionBoardLayoutRecordContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: SessionBoardLayoutV1Schema }),
  SessionBoardEncryptedRecordContentV1Schema,
]));

/**
 * The existing item row that participates in an `item.place` layout write.
 * The aggregate verifies this exact revision in the same transaction as the
 * layout CAS, so a concurrent item removal cannot leave a dangling placement.
 */
export const SessionBoardItemPlacementParticipantV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: SessionSurfaceItemIdSchema,
  expectedItemRevision: SessionSystemRecordRevisionSchema,
}));
export type SessionBoardItemPlacementParticipantV1 = Readonly<
  z.infer<typeof SessionBoardItemPlacementParticipantV1Schema>
>;

export const SessionBoardMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('upsert_item'),
    itemId: SessionSurfaceItemIdSchema,
    itemContent: SessionBoardItemRecordContentV1Schema,
    expectedItemRevision: z.nullable(SessionSystemRecordRevisionSchema),
    destination: z.optional(SessionSurfaceItemDestinationV1Schema),
    placement: z.optional(z.strictObject({
      layoutContent: SessionBoardLayoutRecordContentV1Schema,
      expectedLayoutRevision: z.nullable(SessionSystemRecordRevisionSchema),
    })),
  }),
  z.strictObject({
    operation: z.literal('remove_item'),
    itemId: SessionSurfaceItemIdSchema,
    expectedItemRevision: SessionSystemRecordRevisionSchema,
    layoutContent: z.optional(SessionBoardLayoutRecordContentV1Schema),
    expectedLayoutRevision: z.optional(SessionSystemRecordRevisionSchema),
  }),
  z.strictObject({
    operation: z.literal('update_layout'),
    layoutContent: SessionBoardLayoutRecordContentV1Schema,
    expectedLayoutRevision: z.nullable(SessionSystemRecordRevisionSchema),
    /** Present only when the semantic edit adds an existing item placement. */
    itemPlacementParticipant: z.optional(SessionBoardItemPlacementParticipantV1Schema),
  }),
]).check(z.superRefine((mutation, context) => {
  if (mutation.operation === 'upsert_item' && mutation.itemContent.t === 'plain'
    && !isSessionSurfaceItemIdentityCorrespondingV1(mutation.itemId, mutation.itemContent.v)) {
    context.addIssue({ code: 'custom', path: ['itemContent', 'v', 'source', 'instance', 'id'], message: 'Widget instance identity must match its Board item identity' });
  }
  if (mutation.operation === 'upsert_item' && mutation.destination === 'transcript' && mutation.placement) {
    context.addIssue({ code: 'custom', path: ['placement'], message: 'Transcript destination does not modify Board layout' });
  }
  if (mutation.operation === 'upsert_item' && mutation.itemContent.t === 'plain' && mutation.destination !== undefined
    && mutation.itemContent.v.destination !== undefined && mutation.destination !== mutation.itemContent.v.destination) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'Destination must match stored item intent' });
  }
  if (mutation.operation === 'upsert_item' && mutation.expectedItemRevision === null) {
    const destination = mutation.destination ?? (mutation.itemContent.t === 'plain'
      ? mutation.itemContent.v.destination : undefined) ?? (mutation.placement ? 'board' : 'transcript');
    if ((destination === 'board' || destination === 'both') && !mutation.placement) {
      context.addIssue({ code: 'custom', path: ['placement'], message: 'Board item creation requires an atomic first placement' });
    }
  }
  if (mutation.operation === 'remove_item' && (mutation.layoutContent === undefined) !== (mutation.expectedLayoutRevision === undefined)) {
    context.addIssue({ code: 'custom', path: ['layoutContent'], message: 'Layout removal requires both content and revision operands' });
  }
})));
export type SessionBoardMutationV1 = Readonly<z.infer<typeof SessionBoardMutationV1Schema>>;

/** Transcript item mutations have no Board layout admission or persistence effects. */
export function sessionBoardMutationUsesLayoutV1(mutation: SessionBoardMutationV1): boolean {
  return mutation.operation === 'update_layout'
    || (mutation.operation === 'upsert_item' ? mutation.placement !== undefined : mutation.layoutContent !== undefined);
}

export const SessionBoardMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('upsert_item'),
    itemId: SessionSurfaceItemIdSchema,
    outcome: z.enum(['created', 'updated', 'unchanged']),
    itemRevision: SessionSystemRecordRevisionSchema,
    layoutRevision: z.optional(SessionSystemRecordRevisionSchema),
  }),
  z.strictObject({
    operation: z.literal('remove_item'),
    itemId: SessionSurfaceItemIdSchema,
    outcome: z.literal('removed'),
    layoutRevision: z.optional(SessionSystemRecordRevisionSchema),
  }),
  z.strictObject({
    operation: z.literal('update_layout'),
    outcome: z.enum(['created', 'updated', 'unchanged']),
    layoutRevision: SessionSystemRecordRevisionSchema,
  }),
]));
export type SessionBoardMutationResultV1 = Readonly<z.infer<typeof SessionBoardMutationResultV1Schema>>;

/** A valid response shape alone does not establish acknowledgement of this request. */
export function isSessionBoardMutationResultCorresponding(
  request: SessionBoardMutationV1,
  result: SessionBoardMutationResultV1,
): boolean {
  if (request.operation !== result.operation) return false;
  if (request.operation === 'update_layout') return true;
  if (result.operation === 'update_layout' || request.itemId !== result.itemId) return false;
  if (request.operation === 'remove_item') return result.operation === 'remove_item'
    && (request.layoutContent === undefined || result.layoutRevision !== undefined);
  return request.operation !== 'upsert_item' || !request.placement
    || (result.operation === 'upsert_item' && result.layoutRevision !== undefined);
}
