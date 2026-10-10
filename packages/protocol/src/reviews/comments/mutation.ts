import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';
import {
  ReviewCommentAnchorIndexV1Schema,
  ReviewCommentStructuralV1Schema,
  ReviewCommentSensitiveMigrationSourceV1Schema,
  ReviewCommentMutationActionIdV1Schema,
  StoredReviewCommentV1Schema,
  splitReviewCommentV1,
  ReviewCommentSensitiveContentV1Schema,
  type ReviewCommentStructuralV1, type ReviewCommentSensitiveContentV1,
} from './content.js';
import {
  ReviewCommentCreateRequestV1Schema, ReviewCommentTransitionRequestV1Schema,
  ReviewCommentEditRequestV1Schema, ReviewCommentReplyRequestV1Schema,
  ReviewCommentRedactRequestV1Schema, ReviewCommentSetDispositionRequestV1Schema,
  ReviewCommentAttachEvidenceRequestV1Schema,
  ReviewCommentEventV1Schema,
  reviewCommentStateTransitionRequiresEvidenceV1,
  validateReviewCommentScopeV1,
  type ReviewCommentActorRefV1, type ReviewCommentV1, type ReviewCommentStateV1,
} from './v1.js';
import { ReviewCommentBulkTransitionRequestV1Schema, ReviewCommentOperationErrorCodeV1Schema } from './actions.js';

const markers = {
  hasReason: z.boolean().optional(),
  evidenceCount: z.number().int().nonnegative().optional(),
};
const createShape = ReviewCommentCreateRequestV1Schema.shape;
const { anchor: _anchor, snapshot: _snapshot, body: _body, eventEnvelope: _createEvent,
  fingerprint: _fingerprint, linkedRefs: _linkedRefs, suggestedFix: _fix,
  evidence: _createEvidence, metadata: _metadata, ...createStructural } = createShape;
const { reason: _transitionReason, evidence: _transitionEvidence, eventEnvelope: _transitionEvent,
  ...transitionStructural } = ReviewCommentTransitionRequestV1Schema.shape;
const { nextBody: _nextBody, reason: _editReason, eventEnvelope: _editEvent,
  ...editStructural } = ReviewCommentEditRequestV1Schema.shape;
const { body: _replyBody, evidence: _replyEvidence, eventEnvelope: _replyEvent,
  ...replyStructural } = ReviewCommentReplyRequestV1Schema.shape;
const { reason: _redactReason, eventEnvelope: _redactEvent,
  ...redactStructural } = ReviewCommentRedactRequestV1Schema.shape;
const { eventEnvelope: _dispositionEvent, ...dispositionStructural } = ReviewCommentSetDispositionRequestV1Schema.shape;
const { evidence: _attachEvidence, eventEnvelope: _attachEvent,
  ...attachStructural } = ReviewCommentAttachEvidenceRequestV1Schema.shape;
const { reason: _bulkReason, evidence: _bulkEvidence, eventEnvelope: _bulkEvent,
  ...bulkStructural } = ReviewCommentBulkTransitionRequestV1Schema.shape;

export const ReviewCommentStructuralMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.object({ actionId: z.literal('reviews.comments.create'), input: z.object({
    ...createStructural, ...markers, anchorIndex: ReviewCommentAnchorIndexV1Schema.pick({ kind: true }).strict(),
  }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.transition'), input: z.object({ ...transitionStructural, ...markers }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.edit'), input: z.object({ ...editStructural, ...markers }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.reply'), input: z.object({ ...replyStructural, ...markers }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.redact'), input: z.object({ ...redactStructural, ...markers }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.setDisposition'), input: z.object(dispositionStructural).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.attachEvidence'), input: z.object({ ...attachStructural, evidenceCount: z.number().int().positive() }).strict() }).strict(),
  z.object({ actionId: z.literal('reviews.comments.bulkTransition'), input: z.object({ ...bulkStructural, ...markers }).strict() }).strict(),
]).superRefine((value, ctx) => validateReviewCommentScopeV1(value.input, ctx)));
export type ReviewCommentStructuralMutationV1 = z.infer<typeof ReviewCommentStructuralMutationV1Schema>;

export const ReviewCommentStoredSourceV1Schema = lazyZodSchema(() => z.object({
  structural: ReviewCommentStructuralV1Schema,
  source: ReviewCommentSensitiveMigrationSourceV1Schema,
}).strict());
export type ReviewCommentStoredSourceV1 = z.infer<typeof ReviewCommentStoredSourceV1Schema>;

export const ReviewCommentPrepareMutationRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  mutation: ReviewCommentStructuralMutationV1Schema,
  contentCommitment: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createRequestFingerprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict());
export type ReviewCommentPrepareMutationRequestV1 = z.infer<typeof ReviewCommentPrepareMutationRequestV1Schema>;

export const ReviewCommentPreparedRecordV1Schema = lazyZodSchema(() => z.object({
  previous: ReviewCommentStoredSourceV1Schema.optional(),
  structural: ReviewCommentStructuralV1Schema,
  event: ReviewCommentEventV1Schema.optional(),
}).strict());
export type ReviewCommentPreparedRecordV1 = z.infer<typeof ReviewCommentPreparedRecordV1Schema>;

export const ReviewCommentMutationFailureV1Schema = lazyZodSchema(() => z.object({
  commentId: z.string().min(1), errorCode: ReviewCommentOperationErrorCodeV1Schema, error: z.string(),
}).strict());

export const ReviewCommentPrepareMutationResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), receipt: z.string().min(1),
  request: ReviewCommentPrepareMutationRequestV1Schema,
  records: z.array(ReviewCommentPreparedRecordV1Schema),
  replayed: z.boolean(), failed: z.array(ReviewCommentMutationFailureV1Schema),
  bulkActionId: z.string().min(1).optional(),
}).strict());
export type ReviewCommentPrepareMutationResponseV1 = z.infer<typeof ReviewCommentPrepareMutationResponseV1Schema>;

export const ReviewCommentCommitMutationRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), receipt: z.string().min(1),
  records: z.array(z.object({
    commentId: z.string().min(1),
    sensitiveEnvelope: StoredJsonContentEnvelopeSchema,
    eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
  }).strict()),
}).strict());
export type ReviewCommentCommitMutationRequestV1 = z.infer<typeof ReviewCommentCommitMutationRequestV1Schema>;
export const ReviewCommentCommitMutationResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), comments: z.array(z.union([StoredReviewCommentV1Schema, ReviewCommentStoredSourceV1Schema])),
  replayed: z.boolean(), failed: z.array(ReviewCommentMutationFailureV1Schema),
  bulkActionId: z.string().min(1).optional(),
}).strict());
export type ReviewCommentCommitMutationResponseV1 = z.infer<typeof ReviewCommentCommitMutationResponseV1Schema>;

export function projectReviewCommentStructuralMutationV1(actionId: z.input<typeof ReviewCommentMutationActionIdV1Schema>, input: Record<string, unknown>): ReviewCommentStructuralMutationV1 {
  const { anchor, snapshot: _snapshotValue, body: _bodyValue, nextBody: _nextBodyValue,
    reason, evidence, fingerprint, linkedRefs: _refsValue, suggestedFix: _fixValue,
    metadata: _metadataValue, eventEnvelope: _eventValue, ...structural } = input;
  return ReviewCommentStructuralMutationV1Schema.parse({ actionId, input: {
    ...structural,
    ...(reason === undefined ? {} : { hasReason: typeof reason === 'string' && reason.length > 0 }),
    ...(evidence === undefined ? {} : { evidenceCount: Array.isArray(evidence) ? evidence.length : 0 }),
    ...(actionId === 'reviews.comments.create' && anchor && typeof anchor === 'object' ? {
      anchorIndex: ReviewCommentAnchorIndexV1Schema.parse({
        kind: 'kind' in anchor ? anchor.kind : undefined,
      }),
    } : {}),
  } });
}

export type ReviewCommentMutationRuntimeV1 = Readonly<{ now(): number; createId(prefix: string): string }>;

function mutationError(code: z.infer<typeof ReviewCommentOperationErrorCodeV1Schema>, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function plainMutationContent(value: unknown): unknown {
  const envelope = StoredJsonContentEnvelopeSchema.safeParse(value);
  if (!envelope.success) return value;
  if (envelope.data.t !== 'plain') mutationError('review_comment_encryption_mode_mismatch', 'Logical Review Comment content must be opened before mutation');
  return envelope.data.v;
}

export function reviewCommentActorsEqualV1(left: ReviewCommentActorRefV1, right: ReviewCommentActorRefV1): boolean {
  if (left.kind === 'user' && right.kind === 'user') return left.userId === right.userId;
  if (left.kind === 'plugin' && right.kind === 'plugin') return left.pluginId === right.pluginId;
  if (left.kind === 'agent' && right.kind === 'agent') return left.agentId === right.agentId && left.sessionId === right.sessionId;
  if (left.kind === 'workflow' && right.kind === 'workflow') return left.runId === right.runId;
  return false;
}

export function reviewCommentTransitionAllowedV1(from: ReviewCommentStateV1, to: ReviewCommentStateV1): boolean {
  const transitions: Record<ReviewCommentStateV1, readonly ReviewCommentStateV1[]> = {
    proposed: ['open', 'dismissed'], open: ['delegated', 'pending_review', 'resolved', 'dismissed'],
    delegated: ['open', 'pending_review', 'resolved', 'dismissed'],
    pending_review: ['open', 'resolved', 'dismissed'], resolved: ['open'], dismissed: ['open'],
  };
  return transitions[from].includes(to);
}

/** One structural mutation owner; server admission and client sealing consume its result. */
export function deriveReviewCommentStructuralMutationV1(params: Readonly<{
  mutation: ReviewCommentStructuralMutationV1; accountId: string; actor: ReviewCommentActorRefV1;
  current: readonly ReviewCommentStructuralV1[]; runtime: ReviewCommentMutationRuntimeV1;
  workflowOriginSessionId?: string;
}>): Readonly<{ records: ReviewCommentPreparedRecordV1[]; failed: z.infer<typeof ReviewCommentMutationFailureV1Schema>[]; bulkActionId?: string }> {
  const mutation = ReviewCommentStructuralMutationV1Schema.parse(params.mutation);
  const now = params.runtime.now();
  const byId = new Map(params.current.map((value) => [value.id, value]));
  const requireCurrent = (id: string, expected: number) => {
    const value = byId.get(id);
    if (!value) mutationError('review_comment_not_found', 'Review comment not found');
    if (value.accountId !== params.accountId || value.serverRevision !== expected
      || value.projectId !== mutation.input.projectId
      || value.workspace?.machineId !== mutation.input.workspace?.machineId
      || value.workspace?.path !== mutation.input.workspace?.path) {
      mutationError('review_comment_conflict', 'Review comment currentness did not match');
    }
    return value;
  };
  const event = (structural: ReviewCommentStructuralV1, kind: z.infer<typeof ReviewCommentEventV1Schema>['eventKind'], bulkActionId?: string) => ReviewCommentEventV1Schema.parse({
    eventId: params.runtime.createId('review-comment-event'), commentId: structural.id,
    accountId: params.accountId, projectId: structural.projectId, workspace: structural.workspace,
    eventKind: kind, actor: params.actor, createdAt: now, serverRevision: structural.serverRevision,
    bulkActionId, authorDeviceId: mutation.input.authorDeviceId, clientLamport: mutation.input.clientLamport,
    event: { clientMutationId: mutation.input.clientMutationId },
  });
  const transition = (toState: ReviewCommentStateV1, revision: number, fromState?: ReviewCommentStateV1, bulkActionId?: string) => ({
    transitionId: params.runtime.createId('review-comment-transition'), fromState, toState,
    transitionedAt: now, transitionedBy: params.actor, serverRevision: revision,
    clientMutationId: mutation.input.clientMutationId, authorDeviceId: mutation.input.authorDeviceId,
    clientLamport: mutation.input.clientLamport, bulkActionId,
    ...('reviewTriageStatus' in mutation.input ? { reviewTriageStatus: mutation.input.reviewTriageStatus } : {}),
    ...('reviewGroupId' in mutation.input ? { reviewGroupId: mutation.input.reviewGroupId } : {}),
  });
  if (mutation.actionId === 'reviews.comments.create' || mutation.actionId === 'reviews.comments.reply') {
    const id = params.runtime.createId('review-comment');
    const input = mutation.input;
    const parent = mutation.actionId === 'reviews.comments.reply'
      ? requireCurrent(mutation.input.parentCommentId, mutation.input.expectedParentServerRevision) : undefined;
    if (parent && (parent.flags.redacted || parent.state === 'resolved' || parent.state === 'dismissed')) {
      mutationError('review_comment_thread_closed', 'Review comment thread is closed');
    }
    const state = mutation.actionId === 'reviews.comments.create' && mutation.input.authorIntent === 'open' ? 'open' : 'proposed';
    const structural = ReviewCommentStructuralV1Schema.parse({
      v: 1, id, accountId: params.accountId, projectId: input.projectId, workspace: input.workspace,
      ...(mutation.actionId === 'reviews.comments.create' ? {
        workspaceId: mutation.input.workspaceId,
        sessionId: params.actor.kind === 'workflow' ? params.workflowOriginSessionId : mutation.input.sessionId,
        runId: mutation.input.runId, engineId: mutation.input.engineId, findingId: mutation.input.findingId,
        findingIdentity: mutation.input.findingIdentity, findingSeverity: mutation.input.findingSeverity,
        reviewedFingerprint: mutation.input.reviewedFingerprint, anchorIndex: mutation.input.anchorIndex,
      } : { workspaceId: parent?.workspaceId, sessionId: parent?.sessionId, runId: parent?.runId,
        engineId: parent?.engineId, findingId: parent?.findingId, anchorIndex: { kind: parent?.anchorIndex.kind },
        parentCommentId: parent?.id }),
      bodyVersion: 1, editHistory: [], author: params.actor, state, flags: {}, dispositions: {},
      threadId: parent?.threadId ?? id, transitionHistory: [transition(state, 1)],
      createdAt: now, updatedAt: now, serverRevision: 1,
    });
    return { records: [{ structural, event: event(structural, parent ? 'replied' : 'created') }], failed: [] };
  }
  const bulkActionId = mutation.actionId === 'reviews.comments.bulkTransition'
    ? mutation.input.bulkActionId ?? params.runtime.createId('review-comment-bulk') : undefined;
  const ids = mutation.actionId === 'reviews.comments.bulkTransition' ? mutation.input.commentIds : [mutation.input.commentId];
  const records: ReviewCommentPreparedRecordV1[] = [];
  const failed: z.infer<typeof ReviewCommentMutationFailureV1Schema>[] = [];
  for (const id of ids) {
    try {
      const expected = mutation.actionId === 'reviews.comments.bulkTransition'
        ? mutation.input.expectedServerRevisions[id] ?? 0 : mutation.input.expectedServerRevision;
      const current = requireCurrent(id, expected);
      let structural = { ...current, updatedAt: now, serverRevision: current.serverRevision + 1 };
      let kind: z.infer<typeof ReviewCommentEventV1Schema>['eventKind'];
      if (mutation.actionId === 'reviews.comments.transition' || mutation.actionId === 'reviews.comments.bulkTransition') {
        const input = mutation.input;
        if (current.state !== input.expectedState) mutationError('review_comment_conflict', 'Review comment state did not match');
        if (current.state !== input.toState || (!('reviewTriageStatus' in input && input.reviewTriageStatus) && !('reviewGroupId' in input && input.reviewGroupId))) {
          if (!reviewCommentTransitionAllowedV1(current.state, input.toState)) mutationError('review_comment_invalid_transition', 'Review comment transition is invalid');
        }
        if (current.state !== input.toState && reviewCommentStateTransitionRequiresEvidenceV1(input.toState) && !input.hasReason && !input.evidenceCount) {
          mutationError('review_comment_invalid_transition', 'Review comment transition requires evidence or reason');
        }
        const lastDismissal = current.transitionHistory.slice().reverse().find((item) => item.toState === 'dismissed' && item.fromState !== 'dismissed');
        const disputed = current.state === 'dismissed' && input.toState === 'open' && lastDismissal
          && !(lastDismissal.transitionedBy.kind === 'user' && params.actor.kind === 'user')
          && !reviewCommentActorsEqualV1(lastDismissal.transitionedBy, params.actor);
        structural = { ...structural, state: input.toState,
          ...('reviewTriageStatus' in input && input.reviewTriageStatus ? { reviewTriageStatus: input.reviewTriageStatus } : {}),
          flags: { ...current.flags, ...(disputed ? { disputed: true } : {}) },
          transitionHistory: [...current.transitionHistory, transition(input.toState, structural.serverRevision, current.state, bulkActionId)],
        };
        kind = 'transitioned';
      } else if (mutation.actionId === 'reviews.comments.edit') {
        if (current.bodyVersion !== mutation.input.expectedBodyVersion) mutationError('review_comment_conflict', 'Review comment body version did not match');
        structural = { ...structural, bodyVersion: current.bodyVersion + 1,
          editHistory: [...current.editHistory, { editId: params.runtime.createId('review-comment-edit'), editedAt: now, editedBy: params.actor }] };
        kind = 'edited';
      } else if (mutation.actionId === 'reviews.comments.redact') {
        if (current.flags.redacted || current.tombstone) mutationError('review_comment_already_redacted', 'Review comment is already redacted');
        structural = { ...structural, flags: { ...current.flags, redacted: true },
          editHistory: mutation.input.redactBody === false ? current.editHistory : [],
          tombstone: { deletedAt: now, deletedBy: params.actor, redacted: true } };
        kind = 'redacted';
      } else if (mutation.actionId === 'reviews.comments.setDisposition') {
        const actor = params.actor;
        const actorKey = actor.kind === 'user' ? `user:${actor.userId}` : actor.kind === 'agent' ? `agent:${actor.agentId}:${actor.sessionId}` : actor.kind === 'workflow' ? `workflow:${actor.runId}` : `plugin:${actor.pluginId}`;
        structural = { ...structural, dispositions: { ...current.dispositions, [actorKey]: mutation.input.disposition } };
        kind = 'disposition_set';
      } else { kind = 'evidence_attached'; }
      structural = ReviewCommentStructuralV1Schema.parse({ ...structural,
        anchorIndex: { kind: structural.anchorIndex.kind }, fingerprintIndex: undefined });
      records.push({ structural, event: event(structural, kind, bulkActionId) });
    } catch (error) {
      if (mutation.actionId !== 'reviews.comments.bulkTransition') throw error;
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
      const code = ReviewCommentOperationErrorCodeV1Schema.safeParse(error.code);
      if (!code.success) throw error;
      failed.push({ commentId: id, errorCode: code.data, error: error.message });
    }
  }
  return { records, failed, ...(bulkActionId ? { bulkActionId } : {}) };
}

/** Applies only the sensitive portion of an admitted operation, never structural authority. */
export function applyReviewCommentPreparedSensitiveMutationV1(params: Readonly<{
  mutation: ReviewCommentStructuralMutationV1; input: Record<string, unknown>;
  prepared: ReviewCommentPreparedRecordV1; previous?: ReviewCommentV1;
}>): ReviewCommentSensitiveContentV1 {
  const { mutation, prepared, previous } = params;
  const input = params.input;
  const prior = previous ? splitReviewCommentV1(previous).sensitive : undefined;
  let sensitive: Record<string, unknown>;
  if (mutation.actionId === 'reviews.comments.create') {
    const parsed = ReviewCommentCreateRequestV1Schema.parse(input);
    sensitive = { anchor: parsed.anchor, snapshot: plainMutationContent(parsed.snapshot), body: plainMutationContent(parsed.body), edits: [],
      evidence: parsed.evidence, transitions: prepared.structural.transitionHistory.map((item) => ({ ...item, evidence: parsed.evidence })),
      fingerprint: parsed.fingerprint, linkedRefs: parsed.linkedRefs, suggestedFix: parsed.suggestedFix, metadata: parsed.metadata };
  } else {
    if (!prior || !previous) throw new Error('Review Comment mutation requires its opened previous record');
    sensitive = { ...prior };
    if (mutation.actionId === 'reviews.comments.reply') {
      const parsed = ReviewCommentReplyRequestV1Schema.parse(input);
      sensitive = { anchor: prior.anchor, snapshot: prior.snapshot, body: plainMutationContent(parsed.body), edits: [],
        evidence: parsed.evidence, transitions: prepared.structural.transitionHistory.map((item) => ({ ...item, evidence: parsed.evidence })), linkedRefs: prior.linkedRefs };
    } else if (mutation.actionId === 'reviews.comments.edit') {
      const parsed = ReviewCommentEditRequestV1Schema.parse(input);
      sensitive.body = plainMutationContent(parsed.nextBody);
      sensitive.edits = [...prior.edits, { ...prepared.structural.editHistory[prepared.structural.editHistory.length - 1], previousBody: previous.body, nextBody: sensitive.body, reason: parsed.reason }];
    } else if (mutation.actionId === 'reviews.comments.transition' || mutation.actionId === 'reviews.comments.bulkTransition') {
      sensitive.transitions = [...prior.transitions, { ...prepared.structural.transitionHistory[prepared.structural.transitionHistory.length - 1], reason: input.reason, evidence: input.evidence }];
      if (typeof input.reviewGroupId === 'string') sensitive.metadata = { ...prior.metadata, reviewGroupIds: [...new Set([...(prior.metadata?.reviewGroupIds ?? []), input.reviewGroupId])] };
    } else if (mutation.actionId === 'reviews.comments.redact') {
      if (mutation.input.redactBody !== false) { sensitive.body = ''; sensitive.edits = []; }
      sensitive.tombstone = { ...prepared.structural.tombstone, reason: input.reason };
    } else if (mutation.actionId === 'reviews.comments.attachEvidence') {
      const parsed = ReviewCommentAttachEvidenceRequestV1Schema.parse(input);
      sensitive.evidence = [...(prior.evidence ?? []), ...parsed.evidence];
    }
  }
  return ReviewCommentSensitiveContentV1Schema.parse(sensitive);
}
