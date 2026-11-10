import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PromptDocArtifactRefV1Schema } from '../prompts/library/promptArtifactRefsV1.js';
import { ArtifactDocumentV1Schema, type ArtifactActionIdV1 } from './artifactActionsV1.js';
import { ArtifactRevisionV1Schema } from './artifactRevisionV1.js';
import { DocEditProposalV1Schema, DocPassageRefV1Schema, type DocPassageRefV1 } from './artifactCollaborationV1.js';
import { DiscussionAddressV1Schema, DiscussionLocalIdSchema, DiscussionMessageRefV1Schema } from '../discussions/references.js';
import { DiscussionTextMessageContentV1Schema, DiscussionDocPassageCommentContentV1Schema,
  DiscussionDocEditProposalContentV1Schema } from '../discussions/content.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionPostResultV1Schema,
  type DiscussionCreateInputV1, type DiscussionPostInputV1 } from '../discussions/actions.js';
import { DocEditProposalDispositionV1Schema } from '../discussions/models.js';
import type { DiscussionOpenedMessageV1 } from '../discussions/actions.js';
import { prepareDocEditBodyV1 } from './artifactPassageV1.js';
import { artifactSupportsProseCollaborationV1 } from './artifactSharingV1.js';
import { areServerProfileIdentifiersEquivalent } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { DiscussionInitialParticipantsV1Schema } from '../discussions/participants.js';

export const DocReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  ref: PromptDocArtifactRefV1Schema,
  revision: z.optional(ArtifactRevisionV1Schema),
}));
export const DocReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  ref: z.extend(PromptDocArtifactRefV1Schema, { serverId: z.string().check(z.minLength(1)) }),
  artifact: ArtifactDocumentV1Schema,
  /** null means the authorized Discussion summary is unavailable, never zero comments. */
  openCommentCount: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));

export const DocCommentReplyInputV1Schema = lazyZodSchema(() => z.strictObject({
  discussionRef: z.optional(DiscussionAddressV1Schema),
  target: DocPassageRefV1Schema,
  parentMessageRef: z.optional(DiscussionMessageRefV1Schema),
  localId: DiscussionLocalIdSchema,
  content: DiscussionTextMessageContentV1Schema,
  participants: z.optional(DiscussionInitialParticipantsV1Schema),
}).check(z.refine(value => value.target.ref.serverId === undefined
  || ((value.discussionRef === undefined || value.target.ref.serverId === value.discussionRef.serverId)
    && (value.parentMessageRef === undefined || value.target.ref.serverId === value.parentMessageRef.discussion.serverId)),
  'Passage and Discussion must belong to the same Home'),
z.refine(value => value.discussionRef === undefined || value.parentMessageRef === undefined
  || (value.discussionRef.serverId === value.parentMessageRef.discussion.serverId
    && value.discussionRef.discussionId === value.parentMessageRef.discussion.discussionId),
  'Parent message must belong to the selected Discussion'),
z.refine(value => !value.participants?.length || (value.discussionRef === undefined && value.parentMessageRef === undefined),
  'Initial invitations require a new Discussion')));
export type DocCommentReplyInputV1 = z.infer<typeof DocCommentReplyInputV1Schema>;

/** The existing C3 creation identity, shared with its draft/reconciliation consumer. */
export function deriveDocCommentDiscussionCreationLocalIdV1(input: Readonly<{
  ref: DocPassageRefV1['ref'] & Readonly<{ serverId: string }>;
  localId: string;
}>): string {
  return computeCanonicalDomainSeparatedDigest('doc.comment.discussion.v1', [input.ref.serverId, input.ref.artifactId, input.localId]);
}

/** Fully bound proposal retained by approval and publication replay. */
export const DocEditProposeResolvedInputV1Schema = lazyZodSchema(() => z.safeExtend(DocEditProposalV1Schema, {
  discussionRef: DiscussionAddressV1Schema,
  replyTo: z.optional(DiscussionMessageRefV1Schema),
  localId: DiscussionLocalIdSchema,
}).check(z.refine(value => value.target.ref.serverId === undefined
  || value.target.ref.serverId === value.discussionRef.serverId,
  'Passage and Discussion must belong to the same Home'),
z.refine(value => value.replyTo === undefined
  || (value.replyTo.discussion.serverId === value.discussionRef.serverId
    && value.replyTo.discussion.discussionId === value.discussionRef.discussionId),
  'Reply must belong to the selected Discussion')));
export type DocEditProposeResolvedInputV1 = z.infer<typeof DocEditProposeResolvedInputV1Schema>;

/** A thread already owns the passage, quote and full revision; callers author only the change. */
export const DocEditProposeInputV1Schema = lazyZodSchema(() => z.union([
  DocEditProposeResolvedInputV1Schema,
  z.strictObject({
    discussionRef: DiscussionAddressV1Schema,
    localId: DiscussionLocalIdSchema,
    after: z.string(),
    reason: z.optional(z.string()),
  }),
]));
export type DocEditProposeInputV1 = z.infer<typeof DocEditProposeInputV1Schema>;

export const DocEditAcceptInputV1Schema = lazyZodSchema(() => z.strictObject({
  proposalRef: DiscussionMessageRefV1Schema,
  expectedRevision: ArtifactRevisionV1Schema,
}));
export type DocEditAcceptInputV1 = z.infer<typeof DocEditAcceptInputV1Schema>;

export const DocEditDeclineInputV1Schema = lazyZodSchema(() => z.strictObject({
  proposalRef: DiscussionMessageRefV1Schema,
}));
export type DocEditDeclineInputV1 = z.infer<typeof DocEditDeclineInputV1Schema>;

const DocEditPreparationV1Schema = lazyZodSchema(() => z.strictObject({
  doc: z.strictObject({
    ref: z.extend(PromptDocArtifactRefV1Schema, { serverId: z.string().check(z.minLength(1)) }),
    revision: ArtifactRevisionV1Schema,
  }),
  body: z.string(),
}));

/** Internal keyholding-host intent. The host seals preparation.body with the existing Artifact codec. */
export const DocEditAcceptHostInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DocEditAcceptInputV1Schema.shape,
  preparation: z.optional(DocEditPreparationV1Schema),
}).check(z.refine(value => value.preparation === undefined
  || (value.preparation.doc.ref.serverId === value.proposalRef.discussion.serverId
    && value.preparation.doc.revision.headerVersion === value.expectedRevision.headerVersion
    && value.preparation.doc.revision.bodyVersion === value.expectedRevision.bodyVersion),
  'Preparation must use the same Home and complete reviewed revision')));
export type DocEditAcceptHostInputV1 = z.infer<typeof DocEditAcceptHostInputV1Schema>;
/** Same packet shape at HTTP; preparation.body is encoded Artifact content, never opened E2EE text. */
export const DocEditAcceptTransportInputV1Schema = DocEditAcceptHostInputV1Schema;
export type DocEditAcceptTransportInputV1 = z.infer<typeof DocEditAcceptTransportInputV1Schema>;
export const DocEditDeclineTransportInputV1Schema = DocEditDeclineInputV1Schema;
export const DOC_EDIT_PROPOSAL_HTTP_PATHS_V1 = {
  accept: '/v1/artifacts/doc-edit-proposals/accept',
  decline: '/v1/artifacts/doc-edit-proposals/decline',
} as const;

/** The incumbent Artifact host dispatch, with internal prepared decision intents rather than new public inputs. */
export type ArtifactHostActionInvocationV1 = Readonly<{ actionId: ArtifactActionIdV1; input: unknown; readOnly?: true }>
  | Readonly<{ actionId: 'doc.edit.accept'; input: DocEditAcceptHostInputV1 }>
  | Readonly<{ actionId: 'doc.edit.decline'; input: DocEditDeclineInputV1 }>;

/** One preparation owner for every keyholding host; proposal text is read only from the exact committed C3 message. */
export function prepareDocEditAcceptanceV1(input: Readonly<{
  proposalRef: z.infer<typeof DiscussionMessageRefV1Schema>;
  expectedRevision: z.infer<typeof ArtifactRevisionV1Schema>;
  message: DiscussionOpenedMessageV1;
  artifact?: z.infer<typeof ArtifactDocumentV1Schema>;
}>, sameHome: (left: string | null | undefined, right: string | null | undefined) => boolean = areServerProfileIdentifiersEquivalent): DocEditAcceptHostInputV1 {
  const { message, proposalRef, expectedRevision } = input;
  function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
  if (message.id !== proposalRef.messageId || message.discussionId !== proposalRef.discussion.discussionId
    || !sameHome(message.messageRef.discussion.serverId, proposalRef.discussion.serverId)) refuse('doc_edit_proposal_invalid');
  if (!message.docEditProposalDispositionV1) refuse('doc_edit_proposal_disposition_unavailable');
  if (message.docEditProposalDispositionV1.state !== 'open') return { proposalRef, expectedRevision };
  if (!message.content || !('kind' in message.content) || message.content.kind !== 'doc_edit_proposal') refuse('doc_edit_proposal_invalid');
  const proposal = message.content.proposal;
  if (!sameHome(proposal.target.ref.serverId, proposalRef.discussion.serverId)) refuse('server_target_mismatch');
  if (proposal.baseRevision.headerVersion !== expectedRevision.headerVersion
    || proposal.baseRevision.bodyVersion !== expectedRevision.bodyVersion) refuse('version_mismatch');
  const artifact = input.artifact;
  if (!artifact || typeof artifact.body !== 'string' || !artifactSupportsProseCollaborationV1(artifact)) refuse('doc_kind_not_prose');
  const ref = { kind: 'doc' as const, artifactId: artifact.artifactId, serverId: proposalRef.discussion.serverId };
  const body = prepareDocEditBodyV1({ proposal, ref: { ...ref, serverId: proposal.target.ref.serverId },
    revision: artifact.revision, source: artifact.body });
  return DocEditAcceptHostInputV1Schema.parse({ proposalRef, expectedRevision,
    preparation: { doc: { ref, revision: proposal.baseRevision }, body } });
}

/** Both decisions return the actual settled message state, including opposite-decision retries. */
export const DocEditDecisionResultV1Schema = lazyZodSchema(() => z.strictObject({
  proposalRef: DiscussionMessageRefV1Schema,
  docEditProposalDispositionV1: DocEditProposalDispositionV1Schema,
}).check(z.refine(value => value.docEditProposalDispositionV1.state !== 'open',
  'A successful decision must return a settled proposal')));
export type DocEditDecisionResultV1 = z.infer<typeof DocEditDecisionResultV1Schema>;

export const DocCollaborationActionInputSchemasV1 = {
  'doc.read': DocReadInputV1Schema,
  'doc.comment.reply': DocCommentReplyInputV1Schema,
  'doc.edit.propose': DocEditProposeInputV1Schema,
  'doc.edit.accept': DocEditAcceptInputV1Schema,
  'doc.edit.decline': DocEditDeclineInputV1Schema,
} as const;
export const DocCollaborationActionOutputSchemasV1 = {
  'doc.read': DocReadResultV1Schema,
  'doc.comment.reply': DiscussionPostResultV1Schema,
  'doc.edit.propose': DiscussionPostResultV1Schema,
  'doc.edit.accept': DocEditDecisionResultV1Schema,
  'doc.edit.decline': DocEditDecisionResultV1Schema,
} as const;

/** One exact semantic child intent shared by execution and host custody/replay checks. */
export type PreparedDocDiscussionMutationV1 = Readonly<{ actionId: 'discussion.create'; input: DiscussionCreateInputV1 }>
  | Readonly<{ actionId: 'discussion.post' | 'discussion.reply'; input: DiscussionPostInputV1 }>;
export function prepareDocDiscussionMutationV1(actionId: 'doc.comment.reply' | 'doc.edit.propose', input: unknown,
  serverId: string): PreparedDocDiscussionMutationV1 {
  const request = actionId === 'doc.comment.reply' ? DocCommentReplyInputV1Schema.parse(input) : DocEditProposeResolvedInputV1Schema.parse(input);
  const isComment = 'content' in request;
  const parent = isComment ? request.parentMessageRef : request.replyTo;
  const discussion = request.discussionRef ?? parent?.discussion;
  const target = DocPassageRefV1Schema.parse({ ...request.target,
    ref: { ...request.target.ref, serverId: request.target.ref.serverId ?? serverId } });
  const content = isComment
    ? parent ? request.content : DiscussionDocPassageCommentContentV1Schema.parse({ kind: 'doc_passage_comment', passage: target, content: request.content })
    : DiscussionDocEditProposalContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
      target, baseRevision: request.baseRevision, before: request.before, after: request.after, reason: request.reason,
    } });
  const replyTarget = parent ? { kind: 'message' as const, messageId: parent.messageId }
    : { kind: 'doc_passage' as const, doc: { ref: { ...target.ref, serverId: target.ref.serverId ?? serverId }, revision: target.revision } };
  if (!discussion) {
    return { actionId: 'discussion.create' as const, input: DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.create'].parse({
      creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: { ...target.ref, serverId: target.ref.serverId ?? serverId }, localId: request.localId }),
      anchor: { kind: 'doc', doc: { ref: target.ref, revision: target.revision } },
      title: 'Document comments', firstMessage: { localId: request.localId, content, replyTarget },
      ...(isComment && request.participants !== undefined ? { participants: request.participants } : {}),
    }) };
  }
  const childId = parent ? 'discussion.reply' as const : 'discussion.post' as const;
  return { actionId: childId, input: DISCUSSION_ACTION_INPUT_SCHEMAS_V1[childId].parse({ discussionId: discussion.discussionId,
    localId: request.localId, content, replyTarget }) };
}
