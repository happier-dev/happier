import { lazyZodSchema } from '../lazyZodSchema.js';
import { ResourceTeamShareScopeV1Schema } from '../teams/resourceGrantAccessV1.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { StrictSessionStoredMessageContentEnvelopeSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { SessionMessageAccountActorV1Schema } from '../sessions/messages/sessionMessageAccountActorV1.js';
import {
  DiscussionAccountIdSchema,
  DiscussionIdSchema,
  DiscussionLocalIdSchema,
  DiscussionMessageIdSchema,
  DiscussionProducerV1Schema,
} from './content.js';
import { refineDiscussionAccountActor } from './accountActorConsistency.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import { ResourceCallerAccessV1Schema } from '../teams/resourceGrantAccessV1.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from './replyTargets.js';
import { DiscussionMessageAddressingV1Schema, DiscussionSessionParticipantRefV1Schema } from './references.js';
import { DocEditProposalDispositionV1Schema } from './docEditProposalDispositionV1.js';
import { DiscussionAttachmentRemovedV1Schema } from './attachments.js';
import { SessionMessageReplyPublicationFailureV1Schema } from '../sessions/messages/sessionMessageReplyPublicationV1.js';
export { DocEditProposalDispositionV1Schema } from './docEditProposalDispositionV1.js';
export type { DocEditProposalDispositionV1 } from './docEditProposalDispositionV1.js';

/**
 * Effective, server-evaluated capabilities for one discussion and viewer. The
 * UI and routes never reconstruct these from share levels, Team roles, or
 * authorship.
 */
export const DiscussionCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  postMessages: z.boolean(),
  rename: z.boolean(),
  archive: z.boolean(),
  restore: z.boolean(),
  askAgent: z.boolean(),
  sendToSession: z.boolean(),
  manageAccess: z.boolean(),
  leave: z.boolean(),
}));
export type DiscussionCapabilitiesV1 = z.infer<typeof DiscussionCapabilitiesV1Schema>;

const SequenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));

/**
 * How many latest distinct message authors a discussion summary carries.
 *
 * The bound is the Collaboration row's avatar stack, which renders three
 * overlapping avatars before collapsing into a count. It is presentation
 * metadata, never a participant total or an authorization fact.
 */
export const DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1 = 3;

export const DiscussionLatestMessageV1Schema = lazyZodSchema(() => z.strictObject({
  id: DiscussionMessageIdSchema,
  localId: z.nullable(DiscussionLocalIdSchema),
  seq: z.number().check(z.int(), z.minimum(1)),
  authorAccountId: z.nullable(DiscussionAccountIdSchema),
  /** Stable sanitized actor identity; independent of current Presence/access. */
  accountActor: z.nullable(SessionMessageAccountActorV1Schema),
  /** Sanitized read projection of the original requester; never a friendship or membership inference. */
  requesterAccountActor: z.optional(z.nullable(SessionMessageAccountActorV1Schema)),
  producerV1: z.nullable(DiscussionProducerV1Schema),
  /** Original envelope, omitted by older producers or denied source admission; never a plaintext preview copy. */
  content: z.optional(createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema)),
  createdAt: z.number().check(z.int()),
}).check(z.superRefine(refineDiscussionAccountActor)));
export type DiscussionLatestMessageV1 = z.infer<typeof DiscussionLatestMessageV1Schema>;

/** Content-free outcome of the most recently admitted built-in Discussion round. */
export const DiscussionRoundOutcomeV1Schema = lazyZodSchema(() => z.strictObject({
  runId: z.string().check(z.minLength(1)),
  pattern: z.enum(['fresh_opinions', 'answer_and_review']),
  answerCount: SequenceSchema,
  synthesized: z.boolean(),
  settled: z.boolean(),
}));
export type DiscussionRoundOutcomeV1 = z.infer<typeof DiscussionRoundOutcomeV1Schema>;
export const DiscussionRoundOutcomeV1StoredSchema = createStoredReadSchema(DiscussionRoundOutcomeV1Schema);

export const DiscussionSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  sharedWithTeamScope: z.optional(ResourceTeamShareScopeV1Schema),
  id: DiscussionIdSchema,
  ownerAccountId: DiscussionAccountIdSchema,
  encryptionMode: AccountEncryptionModeSchema,
  anchor: z.nullable(DiscussionAnchorV1Schema),
  /** Absent on older responses; null means no known built-in round outcome. */
  roundOutcomeV1: z.optional(z.nullable(DiscussionRoundOutcomeV1Schema)),
  /** Active passage roots matching the Doc anchor; replies are not additional roots. */
  openCommentCount: z.optional(z.nullable(SequenceSchema)),
  access: ResourceCallerAccessV1Schema,
  keyReadiness: z.boolean(),
  /** The caller's recipient envelope; plaintext Discussions have no client key. */
  dataEncryptionKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  /** Non-content demand projected only when this caller already holds the Discussion DEK. */
  recipientKeyPreparationRequired: z.optional(z.boolean()),
  /** Projected only to the creating Account; other viewers receive null. */
  creationLocalId: z.nullable(DiscussionLocalIdSchema),
  titleContent: createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema),
  latestMessage: DiscussionLatestMessageV1Schema,
  /** Present only for Doc-scoped preparation; null is a known admission/key refusal. */
  firstMessage: z.optional(z.nullable(DiscussionMessageV1Schema)),
  messageSeq: SequenceSchema,
  /** null means no active tracked cursor. It never means implicit zero. */
  lastReadSeq: z.nullable(SequenceSchema),
  unreadCount: SequenceSchema,
  unreadMentionCount: SequenceSchema,
  recentAuthorAccountIds: z.array(DiscussionAccountIdSchema).check(z.maxLength(DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1)),
  /** Owner and explicitly invited people, never expanded Team/Group membership or historic authors. */
  participantAccounts: z.optional(z.array(SessionMessageAccountActorV1Schema)),
  /** Active executable bindings; display uses the existing admitted Session/Agent presentation owner. */
  participantSessionIds: z.optional(z.array(DiscussionSessionParticipantRefV1Schema.shape.sessionId)),
  archivedAt: z.nullable(z.number().check(z.int())),
  capabilities: DiscussionCapabilitiesV1Schema,
}));
export type DiscussionSummaryV1 = z.infer<typeof DiscussionSummaryV1Schema>;

/** Read-only receiver admission fact; not authored content or another reply obligation. */
export const DiscussionParticipantDeliveryV1Schema = lazyZodSchema(() => z.discriminatedUnion('disposition', [z.strictObject({
  participantSessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
  disposition: z.literal('pending'),
}), z.strictObject({
  participantSessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
  disposition: z.literal('held'),
  code: z.literal('session_input_target_unavailable'),
}), z.strictObject({
  participantSessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
  disposition: z.literal('failed'),
  failure: SessionMessageReplyPublicationFailureV1Schema,
}).check(z.refine(value => !value.failure.retryable, 'Only terminal publication refusals are failed deliveries'))]));
export type DiscussionParticipantDeliveryV1 = z.infer<typeof DiscussionParticipantDeliveryV1Schema>;

export const DiscussionMessageV1Schema = lazyZodSchema(() => z.strictObject({
  id: DiscussionMessageIdSchema,
  discussionId: DiscussionIdSchema,
  /** Projected only to the authoring Account; other viewers receive null. */
  localId: z.nullable(DiscussionLocalIdSchema),
  seq: z.number().check(z.int(), z.minimum(1)),
  authorAccountId: z.nullable(DiscussionAccountIdSchema),
  /** Stable sanitized actor identity; independent of current Presence/access. */
  accountActor: z.nullable(SessionMessageAccountActorV1Schema),
  /** Same authorized Account projection as the author; names are not persisted on the producer. */
  requesterAccountActor: z.optional(z.nullable(SessionMessageAccountActorV1Schema)),
  producerV1: z.nullable(DiscussionProducerV1Schema),
  content: createStoredReadSchema(StrictSessionStoredMessageContentEnvelopeSchema),
  mentionedAccountIds: z.array(DiscussionAccountIdSchema),
  /** Null/absent only for retained messages committed before executable addressing existed. */
  addressingV1: z.optional(z.nullable(DiscussionMessageAddressingV1Schema)),
  participantDeliveryV1: z.optional(z.array(DiscussionParticipantDeliveryV1Schema)),
  removedAttachments: z.optional(z.array(DiscussionAttachmentRemovedV1Schema)),
  replyTarget: z.optional(DiscussionReplyTargetV1Schema),
  docEditProposalDispositionV1: z.optional(DocEditProposalDispositionV1Schema),
  createdAt: z.number().check(z.int()),
}).check(z.superRefine(refineDiscussionAccountActor)));
export type DiscussionMessageV1 = z.infer<typeof DiscussionMessageV1Schema>;

/**
 * The Account-private aggregate the canonical Session projection owner wires
 * into Session list/detail. It contains no title, message body, another
 * Account's cursor, or access topology.
 */
export const DiscussionAttentionFactsV1Schema = lazyZodSchema(() => z.strictObject({
  unreadConversationCount: SequenceSchema,
  unreadMentionCount: SequenceSchema,
  latestActivityAt: z.nullable(z.number().check(z.int())),
}));
export type DiscussionAttentionFactsV1 = z.infer<typeof DiscussionAttentionFactsV1Schema>;

export const DiscussionReadCursorV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  lastReadSeq: SequenceSchema,
  didChange: z.boolean(),
}));
export type DiscussionReadCursorV1 = z.infer<typeof DiscussionReadCursorV1Schema>;

