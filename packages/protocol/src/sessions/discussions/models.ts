import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { StrictSessionStoredMessageContentEnvelopeSchema } from '../messages/sessionStoredMessageContent.js';
import { SessionMessageAccountActorV1Schema } from '../messages/sessionMessageAccountActorV1.js';
import {
  SessionDiscussionAccountIdSchema,
  SessionDiscussionIdSchema,
  SessionDiscussionLocalIdSchema,
  SessionDiscussionMessageIdSchema,
  SessionDiscussionProducerV1Schema,
} from './content.js';
import { refineDiscussionAccountActor } from './accountActorConsistency.js';

/**
 * Effective, server-evaluated capabilities for one discussion and viewer. The
 * UI and routes never reconstruct these from share levels, Team roles, or
 * authorship.
 */
export const SessionDiscussionCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  postMessages: z.boolean(),
  rename: z.boolean(),
  archive: z.boolean(),
  restore: z.boolean(),
  askAgent: z.boolean(),
  sendToSession: z.boolean(),
}).strict());
export type SessionDiscussionCapabilitiesV1 = z.infer<typeof SessionDiscussionCapabilitiesV1Schema>;

const SequenceSchema = lazyZodSchema(() => z.number().int().min(0));

/**
 * How many latest distinct message authors a discussion summary carries.
 *
 * The bound is the Collaboration row's avatar stack, which renders three
 * overlapping avatars before collapsing into a count. It is presentation
 * metadata, never a participant total or an authorization fact.
 */
export const SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1 = 3;

export const SessionDiscussionLatestMessageV1Schema = lazyZodSchema(() => z.object({
  id: SessionDiscussionMessageIdSchema,
  localId: SessionDiscussionLocalIdSchema.nullable(),
  seq: z.number().int().min(1),
  authorAccountId: SessionDiscussionAccountIdSchema.nullable(),
  /** Stable sanitized actor identity; independent of current Presence/access. */
  accountActor: SessionMessageAccountActorV1Schema.nullable(),
  producerV1: SessionDiscussionProducerV1Schema.nullable(),
  createdAt: z.number().int(),
}).strict().superRefine(refineDiscussionAccountActor));
export type SessionDiscussionLatestMessageV1 = z.infer<typeof SessionDiscussionLatestMessageV1Schema>;

export const SessionDiscussionSummaryV1Schema = lazyZodSchema(() => z.object({
  id: SessionDiscussionIdSchema,
  sessionId: SessionDiscussionIdSchema,
  /** Projected only to the creating Account; other viewers receive null. */
  creationLocalId: SessionDiscussionLocalIdSchema.nullable(),
  titleContent: StrictSessionStoredMessageContentEnvelopeSchema,
  latestMessage: SessionDiscussionLatestMessageV1Schema,
  messageSeq: SequenceSchema,
  /** null means no active tracked cursor. It never means implicit zero. */
  lastReadSeq: SequenceSchema.nullable(),
  unreadCount: SequenceSchema,
  unreadMentionCount: SequenceSchema,
  recentAuthorAccountIds: z.array(SessionDiscussionAccountIdSchema)
    .max(SESSION_DISCUSSION_RECENT_AUTHOR_AVATAR_STACK_V1),
  archivedAt: z.number().int().nullable(),
  capabilities: SessionDiscussionCapabilitiesV1Schema,
}).strict());
export type SessionDiscussionSummaryV1 = z.infer<typeof SessionDiscussionSummaryV1Schema>;

export const SessionDiscussionMessageV1Schema = lazyZodSchema(() => z.object({
  id: SessionDiscussionMessageIdSchema,
  discussionId: SessionDiscussionIdSchema,
  /** Projected only to the authoring Account; other viewers receive null. */
  localId: SessionDiscussionLocalIdSchema.nullable(),
  seq: z.number().int().min(1),
  authorAccountId: SessionDiscussionAccountIdSchema.nullable(),
  /** Stable sanitized actor identity; independent of current Presence/access. */
  accountActor: SessionMessageAccountActorV1Schema.nullable(),
  producerV1: SessionDiscussionProducerV1Schema.nullable(),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  mentionedAccountIds: z.array(SessionDiscussionAccountIdSchema),
  createdAt: z.number().int(),
}).strict().superRefine(refineDiscussionAccountActor));
export type SessionDiscussionMessageV1 = z.infer<typeof SessionDiscussionMessageV1Schema>;

/**
 * The Account-private aggregate the canonical Session projection owner wires
 * into Session list/detail. It contains no title, message body, another
 * Account's cursor, or access topology.
 */
export const SessionDiscussionAttentionFactsV1Schema = lazyZodSchema(() => z.object({
  unreadConversationCount: SequenceSchema,
  unreadMentionCount: SequenceSchema,
  latestActivityAt: z.number().int().nullable(),
}).strict());
export type SessionDiscussionAttentionFactsV1 = z.infer<typeof SessionDiscussionAttentionFactsV1Schema>;

export const SessionDiscussionReadCursorV1Schema = lazyZodSchema(() => z.object({
  discussionId: SessionDiscussionIdSchema,
  lastReadSeq: SequenceSchema,
  didChange: z.boolean(),
}).strict());
export type SessionDiscussionReadCursorV1 = z.infer<typeof SessionDiscussionReadCursorV1Schema>;
