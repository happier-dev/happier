import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionStoredMessageContentSchema } from '../messages/sessionStoredMessageContent.js';
import { SessionMessageAccountActorV1Schema } from '../messages/sessionMessageAccountActorV1.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';
import { SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1 } from '../messages/sessionTranscriptPageLimits.js';
import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { TurnIdSchema } from '../idsV1.js';
import { PendingLocalIdSchema } from '../pending/pendingLocalId.js';

export const SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 = SESSION_TRANSCRIPT_MAX_PAGE_ROWS_V1;

export const SessionFollowSourceProjectionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceSessionId: z.string().check(z.trim(), z.minLength(1)),
  localInputId: z.optional(PendingLocalIdSchema),
  relation: z._default(z.enum(['follower', 'manager', 'rule']), 'follower'),
  attachedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  readMode: z.optional(z.literal('incremental')),
  afterTranscriptSeq: z.number().check(z.int(), z.minimum(0)),
  observedTranscriptSeq: z.number().check(z.int(), z.minimum(0)),
  limit: z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1)),
}).check(z.refine((value) => value.afterTranscriptSeq <= value.observedTranscriptSeq), z.refine((value) => (value.relation === 'manager') === (value.attachedAt !== undefined), { path: ['attachedAt'] }), z.refine(value => !value.localInputId || value.relation === 'follower', { path: ['localInputId'] })));

export const SessionFollowSourceProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  encryptionMode: z.enum(['plain', 'e2ee']),
  metadata: z.nullable(z.string()),
  metadataLayoutVersion: z.optional(z.number().check(z.int())),
  archivedAt: z.nullable(z.number().check(z.int())),
  createdAt: z.number().check(z.int()),
  updatedAt: z.number().check(z.int()),
  active: z.boolean(),
  activeAt: z.number().check(z.int()),
  thinking: z.boolean(),
  thinkingAt: z.nullable(z.number().check(z.int())),
  latestTurnStatus: z.nullable(z.string()),
  latestTurnId: z.optional(z.nullable(TurnIdSchema)),
  lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
  latestTurnStatusObservedAt: z.nullable(z.number().check(z.int())),
  latestReadyEventSeq: z.nullable(z.number().check(z.int())),
  latestReadyEventAt: z.nullable(z.number().check(z.int())),
  meaningfulActivityAt: z.nullable(z.number().check(z.int())),
  agentStateVersion: z.number().check(z.int(), z.minimum(0)),
  agentState: z.optional(z.nullable(z.string())),
  pendingReviewRuns: z.optional(z.number().check(z.int(), z.nonnegative())),
  pendingPermissionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  pendingUserActionRequestCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  pendingRequestObservedAt: z.optional(z.nullable(z.number().check(z.int()))),
  pendingCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  pendingBlockedCount: z.optional(z.number().check(z.int(), z.minimum(0))),
  runtimeActivityState: z.optional(z.nullable(z.string())),
  runtimeActivityActiveCount: z.optional(z.number().check(z.int(), z.minimum(0))),
}));

export const SessionFollowSourceProjectionMessageV1Schema = lazyZodSchema(() => z.strictObject({
  seq: z.number().check(z.int(), z.minimum(0)),
  localId: z.nullable(z.string()),
  content: SessionStoredMessageContentSchema,
  messageRole: z.optional(SessionMessageRoleSchema),
  createdAt: z.number().check(z.int()),
  accountActor: z.optional(z.nullable(SessionMessageAccountActorV1Schema)),
}));

export const SessionFollowSourceProjectionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  source: SessionFollowSourceProjectionV1Schema,
  messages: z.array(SessionFollowSourceProjectionMessageV1Schema).check(z.maxLength(SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1)),
  hasMore: z.boolean(),
}));

export type SessionFollowSourceProjectionRequestV1 = z.infer<typeof SessionFollowSourceProjectionRequestV1Schema>;
export type SessionFollowSourceProjectionResponseV1 = z.infer<typeof SessionFollowSourceProjectionResponseV1Schema>;
