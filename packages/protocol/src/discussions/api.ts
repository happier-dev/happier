import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { SessionInputSourceSessionV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { SessionDataKeyEnvelopeBytesV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { ContentPublicKeyFingerprintSchema } from '../machines/identity/contentPublicKeyFingerprint.js';
import { ResourceRecipientKeyEnvelopesV1Schema, type ResourceRecipientKeyEnvelopeInputV1 } from '../teams/resourceGrantAccessV1.js';
import { DiscussionInitialParticipantsV1Schema, DiscussionOwnedSessionV1Schema, DiscussionSessionParticipantRefV1Schema, type DiscussionInitialParticipantV1 } from './participants.js';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema, type DiscussionAnchorV1, type DiscussionReplyTargetV1 } from './replyTargets.js';
import { SessionMessageDiscussionReplyReturnV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { WorkflowDiscussionOriginV1Schema } from '../workflows/workflowDestinationsV1.js';
import { DiscussionAttachmentBindingsV1Schema, DiscussionAttachmentSourcesV1Schema } from './attachments.js';
import { readDiscussionAttachmentReferencesV1 } from './content.js';
import { DiscussionErrorCodeV1Schema } from './errors.js';
export { DISCUSSION_ERROR_CODES_V1, DiscussionErrorCodeV1Schema } from './errors.js';
export type { DiscussionErrorCodeV1 } from './errors.js';

import {
  SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
  readServerHttpRequestBodyUtf8ByteLengthV1,
} from '../server/http/requestBodyBoundsV1.js';
import {
  StrictSessionStoredMessageContentEnvelopeSchema,
  type StrictSessionStoredMessageContentEnvelope,
} from '../sessions/messages/sessionStoredMessageContent.js';
import {
  SessionMutationEqualityEvidenceV1Schema,
  type SessionMutationEqualityEvidenceV1,
} from '../sessions/mutations/sessionMutationEqualityV1.js';
import {
  DiscussionAccountIdSchema,
  DiscussionIdSchema,
  DiscussionLocalIdSchema,
  DiscussionMessageContentV1Schema,
  DiscussionWorkflowProducerV1Schema,
  isDiscussionDocEditProposalContentV1,
  type DiscussionMessageContentV1,
} from './content.js';
import {
  DiscussionAttentionFactsV1Schema,
  DiscussionMessageV1Schema,
  DiscussionReadCursorV1Schema,
  DiscussionSummaryV1Schema,
} from './models.js';
import { DiscussionListQueryV1Schema } from './query.js';
export {
  DISCUSSION_DEFAULT_PAGE_SIZE_V1,
  DISCUSSION_MAX_PAGE_SIZE_V1,
  DiscussionListQueryV1Schema,
  DiscussionMessagesQueryV1Schema,
  isDiscussionMessagesSelectionValidV1,
} from './query.js';
export type {
  DiscussionListQueryV1,
  DiscussionMessagesQueryV1,
} from './query.js';

/**
 * The Discussion grant lifecycle establishes private cursor baselines. An
 * explicit acknowledgement never invents a missing baseline or inherits one
 * from the optional source Session's Follow state.
 */
export const DISCUSSION_NOT_TRACKED_CODE_V1 = 'discussion_not_tracked' as const;

export const DiscussionErrorResponseV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.union([
    DiscussionErrorCodeV1Schema,
    z.literal(DISCUSSION_NOT_TRACKED_CODE_V1),
  ]),
}));
export type DiscussionErrorResponseV1 = z.infer<typeof DiscussionErrorResponseV1Schema>;

/**
 * One path owner shared by the Action catalog, explicit server routes, and
 * authenticated client adapters. Methods and handler policy remain with those
 * consumers; this object only prevents path literals from drifting.
 */
export const DISCUSSION_HTTP_PATHS_V1 = Object.freeze({
  collection: '/v1/discussions',
  attention: '/v1/discussions/attention',
  discussion: '/v1/discussions/:discussionId',
  settings: '/v1/discussions/:discussionId/settings',
  archive: '/v1/discussions/:discussionId/archive',
  restore: '/v1/discussions/:discussionId/restore',
  messages: '/v1/discussions/:discussionId/messages',
  upload: '/v1/discussions/upload',
  attachment: '/v1/discussions/:discussionId/messages/:messageId/attachments/:blobId',
  attachmentUpload: '/v1/discussions/attachments/uploads/:uploadId',
  read: '/v1/discussions/:discussionId/read',
  participants: '/v1/discussions/:discussionId/participants',
  invite: '/v1/discussions/:discussionId/participants/invite',
  participant: '/v1/discussions/:discussionId/participants',
  participantPolicy: '/v1/discussions/:discussionId/participants/policy',
  leave: '/v1/discussions/:discussionId/leave',
  ownerTransfer: '/v1/discussions/:discussionId/owner',
  grants: '/v1/discussions/:discussionId/access/grants',
  recipientCensus: '/v1/discussions/:discussionId/data-key/recipients',
  recipientEnvelopes: '/v1/discussions/:discussionId/data-key/envelopes',
} as const);

export const DiscussionListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussions: z.array(DiscussionSummaryV1Schema),
  nextCursor: z.nullable(z.string()),
}));
export type DiscussionListResponseV1 = z.infer<typeof DiscussionListResponseV1Schema>;

/** Owner-native private attention read. It never acknowledges a person's cursor. */
export const DiscussionAttentionQueryV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: z.optional(DiscussionIdSchema),
  /** Inclusive oldest loaded occurrence; cursor remains the exclusive page bound. */
  afterCursor: DiscussionListQueryV1Schema.shape.cursor,
  cursor: DiscussionListQueryV1Schema.shape.cursor,
  limit: DiscussionListQueryV1Schema.shape.limit,
}).check(z.refine(value => value.afterCursor === undefined || value.discussionId !== undefined,
  'A loaded attention frontier requires exact Discussion selection')));
export const DiscussionAttentionTypeV1Schema = lazyZodSchema(() => z.enum(['decision', 'mention', 'update']));
export const DiscussionAttentionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussions: z.array(z.strictObject({
    discussion: DiscussionSummaryV1Schema,
    occurrences: z.array(z.strictObject({ message: DiscussionMessageV1Schema, type: DiscussionAttentionTypeV1Schema })),
  })),
  nextCursor: z.nullable(z.string()),
  incomplete: z.boolean(),
}));
export type DiscussionAttentionQueryV1 = z.infer<typeof DiscussionAttentionQueryV1Schema>;
export type DiscussionAttentionResponseV1 = z.infer<typeof DiscussionAttentionResponseV1Schema>;

export const DiscussionMessagesResponseV1Schema = lazyZodSchema(() => z.strictObject({
  messages: z.array(DiscussionMessageV1Schema),
  hasMoreOlder: z.boolean(),
  messageSeq: z.number().check(z.int(), z.minimum(0)),
}));
export type DiscussionMessagesResponseV1 = z.infer<typeof DiscussionMessagesResponseV1Schema>;

const MentionedAccountIdsSchema = lazyZodSchema(() => z.array(DiscussionAccountIdSchema).check(z.refine((value) => new Set(value).size === value.length, 'Mentioned Account ids must be deduplicated')));
const MentionedSessionIdsSchema = lazyZodSchema(() => z.array(DiscussionSessionParticipantRefV1Schema.shape.sessionId).check(z.refine((value) => new Set(value).size === value.length, 'Mentioned Session ids must be deduplicated')));

/**
 * One sealed message write. Encrypted content must carry a client-derived
 * `e2eeTag`: the Home cannot compute it, so it can compare but never guess
 * plaintext. Plain content must not carry client-asserted equality at all —
 * the server derives that digest from the normalized semantic request.
 */
export const DiscussionMessageWriteV1Schema = lazyZodSchema(() => z.strictObject({
  localId: DiscussionLocalIdSchema,
  requestEqualityEvidenceV1: z.optional(SessionMutationEqualityEvidenceV1Schema),
  content: StrictSessionStoredMessageContentEnvelopeSchema,
  /** Write-only classification derived by the sealing host; never a decision. */
  docEditProposal: z.optional(z.literal(true)),
  mentionedAccountIds: MentionedAccountIdsSchema,
  mentionedSessionIds: z.optional(MentionedSessionIdsSchema),
  replyTarget: z.optional(DiscussionReplyTargetV1Schema),
  attachments: z.optional(DiscussionAttachmentBindingsV1Schema),
}).check(z.superRefine((value, context) => {
  refineEqualityEvidenceForEnvelope(
    value.content.t,
    value.requestEqualityEvidenceV1,
    context,
    ['requestEqualityEvidenceV1'],
  );
  const bindings = value.attachments ?? [];
  if (bindings.some(binding => binding.t !== value.content.t)) context.addIssue({ code: 'custom', path: ['attachments'],
    message: 'Attachment byte envelopes must match the message mode' });
  if (value.content.t === 'plain') {
    const opened = DiscussionMessageContentV1Schema.safeParse(value.content.v);
    if (opened.success) {
      const ids = new Set(readDiscussionAttachmentReferencesV1(opened.data).map(file => file.blobId));
      if (ids.size !== bindings.length || bindings.some(binding => !ids.has(binding.blobId))) {
        context.addIssue({ code: 'custom', path: ['attachments'], message: 'Attachment bindings must match the authored file leaves' });
      }
    }
  }
})));
export type DiscussionMessageWriteV1 = z.infer<typeof DiscussionMessageWriteV1Schema>;

function refineEqualityEvidenceForEnvelope(
  envelopeKind: 'plain' | 'encrypted',
  evidence: { kind: 'plainDigest' } | { kind: 'e2eeTag' } | undefined,
  context: z.core.$RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (envelopeKind === 'encrypted') {
    if (!evidence || evidence.kind !== 'e2eeTag') {
      context.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Encrypted discussion content requires client-derived e2eeTag equality evidence',
      });
    }
    return;
  }
  if (evidence) {
    context.addIssue({
      code: 'custom',
      path: [...path],
      message: 'Plain discussion content must not carry client-asserted equality evidence',
    });
  }
}

export const DiscussionCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  creationLocalId: DiscussionLocalIdSchema,
  creationEqualityEvidenceV1: z.optional(SessionMutationEqualityEvidenceV1Schema),
  titleContent: StrictSessionStoredMessageContentEnvelopeSchema,
  firstMessage: DiscussionMessageWriteV1Schema,
  anchor: z.optional(DiscussionAnchorV1Schema),
  participants: z.optional(DiscussionInitialParticipantsV1Schema),
  dataEncryptionKey: z.optional(SessionDataKeyEnvelopeBytesV1Schema),
  expectedOwnerContentPublicKeyFingerprint: z.optional(ContentPublicKeyFingerprintSchema),
  recipientKeyEnvelopes: z.optional(ResourceRecipientKeyEnvelopesV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.creationLocalId === value.firstMessage.localId) {
    context.addIssue({
      code: 'custom',
      path: ['firstMessage', 'localId'],
      message: 'Discussion creation and first-message retry identities must be distinct',
    });
  }
  refineEqualityEvidenceForEnvelope(
    value.titleContent.t,
    value.creationEqualityEvidenceV1,
    context,
    ['creationEqualityEvidenceV1'],
  );
  if (value.titleContent.t !== value.firstMessage.content.t) {
    context.addIssue({
      code: 'custom',
      path: ['firstMessage', 'content'],
      message: 'A discussion title and its first message must use the same storage mode',
    });
  }
  if (value.titleContent.t === 'plain' && (value.dataEncryptionKey !== undefined
    || value.expectedOwnerContentPublicKeyFingerprint !== undefined || value.recipientKeyEnvelopes !== undefined)) {
    context.addIssue({ code: 'custom', path: ['dataEncryptionKey'], message: 'Plain Discussions do not accept client encryption material' });
  }
  if ((value.dataEncryptionKey === undefined) !== (value.expectedOwnerContentPublicKeyFingerprint === undefined)) {
    context.addIssue({ code: 'custom', path: ['dataEncryptionKey'], message: 'Owner key envelope and current fingerprint must be supplied together' });
  }
})));
export type DiscussionCreateRequestV1 = z.infer<typeof DiscussionCreateRequestV1Schema>;

export const DiscussionPostRequestV1Schema = DiscussionMessageWriteV1Schema;
export type DiscussionPostRequestV1 = z.infer<typeof DiscussionPostRequestV1Schema>;

/**
 * Session-scoped runtime carrier for one Agent-authored Discussion post.
 *
 * The authenticated current-publisher socket supplies Account, Machine and
 * Session authority. The request deliberately contains no producer object:
 * the server derives that projection only after the publisher fence passes.
 */
export const DISCUSSION_AGENT_POST_EVENT_V1 = 'discussion-agent-post-v1' as const;

export const DiscussionAgentPostRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: DiscussionIdSchema,
  discussionId: DiscussionIdSchema,
  request: DiscussionPostRequestV1Schema,
  /** Private host source operands; omitted from the authenticated server publication. */
  attachmentSources: z.optional(DiscussionAttachmentSourcesV1Schema),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  replyReturn: z.optional(SessionMessageDiscussionReplyReturnV1Schema),
  runId: z.optional(DiscussionIdSchema),
  toolCallId: z.optional(DiscussionIdSchema),
}));
export type DiscussionAgentPostRequestV1 = z.infer<typeof DiscussionAgentPostRequestV1Schema>;

/** Atomic create on the same current-Session publisher; never a create/post pair. */
export const DiscussionAgentCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  operation: z.literal('create'),
  sessionId: DiscussionIdSchema,
  request: DiscussionCreateRequestV1Schema,
  attachmentSources: z.optional(DiscussionAttachmentSourcesV1Schema),
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  runId: z.optional(DiscussionIdSchema),
  toolCallId: z.optional(DiscussionIdSchema),
}));
export type DiscussionAgentCreateRequestV1 = z.infer<typeof DiscussionAgentCreateRequestV1Schema>;

export const DiscussionAgentPublisherRequestV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentPostRequestV1Schema,
  DiscussionAgentCreateRequestV1Schema,
]));
export type DiscussionAgentPublisherRequestV1 = z.infer<typeof DiscussionAgentPublisherRequestV1Schema>;
export type DiscussionAgentPublisherInputV1 =
  | Omit<DiscussionAgentPostRequestV1, 'v' | 'sessionId'>
  | Omit<DiscussionAgentCreateRequestV1, 'v' | 'sessionId'>;

/** Host assertion minted only after the private V2 replay owner validates the review. */
export const DiscussionDraftReviewV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: DiscussionIdSchema,
  decidingAccountId: DiscussionIdSchema,
}));
export type DiscussionDraftReviewV1 = z.infer<typeof DiscussionDraftReviewV1Schema>;
/** Trusted host transport only; authoring requests cannot carry review authority. */
export const DiscussionAgentPostPublicationV1Schema = lazyZodSchema(() => z.extend(z.omit(DiscussionAgentPostRequestV1Schema, { attachmentSources: true }), {
  draftReview: z.optional(DiscussionDraftReviewV1Schema),
  /** Verified host final/result return, never an authored explicit reply. */
  terminalReturn: z.optional(z.literal(true)),
}));
export type DiscussionAgentPostPublicationV1 = z.infer<typeof DiscussionAgentPostPublicationV1Schema>;
/** The installed owning Machine replays a privately reviewed post without impersonating a live Session publisher. */
const DiscussionAgentReviewedReplayPublicationV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  operation: z.literal('approved_replay'),
  machineId: z.string().check(z.minLength(1)),
  publication: z.extend(DiscussionAgentPostPublicationV1Schema, { draftReview: DiscussionDraftReviewV1Schema }).check(z.refine(
    publication => publication.sourceSession !== undefined || publication.replyReturn !== undefined,
    { message: 'Reviewed replay requires its durable Session source or protected original return' },
  )),
}));
/** The existing installed Machine publication channel also carries accepted Workflow leaves. */
export const DiscussionWorkflowPostPublicationV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema, request: DiscussionPostRequestV1Schema,
  producer: DiscussionWorkflowProducerV1Schema,
  origin: WorkflowDiscussionOriginV1Schema,
  /** Exact existing interrupted-Run observation custody, not a new worker claim. */
  expectedParentRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type DiscussionWorkflowPostPublicationV1 = z.infer<typeof DiscussionWorkflowPostPublicationV1Schema>;
export const DiscussionAgentApprovedReplayPublicationV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentReviewedReplayPublicationV1Schema,
  z.strictObject({ v: z.literal(1), operation: z.literal('workflow_result'), machineId: DiscussionIdSchema,
    publication: DiscussionWorkflowPostPublicationV1Schema }),
]));
export type DiscussionAgentApprovedReplayPublicationV1 = z.infer<typeof DiscussionAgentApprovedReplayPublicationV1Schema>;
export const DiscussionMachinePublicationV2Schema = lazyZodSchema(() => z.union([
  DiscussionAgentApprovedReplayPublicationV1Schema,
  // An accepted Workflow original is durable authority after its Session
  // publisher exits. The installed Machine uses the same original-return
  // append checks; an ordinary unreviewed Session post cannot enter this arm.
  z.strictObject({ v: z.literal(2), operation: z.literal('terminal_return'), machineId: DiscussionIdSchema,
    publication: z.extend(DiscussionAgentPostPublicationV1Schema, {
      terminalReturn: z.literal(true),
      replyReturn: SessionMessageDiscussionReplyReturnV1Schema.check(z.refine(marker => marker.workflow !== undefined,
        'Machine terminal return requires an accepted Workflow original')),
    }) }),
]));
export const DiscussionAgentPublisherPublicationV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentPostPublicationV1Schema, z.omit(DiscussionAgentCreateRequestV1Schema, { attachmentSources: true }),
]));
export type DiscussionAgentPublisherPublicationV1 = z.infer<typeof DiscussionAgentPublisherPublicationV1Schema>;
export type DiscussionAgentPublisherPublicationInputV1 =
  | Omit<z.infer<typeof DiscussionAgentPostPublicationV1Schema>, 'v' | 'sessionId'>
  | Omit<DiscussionAgentCreateRequestV1, 'v' | 'sessionId' | 'attachmentSources'>;

export const DiscussionRenameRequestV1Schema = lazyZodSchema(() => z.strictObject({
  titleContent: StrictSessionStoredMessageContentEnvelopeSchema,
}));
export type DiscussionRenameRequestV1 = z.infer<typeof DiscussionRenameRequestV1Schema>;

type DiscussionE2eeEqualityEvidenceV1 = Extract<
  SessionMutationEqualityEvidenceV1,
  Readonly<{ kind: 'e2eeTag' }>
>;

export type DiscussionCreateMutationRequestBodyInputV1 = Readonly<{
  kind: 'create';
  creationLocalId: string;
  creationEqualityEvidenceV1?: DiscussionE2eeEqualityEvidenceV1;
  titleContent: StrictSessionStoredMessageContentEnvelope;
  anchor?: DiscussionAnchorV1;
  participants?: readonly DiscussionInitialParticipantV1[];
  dataEncryptionKey?: string;
  expectedOwnerContentPublicKeyFingerprint?: string;
  recipientKeyEnvelopes?: readonly ResourceRecipientKeyEnvelopeInputV1[];
  firstMessage: Readonly<{
    localId: string;
    requestEqualityEvidenceV1?: DiscussionE2eeEqualityEvidenceV1;
    content: StrictSessionStoredMessageContentEnvelope;
    authoredContent: DiscussionMessageContentV1;
    mentionedAccountIds: readonly string[];
    mentionedSessionIds?: readonly string[];
    replyTarget?: DiscussionReplyTargetV1;
  }>;
}>;
export type DiscussionPostMutationRequestBodyInputV1 = Readonly<{
  kind: 'post';
  localId: string;
  requestEqualityEvidenceV1?: DiscussionE2eeEqualityEvidenceV1;
  content: StrictSessionStoredMessageContentEnvelope;
  authoredContent: DiscussionMessageContentV1;
  mentionedAccountIds: readonly string[];
  mentionedSessionIds?: readonly string[];
  replyTarget?: DiscussionReplyTargetV1;
}>;
export type DiscussionRenameMutationRequestBodyInputV1 = Readonly<{
  kind: 'rename';
  titleContent: StrictSessionStoredMessageContentEnvelope;
}>;
export type DiscussionMutationRequestBodyInputV1 =
  | DiscussionCreateMutationRequestBodyInputV1
  | DiscussionPostMutationRequestBodyInputV1
  | DiscussionRenameMutationRequestBodyInputV1;

/**
 * Builds the final post-sealing body accepted by the Discussion storage route.
 *
 * Stateful callers own identity generation and retry custody; crypto owners
 * seal content and derive optional E2EE equality evidence. This pure boundary
 * owns only the exact HTTP field placement and strict route-schema validation,
 * so UI, CLI and plugin/SDK hosts cannot drift into similar-but-different wire
 * bodies.
 */
export function buildDiscussionMutationRequestBodyV1(
  input: DiscussionCreateMutationRequestBodyInputV1,
): DiscussionCreateRequestV1;
export function buildDiscussionMutationRequestBodyV1(
  input: DiscussionPostMutationRequestBodyInputV1,
): DiscussionPostRequestV1;
export function buildDiscussionMutationRequestBodyV1(
  input: DiscussionRenameMutationRequestBodyInputV1,
): DiscussionRenameRequestV1;
export function buildDiscussionMutationRequestBodyV1(
  input: DiscussionMutationRequestBodyInputV1,
): DiscussionCreateRequestV1 | DiscussionPostRequestV1 | DiscussionRenameRequestV1 {
  if (input.kind === 'create') {
    const authoredContent = DiscussionMessageContentV1Schema.parse(input.firstMessage.authoredContent);
    return DiscussionCreateRequestV1Schema.parse({
      creationLocalId: input.creationLocalId,
      ...(input.creationEqualityEvidenceV1
        ? { creationEqualityEvidenceV1: input.creationEqualityEvidenceV1 }
        : {}),
      titleContent: input.titleContent,
      ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
      ...(input.participants === undefined ? {} : { participants: [...input.participants] }),
      ...(input.dataEncryptionKey === undefined ? {} : { dataEncryptionKey: input.dataEncryptionKey }),
      ...(input.expectedOwnerContentPublicKeyFingerprint === undefined ? {} : { expectedOwnerContentPublicKeyFingerprint: input.expectedOwnerContentPublicKeyFingerprint }),
      ...(input.recipientKeyEnvelopes === undefined ? {} : { recipientKeyEnvelopes: [...input.recipientKeyEnvelopes] }),
      firstMessage: {
        localId: input.firstMessage.localId,
        ...(input.firstMessage.requestEqualityEvidenceV1
          ? { requestEqualityEvidenceV1: input.firstMessage.requestEqualityEvidenceV1 }
          : {}),
        content: input.firstMessage.content,
        ...buildDiscussionAttachmentBindingsV1(authoredContent, input.firstMessage.content.t),
        ...(isDiscussionDocEditProposalContentV1(authoredContent) ? { docEditProposal: true } : {}),
        mentionedAccountIds: [...input.firstMessage.mentionedAccountIds],
        ...(input.firstMessage.mentionedSessionIds === undefined ? {} : { mentionedSessionIds: [...input.firstMessage.mentionedSessionIds] }),
        ...(input.firstMessage.replyTarget === undefined ? {} : { replyTarget: input.firstMessage.replyTarget }),
      },
    });
  }
  if (input.kind === 'post') {
    const authoredContent = DiscussionMessageContentV1Schema.parse(input.authoredContent);
    return DiscussionPostRequestV1Schema.parse({
      localId: input.localId,
      ...(input.requestEqualityEvidenceV1
        ? { requestEqualityEvidenceV1: input.requestEqualityEvidenceV1 }
        : {}),
      content: input.content,
      ...buildDiscussionAttachmentBindingsV1(authoredContent, input.content.t),
      ...(isDiscussionDocEditProposalContentV1(authoredContent) ? { docEditProposal: true } : {}),
      mentionedAccountIds: [...input.mentionedAccountIds],
      ...(input.mentionedSessionIds === undefined ? {} : { mentionedSessionIds: [...input.mentionedSessionIds] }),
      ...(input.replyTarget === undefined ? {} : { replyTarget: input.replyTarget }),
    });
  }
  return DiscussionRenameRequestV1Schema.parse({
    titleContent: input.titleContent,
  });
}

/** One derived projection for UI, CLI, storage bodies and equality preparation. */
export function buildDiscussionAttachmentBindingsV1(content: DiscussionMessageContentV1, t: 'plain' | 'encrypted'): {
  attachments?: { blobId: string; t: 'plain' | 'encrypted' }[];
} {
  const references = readDiscussionAttachmentReferencesV1(content);
  return references.length === 0 ? {} : { attachments: references.map(file => ({ blobId: file.blobId, t })) };
}

export const DiscussionReadRequestV1Schema = lazyZodSchema(() => z.strictObject({
  lastReadSeq: z.number().check(z.int(), z.minimum(0)),
}));
export type DiscussionReadRequestV1 = z.infer<typeof DiscussionReadRequestV1Schema>;

export const DiscussionDetailsResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussion: DiscussionSummaryV1Schema,
  /** Archive returns exact ordinary Session lifecycle operands, including retries. */
  ownedSessions: z.optional(z.array(DiscussionOwnedSessionV1Schema)),
}));
export type DiscussionDetailsResponseV1 = z.infer<typeof DiscussionDetailsResponseV1Schema>;

export const DiscussionCreateResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussion: DiscussionSummaryV1Schema,
  firstMessage: DiscussionMessageV1Schema,
}));
export type DiscussionCreateResponseV1 = z.infer<typeof DiscussionCreateResponseV1Schema>;

export const DiscussionPostResponseV1Schema = lazyZodSchema(() => z.strictObject({
  message: DiscussionMessageV1Schema,
  messageSeq: z.number().check(z.int(), z.minimum(1)),
}));
export type DiscussionPostResponseV1 = z.infer<typeof DiscussionPostResponseV1Schema>;

export const DiscussionAgentPostResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    value: DiscussionPostResponseV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: DiscussionErrorCodeV1Schema,
  }),
]));
export type DiscussionAgentPostResponseV1 = z.infer<typeof DiscussionAgentPostResponseV1Schema>;

/** The installed Machine must surface indeterminate storage/commit results to its Action owner. */
export const DiscussionAgentApprovedReplayResponseV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentPostResponseV1Schema,
  z.strictObject({ v: z.literal(1), ok: z.literal(false), error: z.literal('outcome_unknown') }),
]));
export type DiscussionAgentApprovedReplayResponseV1 = z.infer<typeof DiscussionAgentApprovedReplayResponseV1Schema>;

export const DiscussionAgentCreateResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), v: z.literal(1), value: DiscussionCreateResponseV1Schema }),
  z.strictObject({ ok: z.literal(false), v: z.literal(1), error: DiscussionErrorCodeV1Schema }),
]));
export type DiscussionAgentCreateResponseV1 = z.infer<typeof DiscussionAgentCreateResponseV1Schema>;
export const DiscussionAgentPublisherResponseV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentPostResponseV1Schema,
  DiscussionAgentCreateResponseV1Schema,
]));
export type DiscussionAgentPublisherResponseV1 = z.infer<typeof DiscussionAgentPublisherResponseV1Schema>;

export const DiscussionReadResponseV1Schema = lazyZodSchema(() => DiscussionReadCursorV1Schema);
export type DiscussionReadResponseV1 = z.infer<typeof DiscussionReadResponseV1Schema>;

export { DiscussionAttentionFactsV1Schema };

/**
 * The complete create/post request has to fit the transport that actually
 * serves it. This validates the whole encoded body against the canonical
 * server request-body owner instead of independent title/text/part/mention
 * maxima that cannot fit together.
 */
export function readDiscussionRequestUtf8ByteLengthV1(body: unknown): number {
  return readServerHttpRequestBodyUtf8ByteLengthV1(body);
}

export function isDiscussionRequestWithinTransportBudgetV1(body: unknown): boolean {
  const bytes = readServerHttpRequestBodyUtf8ByteLengthV1(body);
  return Number.isFinite(bytes) && bytes <= DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1;
}

/**
 * Discussions do not narrow the API server's request-body ceiling. Their
 * accepted content range is exactly what the serving transport admits.
 */
export const DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1 = SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1;

export const DiscussionRouteParamsV1Schema = lazyZodSchema(() => z.strictObject({}));

export const DiscussionRouteDiscussionParamsV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema,
}));

