import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionAccountIdSchema, DiscussionIdSchema, DiscussionAccountParticipantRefV1Schema,
  DiscussionSessionParticipantRefV1Schema, DiscussionParticipantRefV1Schema } from './references.js';
export { DiscussionAccountParticipantRefV1Schema, DiscussionSessionParticipantRefV1Schema, DiscussionParticipantRefV1Schema,
  DiscussionAddressingV1Schema, DiscussionMessageAddressingV1Schema } from './references.js';
export type { DiscussionAccountParticipantRefV1, DiscussionSessionParticipantRefV1, DiscussionParticipantRefV1,
  DiscussionAddressingV1, DiscussionMessageAddressingV1 } from './references.js';
import { DiscussionAccessGrantsListResponseV1Schema, DiscussionAccessGrantMutationResponseV1Schema } from './access.js';
import { DiscussionModelParticipantLaunchV1Schema } from './modelParticipantLaunch.js';
export { DiscussionModelParticipantLaunchV1Schema, projectDiscussionModelParticipantLaunchV1, type DiscussionModelParticipantLaunchV1 } from './modelParticipantLaunch.js';

export const DiscussionAnswerPolicyV1Schema = lazyZodSchema(() => z.enum([
  'when_addressed', 'reads_only', 'drafts_for_approval', 'watches_and_speaks_up',
]));
export type DiscussionAnswerPolicyV1 = z.infer<typeof DiscussionAnswerPolicyV1Schema>;

export const DiscussionSessionParticipantV1Schema = lazyZodSchema(() => z.strictObject({
  participant: DiscussionSessionParticipantRefV1Schema,
  answerPolicy: DiscussionAnswerPolicyV1Schema,
  createdAt: z.number().check(z.int()),
}));
export type DiscussionSessionParticipantV1 = z.infer<typeof DiscussionSessionParticipantV1Schema>;

/** A reserved model slot is not a routable Session until ordinary Session birth binds it. */
export const DiscussionModelParticipantRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('model'), participantSlotId: DiscussionIdSchema,
}));
export const DiscussionModelParticipantV1Schema = lazyZodSchema(() => z.strictObject({
  participant: DiscussionModelParticipantRefV1Schema,
  launch: DiscussionModelParticipantLaunchV1Schema,
  sessionId: z.nullable(DiscussionSessionParticipantRefV1Schema.shape.sessionId),
  answerPolicy: DiscussionAnswerPolicyV1Schema,
  createdAt: z.number().check(z.int()),
}));
export type DiscussionModelParticipantV1 = z.infer<typeof DiscussionModelParticipantV1Schema>;
export const DiscussionInviteResponseV1Schema = lazyZodSchema(() => z.extend(DiscussionAccessGrantMutationResponseV1Schema, {
  modelParticipant: z.optional(DiscussionModelParticipantV1Schema),
}));
export type DiscussionInviteResponseV1 = z.infer<typeof DiscussionInviteResponseV1Schema>;
export const DiscussionOwnedSessionV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema, participantSlotId: DiscussionIdSchema,
  sessionId: DiscussionSessionParticipantRefV1Schema.shape.sessionId,
}));
export type DiscussionOwnedSessionV1 = z.infer<typeof DiscussionOwnedSessionV1Schema>;
export const DiscussionRemoveParticipantResponseV1Schema = lazyZodSchema(() => z.extend(DiscussionAccessGrantMutationResponseV1Schema, {
  ownedSession: z.optional(DiscussionOwnedSessionV1Schema),
}));
export type DiscussionRemoveParticipantResponseV1 = z.infer<typeof DiscussionRemoveParticipantResponseV1Schema>;

export const DiscussionParticipantsListResponseV1Schema = lazyZodSchema(() => z.extend(DiscussionAccessGrantsListResponseV1Schema, {
  participants: z.array(z.union([DiscussionSessionParticipantV1Schema, DiscussionModelParticipantV1Schema])),
}));
export type DiscussionParticipantsListResponseV1 = z.infer<typeof DiscussionParticipantsListResponseV1Schema>;

export const DiscussionInitialParticipantsV1Schema = lazyZodSchema(() => z.array(DiscussionParticipantRefV1Schema).check(
  z.refine(participants => new Set(participants.map(participant => participant.kind === 'account'
    ? `account:${participant.accountId}` : `session:${participant.sessionId}`)).size === participants.length,
    { message: 'Discussion invitations must be deduplicated' }),
));
export type DiscussionInitialParticipantV1 = z.infer<typeof DiscussionInitialParticipantsV1Schema>[number];

/** Second-opinion reviewers have their separate executable selection; this audience list is people only. */
export const DiscussionInitialAccountParticipantsV1Schema = lazyZodSchema(() => z.array(DiscussionAccountParticipantRefV1Schema).check(
  z.refine(participants => new Set(participants.map(participant => participant.accountId)).size === participants.length,
    { message: 'Discussion invitations must be deduplicated' }),
));

/** Invitation selects a subject; runtime custody and disclosure are server-owned. */
export const DiscussionInviteRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ participant: DiscussionAccountParticipantRefV1Schema }),
  z.strictObject({ participant: DiscussionSessionParticipantRefV1Schema, answerPolicy: z.optional(DiscussionAnswerPolicyV1Schema) }),
  z.strictObject({ participant: z.extend(DiscussionModelParticipantRefV1Schema, { launch: DiscussionModelParticipantLaunchV1Schema }),
    answerPolicy: z.optional(DiscussionAnswerPolicyV1Schema) }),
]));
export type DiscussionInviteRequestV1 = z.infer<typeof DiscussionInviteRequestV1Schema>;

export const DiscussionRemoveParticipantRequestV1Schema = lazyZodSchema(() => z.strictObject({
  participant: z.union([DiscussionParticipantRefV1Schema, DiscussionModelParticipantRefV1Schema]),
}));
export type DiscussionRemoveParticipantRequestV1 = z.infer<typeof DiscussionRemoveParticipantRequestV1Schema>;

/** A speaking policy never invites a missing participant or selects a human grant. */
export const DiscussionParticipantPolicySetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  participant: z.union([DiscussionSessionParticipantRefV1Schema, DiscussionModelParticipantRefV1Schema]),
  answerPolicy: DiscussionAnswerPolicyV1Schema,
}));
export type DiscussionParticipantPolicySetRequestV1 = z.infer<typeof DiscussionParticipantPolicySetRequestV1Schema>;

export const DiscussionOwnerTransferRequestV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: DiscussionAccountIdSchema,
}));
export type DiscussionOwnerTransferRequestV1 = z.infer<typeof DiscussionOwnerTransferRequestV1Schema>;

export const DiscussionParticipantRouteParamsV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
}));
