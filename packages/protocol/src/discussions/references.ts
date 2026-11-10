import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionIdSchema as DiscussionIdProtocolSchema, SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';

const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

/** The existing indexed persistence bound, not a new product limit. */
export const DiscussionIdSchema = asProtocolZod(DiscussionIdProtocolSchema);
export type DiscussionId = z.infer<typeof DiscussionIdSchema>;

export const DiscussionMessageIdSchema = DiscussionIdSchema;
export type DiscussionMessageId = z.infer<typeof DiscussionMessageIdSchema>;

/** Caller-chosen retry identity; never authority to adopt another Account's result. */
export const DiscussionLocalIdSchema = DiscussionIdSchema;
export type DiscussionLocalId = z.infer<typeof DiscussionLocalIdSchema>;
export const DiscussionAccountIdSchema = DiscussionIdSchema;

/** Human invitations are grants; this reference does not grant membership. */
export const DiscussionAccountParticipantRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'), accountId: DiscussionAccountIdSchema,
}));
export type DiscussionAccountParticipantRefV1 = z.infer<typeof DiscussionAccountParticipantRefV1Schema>;

/** Bots and model participants use their actual Session identity. */
export const DiscussionSessionParticipantRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema),
}));
export type DiscussionSessionParticipantRefV1 = z.infer<typeof DiscussionSessionParticipantRefV1Schema>;
export const DiscussionParticipantRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  DiscussionAccountParticipantRefV1Schema, DiscussionSessionParticipantRefV1Schema,
]));
export type DiscussionParticipantRefV1 = z.infer<typeof DiscussionParticipantRefV1Schema>;

/** Immutable server classification on the committed message, never a post operand. */
export const DiscussionMessageAddressingV1Schema = lazyZodSchema(() => z.strictObject({
  throughSeq: z.number().check(z.int(), z.minimum(1)),
  participantSessionIds: z.array(DiscussionSessionParticipantRefV1Schema.shape.sessionId).check(
    z.refine(ids => new Set(ids).size === ids.length, 'Addressed Sessions must be deduplicated'),
  ),
  /** Ambient watch starts are distinct from a person's explicit addressing. */
  watcherSessionIds: z.optional(z.array(DiscussionSessionParticipantRefV1Schema.shape.sessionId).check(
    z.refine(ids => new Set(ids).size === ids.length, 'Watching Sessions must be deduplicated'),
  )),
}).check(z.refine(value => value.watcherSessionIds?.every(id => value.participantSessionIds.includes(id)) !== false,
  'Watching Sessions must belong to the admitted participants')));
export type DiscussionMessageAddressingV1 = z.infer<typeof DiscussionMessageAddressingV1Schema>;

/** Receiver projection of the committed question; no lifecycle or launch dependency. */
export const DiscussionAddressingV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema, messageId: DiscussionIdSchema,
  throughSeq: DiscussionMessageAddressingV1Schema.shape.throughSeq,
  participantSessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
}));
export type DiscussionAddressingV1 = z.infer<typeof DiscussionAddressingV1Schema>;

/** Captured Home connection; Account scope is carried separately by its owner. */
export const DiscussionAddressV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1), z.regex(NO_OUTER_WHITESPACE_PATTERN)),
  discussionId: DiscussionIdSchema,
}));
export type DiscussionAddressV1 = z.infer<typeof DiscussionAddressV1Schema>;

/** Committed references stay independent of message hydration and runtime launch. */
export const DiscussionMessageRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('discussion'), discussion: DiscussionAddressV1Schema, messageId: DiscussionMessageIdSchema,
}));
export type DiscussionMessageRefV1 = z.infer<typeof DiscussionMessageRefV1Schema>;
export const CoordinationMessageRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionMessageRefV1Schema, DiscussionMessageRefV1Schema,
]));
export type CoordinationMessageRefV1 = z.infer<typeof CoordinationMessageRefV1Schema>;

/** Immutable display provenance; no content, runtime admission or access authority. */
export const DiscussionSelectionSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('discussion'),
  serverId: DiscussionAddressV1Schema.shape.serverId,
  discussionId: DiscussionIdSchema,
  messageIds: z.array(DiscussionMessageIdSchema).check(z.minLength(1), z.refine((value) => new Set(value).size === value.length, 'Selected discussion message ids must be deduplicated')),
  draftCorrelationId: z.optional(DiscussionIdSchema),
}));
export type DiscussionSelectionSourceV1 = z.infer<typeof DiscussionSelectionSourceV1Schema>;
