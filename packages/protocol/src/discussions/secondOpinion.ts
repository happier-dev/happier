import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionMessageRefV1Schema } from '../sessions/messages/sessionMessageRefV1.js';
import { DocPassageRefV1Schema } from '../artifacts/artifactCollaborationV1.js';
import { ExecutableParticipantSelectionV1Schema } from './executableParticipants.js';
import { DiscussionIdSchema, DiscussionSessionParticipantRefV1Schema } from './references.js';
import { DiscussionInitialAccountParticipantsV1Schema } from './participants.js';
import { DiscussionDocPassageReplyTargetV1Schema } from './replyTargets.js';
import { DiscussionErrorCodeV1Schema } from './api.js';

export const DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1 = '/v1/discussions/second-opinion/preview';

const SessionSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session'), message: SessionMessageRefV1Schema,
}));
export const DiscussionSecondOpinionSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionSourceV1Schema,
  z.strictObject({ kind: z.literal('doc_passage'), passage: DocPassageRefV1Schema }),
]));
export type DiscussionSecondOpinionSourceV1 = z.infer<typeof DiscussionSecondOpinionSourceV1Schema>;

/** Preview carries only routing identity, never the passage quote or the question. */
export const DiscussionSecondOpinionPreviewSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionSourceV1Schema, DiscussionDocPassageReplyTargetV1Schema,
]));
export type DiscussionSecondOpinionPreviewSourceV1 = z.infer<typeof DiscussionSecondOpinionPreviewSourceV1Schema>;

export const DiscussionSecondOpinionReviewerV1Schema = lazyZodSchema(() => z.strictObject({
  selection: ExecutableParticipantSelectionV1Schema,
  sourceAccess: z.optional(z.enum(['read', 'quote_only'])),
  participantSlotId: z.optional(DiscussionIdSchema),
}).check(z.refine(value => value.selection.kind !== 'model' || value.participantSlotId !== undefined,
  'A selected model requires its retry-stable participant slot')));
export type DiscussionSecondOpinionReviewerV1 = z.infer<typeof DiscussionSecondOpinionReviewerV1Schema>;

export const DiscussionSecondOpinionPreviewInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: DiscussionSecondOpinionPreviewSourceV1Schema,
  reviewers: z.array(DiscussionSecondOpinionReviewerV1Schema),
  participants: z.optional(DiscussionInitialAccountParticipantsV1Schema),
  publisherSessionId: z.optional(DiscussionSessionParticipantRefV1Schema.shape.sessionId),
}));
export type DiscussionSecondOpinionPreviewInputV1 = z.infer<typeof DiscussionSecondOpinionPreviewInputV1Schema>;

export const DiscussionSecondOpinionDisclosureV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['unavailable', 'same_session', 'configurer_not_allowed',
    'destination_runtime_not_allowed', 'destination_audience_broader', 'destination_public']) }),
]));
export const DiscussionSecondOpinionPreviewV1Schema = lazyZodSchema(() => z.strictObject({
  source: DiscussionSecondOpinionPreviewSourceV1Schema,
  sourceAudienceAccountIds: z.array(DiscussionIdSchema),
  sourceContentReady: z.boolean(),
  discussionAudienceAccountIds: z.array(DiscussionIdSchema),
  missingDiscussionSourceAccountIds: z.array(DiscussionIdSchema),
  discussionDisclosure: DiscussionSecondOpinionDisclosureV1Schema,
  canGrantSource: z.boolean(),
  publisher: z.optional(z.strictObject({
    sessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
    answerPolicy: z.literal('when_addressed'),
    audienceAccountIds: z.array(DiscussionIdSchema),
    disclosure: DiscussionSecondOpinionDisclosureV1Schema,
  })),
  reviewers: z.array(z.strictObject({
    selection: ExecutableParticipantSelectionV1Schema,
    sourceAccess: z.enum(['read', 'quote_only']),
    participantSlotId: z.optional(DiscussionIdSchema),
    runtimeAccountId: z.nullable(DiscussionIdSchema),
    audienceAccountIds: z.array(DiscussionIdSchema),
    missingSourceAccountIds: z.array(DiscussionIdSchema),
    canGrantSource: z.boolean(),
    disclosure: DiscussionSecondOpinionDisclosureV1Schema,
  })),
}));
export type DiscussionSecondOpinionPreviewV1 = z.infer<typeof DiscussionSecondOpinionPreviewV1Schema>;

/** Only an explicit read grant can repair a missing source audience, never another admission refusal. */
export function isDiscussionSecondOpinionSourceGrantRepairableV1(audience: Readonly<{
  disclosure: Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
  sourceAccess: string;
  missingSourceAccountIds: readonly string[];
  canGrantSource: boolean;
}> | null): boolean {
  return audience !== null && audience.sourceAccess === 'read' && audience.canGrantSource
    && audience.missingSourceAccountIds.length > 0
    && (audience.disclosure.ok || audience.disclosure.reason === 'destination_audience_broader');
}

/** Shared by the preview's Ask gate and execution. This plans real grants; it never commits them. */
export function resolveDiscussionSecondOpinionSourceGrantsV1(preview: DiscussionSecondOpinionPreviewV1):
  | Readonly<{ ok: true; accountIds: string[] }>
  | Readonly<{ ok: false; errorCode: 'encryption_material_unavailable' | 'discussion_access_forbidden' }> {
  if (!preview.sourceContentReady) return { ok: false, errorCode: 'encryption_material_unavailable' };
  if (preview.publisher && !preview.publisher.disclosure.ok) return { ok: false, errorCode: 'discussion_access_forbidden' };
  const audiences = [{ disclosure: preview.discussionDisclosure, sourceAccess: 'read',
    missingSourceAccountIds: preview.missingDiscussionSourceAccountIds, canGrantSource: preview.canGrantSource }, ...preview.reviewers];
  for (const audience of audiences) {
    if ((!audience.disclosure.ok || audience.missingSourceAccountIds.length > 0)
      // People-only Discuss uses the create Action, which never commits source grants.
      && (preview.reviewers.length === 0 || !isDiscussionSecondOpinionSourceGrantRepairableV1(audience))) {
      return { ok: false, errorCode: 'discussion_access_forbidden' };
    }
  }
  return { ok: true, accountIds: [...new Set(audiences.flatMap(audience => audience.missingSourceAccountIds))] };
}
export const DiscussionSecondOpinionPreviewResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), value: DiscussionSecondOpinionPreviewV1Schema }),
  z.strictObject({ ok: z.literal(false), error: DiscussionErrorCodeV1Schema }),
]));
export type DiscussionSecondOpinionPreviewResponseV1 = z.infer<typeof DiscussionSecondOpinionPreviewResponseV1Schema>;
