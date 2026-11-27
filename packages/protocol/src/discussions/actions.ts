import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadRequestV1Schema, DiscussionAttachmentReadResultV1Schema, DiscussionAttachmentRemovedV1Schema, DiscussionAttachmentSourcesV1Schema, type DiscussionAttachmentSourceV1 } from './attachments.js';
export { DiscussionAttachmentReadInputV1Schema, DiscussionAttachmentReadResultV1Schema } from './attachments.js';
export type { DiscussionAttachmentReadInputV1, DiscussionAttachmentReadResultV1 } from './attachments.js';
import { DiscussionSettingsV1Schema, DiscussionSettingsResponseV1Schema } from './settings.js';
import { DiscussionSecondOpinionStartInputV1Schema, DiscussionSecondOpinionStartResultV1Schema } from './secondOpinionActions.js';
import { z } from '../zodRuntimePolicy.js';
import { refineDiscussionAccountActor } from './accountActorConsistency.js';
import { DiscussionCandidatesListInputV1Schema, DiscussionCandidatesListResultV1Schema } from './candidates.js';
export { DiscussionCandidatesListInputV1Schema, DiscussionCandidatesListResultV1Schema,
  DiscussionCandidateModelOptionV1Schema, DiscussionInviteCandidateV1Schema,
  projectDiscussionInviteCandidatesV1 } from './candidates.js';
export type { DiscussionCandidatesListInputV1, DiscussionCandidatesListResultV1, DiscussionInviteCandidateV1 } from './candidates.js';

import {
  DISCUSSION_MAX_PAGE_SIZE_V1,
  DiscussionListQueryV1Schema,
  isDiscussionMessagesSelectionValidV1,
} from './query.js';
import {
  DISCUSSION_ACTION_IDS_V1,
  type DiscussionActionIdV1,
} from './actionIds.js';
import {
  DiscussionIdSchema,
  DiscussionLocalIdSchema,
  DiscussionMessageContentV1Schema,
  DiscussionTitleV1Schema,
  readDiscussionAttachmentReferencesV1,
  type DiscussionMessageContentV1,
} from './content.js';
import {
  DiscussionReadCursorV1Schema,
  DiscussionSummaryV1Schema,
  DiscussionLatestMessageV1Schema,
  DiscussionMessageV1Schema,
} from './models.js';
import {
  DiscussionInitialParticipantsV1Schema,
  DiscussionInviteRequestV1Schema,
  DiscussionOwnerTransferRequestV1Schema,
  DiscussionParticipantRouteParamsV1Schema,
  DiscussionRemoveParticipantRequestV1Schema,
  DiscussionParticipantPolicySetRequestV1Schema,
  DiscussionModelParticipantRefV1Schema,
  DiscussionParticipantsListResponseV1Schema,
  DiscussionInviteResponseV1Schema,
  DiscussionOwnedSessionV1Schema,
  DiscussionRemoveParticipantResponseV1Schema,
} from './participants.js';
import { SessionSpawnNewResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionMessageReplyMutationResultV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { SessionTargetV1Schema } from '../actions/sessionTargetV1.js';
import { DiscussionAccountParticipantRefV1Schema } from './references.js';
import { DiscussionMessageWriteV1Schema, DiscussionAttentionTypeV1Schema } from './api.js';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from './replyTargets.js';
import { DiscussionListAnchorKindsV1Schema } from './listing/discussionListFilterV1.js';
import { TriageEntryRefV1Schema } from '../tasks/entryRefV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { DiscussionMessageRefV1Schema } from './messageRefs.js';
import {
  DiscussionAccessGrantSetRequestV1Schema,
  DiscussionAccessGrantRemoveRequestV1Schema,
  DiscussionAccessGrantsListResponseV1Schema,
  DiscussionAccessGrantMutationResponseV1Schema,
  DiscussionLeaveResponseV1Schema,
} from './access.js';

/**
 * A caller-chosen retry identity. It stays optional because most tool callers
 * have no durable identity to reuse; the executor mints one when it is absent.
 * It is never authority: the mutation owner binds it to its authenticated
 * author, so it can reconcile a lost response but can never adopt another
 * Account's result.
 */
const DiscussionActionLocalIdSchema = lazyZodSchema(() => z.optional(DiscussionLocalIdSchema));

const SequenceSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0)));

/**
 * The authored title as plaintext. Action inputs carry strict semantic
 * plaintext; the executor seals it through the Discussion's own key before
 * it reaches the storage route. A plaintext Action input is never registered as
 * the encrypted storage-route schema.
 */
const DiscussionActionTitleSchema = lazyZodSchema(() => DiscussionTitleV1Schema.shape.title);

function attachmentSourcesMatchContent(content: DiscussionMessageContentV1,
  sources: readonly DiscussionAttachmentSourceV1[] | undefined): boolean {
  if (sources === undefined) return true;
  const references = readDiscussionAttachmentReferencesV1(content);
  const ids = new Set(sources.map(source => source.blobId));
  return references.length === sources.length && references.every(reference => ids.has(reference.blobId));
}

const requireMatchingPostAttachments = z.refine<Readonly<{
  content: DiscussionMessageContentV1; attachmentSources?: readonly DiscussionAttachmentSourceV1[];
}>>(value => attachmentSourcesMatchContent(value.content, value.attachmentSources), {
  path: ['attachmentSources'], message: 'Attachment sources must match the message attachment leaves',
});

const requireValidReadingSelection = z.refine<Parameters<typeof isDiscussionMessagesSelectionValidV1>[0]>(isDiscussionMessagesSelectionValidV1,
  'Exact message selection and history paging are mutually exclusive');

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const DiscussionListInputV1Schema = lazyZodSchema(() => z.safeExtend(DiscussionListQueryV1Schema, {
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(DISCUSSION_MAX_PAGE_SIZE_V1))),
  anchorKinds: z.optional(DiscussionListAnchorKindsV1Schema),
  anchorTask: z.optional(asProtocolZod(TriageEntryRefV1Schema)),
}));
export type DiscussionListInputV1 = z.infer<typeof DiscussionListInputV1Schema>;

export const DiscussionGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
}));
export const DiscussionSettingsSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionGetInputV1Schema.shape, settings: DiscussionSettingsV1Schema,
}));
export type DiscussionGetInputV1 = z.infer<typeof DiscussionGetInputV1Schema>;

const DiscussionTaskOperandV1Schema = lazyZodSchema(() => z.strictObject({
  anchorTask: asProtocolZod(TriageEntryRefV1Schema),
}));
const DiscussionTargetedGetInputV1Schema = lazyZodSchema(() => z.union([
  DiscussionGetInputV1Schema, DiscussionTaskOperandV1Schema,
]));

/** Correlation is protected current-runtime context, never authored Action input. */
export const DiscussionPassInputV1Schema = DiscussionGetInputV1Schema;
export type DiscussionPassInputV1 = z.infer<typeof DiscussionPassInputV1Schema>;

export const DiscussionReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  messageId: z.optional(DiscussionIdSchema),
  localId: z.optional(DiscussionLocalIdSchema),
  beforeSeq: z.optional(z.number().check(z.int(), z.minimum(1))),
  afterSeq: z.optional(SequenceSchema),
  throughSeq: z.optional(SequenceSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(DISCUSSION_MAX_PAGE_SIZE_V1))),
}).check(requireValidReadingSelection));
export type DiscussionReadInputV1 = z.infer<typeof DiscussionReadInputV1Schema>;
const DiscussionTargetedReadInputV1Schema = lazyZodSchema(() => {
  const { discussionId: _discussionId, ...selection } = DiscussionReadInputV1Schema.shape;
  return z.union([DiscussionReadInputV1Schema, z.strictObject({ ...DiscussionTaskOperandV1Schema.shape, ...selection })
    .check(requireValidReadingSelection)]);
});

const DiscussionSessionParticipantTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session'), sessionId: SessionTargetV1Schema,
}));

export const DiscussionCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  creationLocalId: DiscussionActionLocalIdSchema,
  attachmentSources: z.optional(DiscussionAttachmentSourcesV1Schema),
  title: DiscussionActionTitleSchema,
  anchor: z.optional(DiscussionAnchorV1Schema),
  participants: z.optional(z.array(z.union([DiscussionAccountParticipantRefV1Schema, DiscussionSessionParticipantTargetV1Schema])).check(
    z.refine(participants => DiscussionInitialParticipantsV1Schema.safeParse(participants.filter(participant =>
      participant.kind === 'account' || typeof participant.sessionId === 'string')).success,
    { message: 'Discussion invitations must be deduplicated' }),
  )),
  firstMessage: z.strictObject({
    localId: DiscussionActionLocalIdSchema,
    content: DiscussionMessageContentV1Schema,
    mentionedAccountIds: z.optional(DiscussionMessageWriteV1Schema.shape.mentionedAccountIds),
    mentionedSessionIds: DiscussionMessageWriteV1Schema.shape.mentionedSessionIds,
    replyTarget: z.optional(DiscussionReplyTargetV1Schema),
  }),
}).check(z.refine(value => value.creationLocalId === undefined
  || value.firstMessage.localId === undefined
  || value.creationLocalId !== value.firstMessage.localId, {
  path: ['firstMessage', 'localId'],
  message: 'Discussion creation and first-message retry identities must be distinct',
}), z.refine(value => attachmentSourcesMatchContent(value.firstMessage.content, value.attachmentSources), {
  path: ['attachmentSources'], message: 'Attachment sources must match the message attachment leaves',
})));
export type DiscussionCreateInputV1 = z.infer<typeof DiscussionCreateInputV1Schema>;

export const DiscussionPostInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  attachmentSources: z.optional(DiscussionAttachmentSourcesV1Schema),
  localId: DiscussionActionLocalIdSchema,
  content: DiscussionMessageContentV1Schema,
  mentionedAccountIds: z.optional(DiscussionMessageWriteV1Schema.shape.mentionedAccountIds),
  mentionedSessionIds: DiscussionMessageWriteV1Schema.shape.mentionedSessionIds,
  replyTarget: z.optional(DiscussionReplyTargetV1Schema),
}).check(requireMatchingPostAttachments));
export type DiscussionPostInputV1 = z.infer<typeof DiscussionPostInputV1Schema>;

/** Human replies use the same committed post writer; addressed turns are host-bound. */
export const DiscussionReplyInputV1Schema = lazyZodSchema(() => z.safeExtend(DiscussionPostInputV1Schema, {
  replyTarget: DiscussionReplyTargetV1Schema,
}));
export type DiscussionReplyInputV1 = z.infer<typeof DiscussionReplyInputV1Schema>;

const DiscussionTargetedPostInputV1Schema = lazyZodSchema(() => {
  const { discussionId: _discussionId, ...message } = DiscussionPostInputV1Schema.shape;
  return z.strictObject({ ...DiscussionTaskOperandV1Schema.shape, ...message }).check(requireMatchingPostAttachments);
});

export const DiscussionRenameInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  title: DiscussionActionTitleSchema,
}));
export type DiscussionRenameInputV1 = z.infer<typeof DiscussionRenameInputV1Schema>;

export const DiscussionLifecycleInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
}));
export type DiscussionLifecycleInputV1 = z.infer<typeof DiscussionLifecycleInputV1Schema>;

export const DiscussionReadStateSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
  lastReadSeq: SequenceSchema,
}));
export type DiscussionReadStateSetInputV1 = z.infer<typeof DiscussionReadStateSetInputV1Schema>;

export const DiscussionInviteInputV1Schema = lazyZodSchema(() => z.union([
  z.safeExtend(DiscussionInviteRequestV1Schema.def.options[0], DiscussionGetInputV1Schema.shape),
  z.extend(DiscussionInviteRequestV1Schema.def.options[1], {
    ...DiscussionGetInputV1Schema.shape, participant: DiscussionSessionParticipantTargetV1Schema,
  }),
  z.safeExtend(DiscussionInviteRequestV1Schema.def.options[2], DiscussionGetInputV1Schema.shape),
]));
export type DiscussionInviteInputV1 = z.infer<typeof DiscussionInviteInputV1Schema>;

export const DiscussionParticipantRemoveInputV1Schema = lazyZodSchema(() => z.safeExtend(
  DiscussionRemoveParticipantRequestV1Schema, DiscussionParticipantRouteParamsV1Schema.shape,
));
export type DiscussionParticipantRemoveInputV1 = z.infer<typeof DiscussionParticipantRemoveInputV1Schema>;

export const DiscussionParticipantPolicySetInputV1Schema = lazyZodSchema(() => z.extend(
  DiscussionParticipantPolicySetRequestV1Schema, { ...DiscussionGetInputV1Schema.shape,
    participant: z.union([DiscussionSessionParticipantTargetV1Schema, DiscussionModelParticipantRefV1Schema]),
  },
));
export type DiscussionParticipantPolicySetInputV1 = z.infer<typeof DiscussionParticipantPolicySetInputV1Schema>;

/** Self-leave has no caller-selected Account or principal operand. */
export const DiscussionLeaveInputV1Schema = DiscussionGetInputV1Schema;
export type DiscussionLeaveInputV1 = z.infer<typeof DiscussionLeaveInputV1Schema>;

export const DiscussionOwnerTransferInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionGetInputV1Schema.shape,
  ...DiscussionOwnerTransferRequestV1Schema.shape,
}));
export type DiscussionOwnerTransferInputV1 = z.infer<typeof DiscussionOwnerTransferInputV1Schema>;

export const DiscussionAccessGrantSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionGetInputV1Schema.shape,
  ...DiscussionAccessGrantSetRequestV1Schema.shape,
}));
export type DiscussionAccessGrantSetInputV1 = z.infer<typeof DiscussionAccessGrantSetInputV1Schema>;

export const DiscussionAccessGrantRemoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionGetInputV1Schema.shape,
  ...DiscussionAccessGrantRemoveRequestV1Schema.shape,
}));
export type DiscussionAccessGrantRemoveInputV1 = z.infer<typeof DiscussionAccessGrantRemoveInputV1Schema>;

// ---------------------------------------------------------------------------
// Opened (decrypted) projections
// ---------------------------------------------------------------------------

/**
 * A summary whose title the executor opened through the Discussion's own key.
 *
 * `title` is nullable because missing or invalid E2EE material is a real state:
 * the executor reports the row and marks the page `incomplete` rather than
 * interpreting ciphertext as plaintext or silently dropping the discussion.
 */
export const DiscussionOpenedSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  ...z.omit(DiscussionSummaryV1Schema, { titleContent: true, taskKey: true }).shape,
  title: z.nullable(z.string()),
  firstMessage: z.optional(z.nullable(DiscussionOpenedMessageV1Schema)),
  latestMessage: z.strictObject({
    ...DiscussionLatestMessageV1Schema.shape,
    /** Null when the original content cannot be opened; absent on older summary responses. */
    content: z.optional(z.nullable(DiscussionMessageContentV1Schema)),
  }).check(z.superRefine(refineDiscussionAccountActor)),
}));
export type DiscussionOpenedSummaryV1 = z.infer<typeof DiscussionOpenedSummaryV1Schema>;

export const DiscussionOpenedMessageV1Schema = lazyZodSchema(() => z.strictObject({
  ...DiscussionMessageV1Schema.shape,
  messageRef: DiscussionMessageRefV1Schema,
  /** `null` when this viewer could not open the row; never a plaintext guess. */
  content: z.nullable(DiscussionMessageContentV1Schema),
}).check(
  z.superRefine(refineDiscussionAccountActor),
  z.refine(message => message.messageRef.messageId === message.id
    && message.messageRef.discussion.discussionId === message.discussionId, {
    path: ['messageRef'], message: 'Committed reference must identify this Discussion message',
  }),
));
export type DiscussionOpenedMessageV1 = z.infer<typeof DiscussionOpenedMessageV1Schema>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const ResultEnvelopeShape = {
  v: z.literal(1),
  serverId: z.string().check(z.trim(), z.minLength(1)),
} as const;

export const DiscussionListResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussions: z.array(DiscussionOpenedSummaryV1Schema),
  nextCursor: z.nullable(z.string()),
  /** At least one row on this page could not be opened for the caller. */
  incomplete: z.boolean(),
}));
export type DiscussionListResultV1 = z.infer<typeof DiscussionListResultV1Schema>;

/** The qualified client projection of the same owner-native attention page. */
export const DiscussionAttentionResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussions: z.array(z.strictObject({
    discussion: DiscussionOpenedSummaryV1Schema,
    occurrences: z.array(z.strictObject({ message: DiscussionOpenedMessageV1Schema, type: DiscussionAttentionTypeV1Schema })),
  })),
  nextCursor: z.nullable(z.string()),
  incomplete: z.boolean(),
}));
export type DiscussionAttentionResultV1 = z.infer<typeof DiscussionAttentionResultV1Schema>;

export const DiscussionDetailsResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussion: DiscussionOpenedSummaryV1Schema,
  ownedSessions: z.optional(z.array(DiscussionOwnedSessionV1Schema)),
}));
export type DiscussionDetailsResultV1 = z.infer<typeof DiscussionDetailsResultV1Schema>;

export const DiscussionReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussionId: DiscussionIdSchema,
  messages: z.array(DiscussionOpenedMessageV1Schema),
  hasMoreOlder: z.boolean(),
  messageSeq: SequenceSchema,
  incomplete: z.boolean(),
}));
export type DiscussionReadResultV1 = z.infer<typeof DiscussionReadResultV1Schema>;

export const DiscussionCreateResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  discussion: DiscussionOpenedSummaryV1Schema,
  firstMessage: DiscussionOpenedMessageV1Schema,
}));
export type DiscussionCreateResultV1 = z.infer<typeof DiscussionCreateResultV1Schema>;

export const DiscussionPostResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  message: DiscussionOpenedMessageV1Schema,
  messageSeq: z.number().check(z.int(), z.minimum(1)),
}));
export type DiscussionPostResultV1 = z.infer<typeof DiscussionPostResultV1Schema>;

export const DiscussionReadStateResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...ResultEnvelopeShape,
  cursor: DiscussionReadCursorV1Schema,
}));
export type DiscussionReadStateResultV1 = z.infer<typeof DiscussionReadStateResultV1Schema>;

/** The slot reservation and ordinary Session start remain distinguishable on uncertainty. */
export const DiscussionInviteResultV1Schema = lazyZodSchema(() => z.extend(DiscussionInviteResponseV1Schema, {
  sessionStart: z.optional(SessionSpawnNewResultV1Schema),
}).check(z.refine(value => value.sessionStart?.type !== 'success'
  || value.modelParticipant?.sessionId === value.sessionStart.sessionId, {
  path: ['modelParticipant', 'sessionId'], message: 'The Session start must match the reserved participant',
})));
export type DiscussionInviteResultV1 = z.infer<typeof DiscussionInviteResultV1Schema>;

export const DISCUSSION_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'discussion.list': DiscussionListInputV1Schema,
  'discussion.get': DiscussionTargetedGetInputV1Schema,
  'discussion.settings.get': DiscussionGetInputV1Schema,
  'discussion.settings.set': DiscussionSettingsSetInputV1Schema,
  'discussion.read': DiscussionTargetedReadInputV1Schema,
  'discussion.attachment.read': DiscussionAttachmentReadInputV1Schema,
  'discussion.attachment.remove': DiscussionAttachmentReadRequestV1Schema,
  'discussion.create': DiscussionCreateInputV1Schema,
  'discussion.second_opinion.start': DiscussionSecondOpinionStartInputV1Schema,
  'discussion.post': lazyZodSchema(() => z.union([DiscussionPostInputV1Schema, DiscussionTargetedPostInputV1Schema])),
  'discussion.reply': lazyZodSchema(() => z.union([DiscussionReplyInputV1Schema,
    z.safeExtend(DiscussionTargetedPostInputV1Schema, { replyTarget: DiscussionReplyTargetV1Schema })])),
  'discussion.pass': DiscussionPassInputV1Schema,
  'discussion.rename': DiscussionRenameInputV1Schema,
  'discussion.archive': DiscussionLifecycleInputV1Schema,
  'discussion.restore': DiscussionLifecycleInputV1Schema,
  'discussion.read_state.set': DiscussionReadStateSetInputV1Schema,
  'discussion.participants.list': DiscussionGetInputV1Schema,
  'discussion.candidates.list': DiscussionCandidatesListInputV1Schema,
  'discussion.invite': DiscussionInviteInputV1Schema,
  'discussion.participant.remove': DiscussionParticipantRemoveInputV1Schema,
  'discussion.participant.policy.set': DiscussionParticipantPolicySetInputV1Schema,
  'discussion.leave': DiscussionLeaveInputV1Schema,
  'discussion.owner.transfer': DiscussionOwnerTransferInputV1Schema,
  'discussion.access.grants.list': DiscussionGetInputV1Schema,
  'discussion.access.grants.set': DiscussionAccessGrantSetInputV1Schema,
  'discussion.access.grants.remove': DiscussionAccessGrantRemoveInputV1Schema,
} as const satisfies Readonly<Record<DiscussionActionIdV1, z.ZodMiniType>>);

export const DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'discussion.list': DiscussionListResultV1Schema,
  'discussion.get': DiscussionDetailsResultV1Schema,
  'discussion.settings.get': DiscussionSettingsResponseV1Schema,
  'discussion.settings.set': DiscussionSettingsResponseV1Schema,
  'discussion.read': DiscussionReadResultV1Schema,
  'discussion.attachment.read': DiscussionAttachmentReadResultV1Schema,
  'discussion.attachment.remove': DiscussionAttachmentRemovedV1Schema,
  'discussion.create': DiscussionCreateResultV1Schema,
  'discussion.second_opinion.start': DiscussionSecondOpinionStartResultV1Schema,
  'discussion.post': DiscussionPostResultV1Schema,
  'discussion.reply': DiscussionPostResultV1Schema,
  'discussion.pass': SessionMessageReplyMutationResultV1Schema,
  'discussion.rename': DiscussionDetailsResultV1Schema,
  'discussion.archive': DiscussionDetailsResultV1Schema,
  'discussion.restore': DiscussionDetailsResultV1Schema,
  'discussion.read_state.set': DiscussionReadStateResultV1Schema,
  'discussion.participants.list': DiscussionParticipantsListResponseV1Schema,
  'discussion.candidates.list': DiscussionCandidatesListResultV1Schema,
  'discussion.invite': DiscussionInviteResultV1Schema,
  'discussion.participant.remove': DiscussionRemoveParticipantResponseV1Schema,
  'discussion.participant.policy.set': DiscussionAccessGrantMutationResponseV1Schema,
  'discussion.leave': DiscussionLeaveResponseV1Schema,
  'discussion.owner.transfer': DiscussionAccessGrantMutationResponseV1Schema,
  'discussion.access.grants.list': DiscussionAccessGrantsListResponseV1Schema,
  'discussion.access.grants.set': DiscussionAccessGrantMutationResponseV1Schema,
  'discussion.access.grants.remove': DiscussionAccessGrantMutationResponseV1Schema,
} as const satisfies Readonly<Record<DiscussionActionIdV1, z.ZodMiniType>>);

export type DiscussionActionInputV1ById = Readonly<{
  [TActionId in DiscussionActionIdV1]:
    z.infer<(typeof DISCUSSION_ACTION_INPUT_SCHEMAS_V1)[TActionId]>;
}>;

export { DISCUSSION_ACTION_IDS_V1 };

