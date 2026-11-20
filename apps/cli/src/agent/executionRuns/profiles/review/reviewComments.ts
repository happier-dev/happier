import { createHash, randomUUID } from 'node:crypto';

import { ReviewRoundBindingV1Schema, type ReviewRoundBindingV1, type ReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { prepareReviewRoundV1 } from '@happier-dev/protocol/reviews/prepareReviewRoundV1';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSourceSchema, type ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { ReviewPublicationEvidenceSchema } from '@happier-dev/protocol/reviews/reviewPublicationEvidence';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { createReviewFindingIdentityV1, createReviewFindingMessageHashV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ReviewTriageOverlaySchema } from '@happier-dev/protocol/messages/structured/reviewFindingsV1';
import { ReviewFindingContentSchema } from '@happier-dev/protocol/reviews/ReviewFinding';
import { stringifyReviewCommentPrincipalCanonicalJsonV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentAnchorV1, ReviewCommentCreateRequestV1, ReviewCommentFingerprintV1, ReviewCommentScopeV1, ReviewCommentV1, ReviewCommentPrincipalHeaderV1, ReviewFinding, ReviewTriageOverlay, ReviewTriageStatus } from '@happier-dev/protocol';

import type { ReviewCommentActionExecutor } from '@/agent/reviews/comments/executor';
import { resolveReviewCommentSnapshot } from '@/agent/reviews/comments/snapshots';
import type { ExecutionRunActionResult, ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmExecutionRunAccountScope } from '@/agent/runtime/bridges/executionRun/profileStart';

export type ReviewRunMaterialization = Readonly<{
  engineId: string;
  status: 'materialized' | 'partial' | 'failed';
  commentIds: readonly string[];
  comments: readonly Readonly<{ findingId: string; comment: Pick<ReviewCommentV1, 'id' | 'state' | 'serverRevision' | 'reviewId' | 'projectId' | 'workspace' | 'sessionId' | 'runId'> }>[];
  failures: readonly Readonly<{ findingId: string; errorCode: string }>[];
}>;

export type ReviewRunCommentService = ReturnType<typeof createReviewRunCommentService>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function errorCode(error: unknown): string {
  const code = record(error)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'review_comment_request_failed';
}

function resultComment(value: unknown): ReviewCommentV1 {
  return ReviewCommentV1Schema.parse(record(value)?.comment);
}

function findingAnchor(finding: ReviewFinding, runId: string): ReviewCommentAnchorV1 {
  if (!finding.filePath) return { kind: 'finding', runId, findingId: finding.id };
  if (!finding.startLine) return { kind: 'file', filePath: finding.filePath };
  return finding.endLine && finding.endLine !== finding.startLine
    ? { kind: 'range', filePath: finding.filePath, startLine: finding.startLine, endLine: finding.endLine }
    : { kind: 'line', filePath: finding.filePath, line: finding.startLine };
}

function storedTriageStatus(comment: ReviewCommentV1): ReviewTriageStatus | null {
  if (comment.reviewTriageStatus) return comment.reviewTriageStatus;
  return null;
}

export function projectReviewRunTriage(comments: readonly ReviewCommentV1[]): ReviewTriageOverlay {
  return { findings: comments.flatMap((comment) => {
    const status = storedTriageStatus(comment);
    if (!comment.findingId || !status) return [];
    const latest = comment.transitions.at(-1);
    return [{ id: comment.findingId, status, ...(latest?.reason ? { comment: latest.reason } : {}) }];
  }) };
}

/** Uses only the incumbent signed/encrypted ReviewComment transport and CAS owner. */
export function createReviewRunCommentService(deps: Readonly<{
  cwd: string;
  scope: ReviewCommentScopeV1;
  execute: ReviewCommentActionExecutor;
  reviewRecords?: Pick<ReviewRecordPortV1, 'start' | 'settle'>;
  /** Host-bound live Session Agent; absence never falls back to Account user authority. */
  resolveTriageActor?: () => Extract<ReviewCommentPrincipalHeaderV1['actor'], { kind: 'agent' }> | null;
}>) {
  return {
    async prepareNewRound(run: ExecutionRunState) {
      if (!deps.reviewRecords) throw Object.assign(new Error('Review records are unavailable'), { code: 'review_record_unavailable' });
      const reviewRecords = deps.reviewRecords;
      const reviewInput = ReviewStartInputSchema.parse(run.intentInput);
      const reviewRound = ReviewRoundBindingV1Schema.parse(reviewInput.reviewRound);
      const cwd = run.launch?.cwd ?? deps.cwd;
      const prepare = async () => {
        const captured = reviewInput.comparisonId ? await readCapturedScmComparison({ cwd,
          comparisonId: reviewInput.comparisonId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) }) : null;
        const source = ScmComparisonSourceSchema.safeParse(reviewInput.source ?? captured?.comparison.source);
        const prepared = await prepareReviewRoundV1({ reviewInput, reviewRound,
          ...(captured ? { comparison: captured.comparison } : {}),
          ...(source.success ? { comparisonCapture: { cwd, source: source.data,
            ...(run.sessionId ? { sessionId: run.sessionId } : {}) } } : {}),
          previousRoundContext: {},
        }, { reviewRecords, cwd, sourceKind: 'direct', startedAt: Date.now(),
          ...(deps.scope.workspace ? { comparisonTarget: { kind: 'machine', machineId: deps.scope.workspace.machineId } } : {}),
          captureComparison: async input => (await captureScmComparison({ ...input,
            source: input.source!, // Round preparation always supplies the original selector for fresh capture.
            ...(run.sessionId ? { sessionId: run.sessionId } : {}) })).comparison,
        });
        return { ...prepared, reviewInput };
      };
      return await runWithScmExecutionRunAccountScope(run, prepare);
    },
    async failUnstartedRound(reviewRound: ReviewRoundBindingV1): Promise<void> {
      if (!deps.reviewRecords) throw Object.assign(new Error('Review records are unavailable'), { code: 'review_record_unavailable' });
      await deps.reviewRecords.settle({ ...reviewRound, outcome: 'failed', finishedAt: Date.now(), runs: [] });
    },
    async settleRound(run: ExecutionRunState): Promise<void> {
      const input = record(run.intentInput);
      if (run.intent !== 'review' || input?.reviewRoundSettlement !== 'execution') return;
      const binding = ReviewRoundBindingV1Schema.safeParse(input.reviewRound);
      if (!binding.success) return;
      if (!deps.reviewRecords || !deps.scope.workspace) {
        throw Object.assign(new Error('Artifact content is unavailable'), { code: 'artifact_content_unavailable' });
      }
      const evidence = ReviewPublicationEvidenceSchema.parse(record(run.structuredMeta?.payload) ?? record(run.latestToolResult) ?? {});
      const outcome = run.status === 'cancelled' ? 'cancelled'
        : run.status === 'failed' || run.status === 'timeout' ? 'failed' : 'completed';
      await deps.reviewRecords.settle({ ...binding.data,
        outcome,
        reviewerOutcomes: typeof input.reviewReviewerId === 'string' ? [{ key: input.reviewReviewerId, runId: run.runId,
          outcome, reviewOutcome: evidence.reviewOutcome, quality: evidence.quality, materialization: evidence.materialization }] : [],
        finishedAt: run.finishedAtMs ?? Date.now(), summary: run.summary,
        runs: [{ kind: 'execution', runId: run.runId, machineId: deps.scope.workspace.machineId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}) }],
      });
    },
    async materialize(params: Readonly<{
      findings: readonly ReviewFinding[];
      reviewedFingerprint: string | null;
      comparison?: ScmComparison;
      review?: ReviewRoundBindingV1;
      workflowRunId?: string;
      workflowScope?: NonNullable<ReviewCommentPrincipalHeaderV1['workflowScope']>;
    }> & (Readonly<{ run: ExecutionRunState; session?: never }> | Readonly<{ run?: never; session: Readonly<{
      sessionId: string; localInputId: string; workflowRunId: string; stepId: string; invocationId: string;
      agentId: string; reviewerId: string; cwd?: string; intentInput?: unknown;
    }> }>)): Promise<ReviewRunMaterialization> {
      const engineId = params.run ? params.run.backendId : params.session.agentId;
      const producingRunId = params.run ? params.run.runId : params.session.workflowRunId;
      const producingCallId = params.run ? params.run.callId : params.session.localInputId;
      const producingSessionId = params.run ? params.run.sessionId : params.session.sessionId;
      const workflowRunId = params.run ? params.workflowRunId : params.session.workflowRunId;
      const intentInput = params.run ? params.run.intentInput : params.session.intentInput;
      const launchCwd = params.run ? params.run.launch?.cwd : params.session.cwd;
      const runReview = ReviewRoundBindingV1Schema.safeParse(record(intentInput)?.reviewRound);
      const review = params.review ?? (runReview.success ? runReview.data : undefined);
      const comments: Array<ReviewRunMaterialization['comments'][number]> = [];
      const failures: Array<{ findingId: string; errorCode: string }> = [];
      const input = record(intentInput);
      const reviewerId = params.session?.reviewerId ?? (typeof input?.reviewReviewerId === 'string' ? input.reviewReviewerId : review ? null : engineId);
      const cwd = launchCwd ?? deps.cwd;
      const comparison = params.comparison ?? (typeof input?.comparisonId === 'string'
        ? await readCapturedScmComparison({ cwd, comparisonId: input.comparisonId,
          ...(producingSessionId ? { sessionId: producingSessionId } : {}) }).then(captured => captured.comparison, () => null)
        : undefined);
      for (const finding of params.findings) {
        try {
          if (!reviewerId) throw Object.assign(new Error('Review reviewer provenance is unavailable'), { code: 'review_comment_invalid_request' });
          if (!review && !producingSessionId && !workflowRunId) throw Object.assign(new Error('Review scope is unavailable'), { code: 'review_comment_session_unavailable' });
          const scope = deps.scope.workspace && launchCwd
            ? { ...deps.scope, workspace: { ...deps.scope.workspace, path: launchCwd } }
            : deps.scope;
          let anchor = findingAnchor(finding, producingRunId);
          const resolvedSnapshot = await resolveReviewCommentSnapshot({ cwd, anchor, comparison });
          // Preserve the finding and its original location in the Review payload,
          // without inventing a code location when its evidence cannot be verified.
          if (!resolvedSnapshot && 'filePath' in anchor) anchor = { kind: 'finding', runId: producingRunId, findingId: finding.id };
          else if (resolvedSnapshot?.kind === 'text' && resolvedSnapshot.diffContext
            && (anchor.kind === 'line' || anchor.kind === 'range')) anchor = { ...anchor, side: resolvedSnapshot.diffContext.side };
          const snapshot = resolvedSnapshot ?? { kind: 'none' as const, capturedAt: Date.now() };
          const fingerprint: ReviewCommentFingerprintV1 = {
            normalizedMessageHash: createReviewFindingMessageHashV1(finding.summary), engineId,
            ...(finding.startLine ? { lineRange: { startLine: finding.startLine, endLine: finding.endLine ?? finding.startLine } } : {}),
          };
          const findingIdentity = createReviewFindingIdentityV1({ path: finding.filePath, title: finding.title, fingerprint });
          const mutationSource = review
            ? JSON.stringify([review.reviewId, review.roundOrdinal, producingRunId, reviewerId,
              scope.workspace?.machineId ?? null, producingSessionId ?? null,
              ...(params.session ? [params.session.stepId, params.session.invocationId, params.session.localInputId] : []), findingIdentity])
            : `${producingRunId}\0${findingIdentity}`;
          const input: ReviewCommentCreateRequestV1 = {
            ...scope, ...(producingSessionId ? { sessionId: producingSessionId } : {}), runId: producingRunId, engineId, findingId: finding.id,
            findingIdentity, findingSeverity: finding.severity, reviewedFingerprint: params.reviewedFingerprint,
            ...(finding.scopeAttribution === undefined ? {} : { scopeAttribution: finding.scopeAttribution }),
            ...(finding.extensions === undefined ? {} : { extensions: finding.extensions }),
            finding: ReviewFindingContentSchema.parse(finding),
            ...(review ? { reviewId: review.reviewId, appearance: { roundOrdinal: review.roundOrdinal,
              runId: producingRunId, reviewerId,
              ...(scope.workspace ? { machineId: scope.workspace.machineId } : {}),
              ...(producingSessionId ? { sessionId: producingSessionId } : {}) } } : {}),
            anchor, snapshot, body: [finding.title, finding.summary, finding.whyItMatters, finding.evidence, finding.suggestion].filter(Boolean).join('\n\n'),
            authorIntent: record(intentInput)?.reviewCommentAuthorIntent === 'open' ? 'open' : 'propose', fingerprint,
            linkedRefs: [...(params.run ? [{ kind: 'executionRun' as const, id: producingRunId }] : []), ...(producingSessionId ? [{ kind: 'session' as const, id: producingSessionId }] : [])],
            clientMutationId: `review-finding:${createHash('sha256').update(mutationSource).digest('hex')}`,
          };
          const comment = resultComment(await deps.execute('reviews.comments.create', input, {
            principal: {
              ...(params.workflowScope ? { workflowScope: params.workflowScope } : {}),
              actor: workflowRunId
                ? { kind: 'workflow', runId: workflowRunId }
                : producingSessionId ? { kind: 'agent', agentId: engineId, sessionId: producingSessionId }
                  : { kind: 'executionRun', agentId: engineId, runId: producingRunId },
              currentIntent: {
                v: 1, kind: 'review_findings_materialization', actionId: 'reviews.comments.create',
                ...scope, ...(producingSessionId ? { sessionId: producingSessionId } : {}),
                ...(workflowRunId ? { workflowRunId: workflowRunId } : {}),
                runId: producingRunId, callId: producingCallId, agentId: engineId,
                effectBodySha256Base64Url: createHash('sha256').update(stringifyReviewCommentPrincipalCanonicalJsonV1(input)).digest('base64url'),
              },
            },
          }));
          const { id, state, serverRevision, reviewId, projectId, workspace, sessionId, runId } = comment;
          comments.push({ findingId: finding.id, comment: { id, state, serverRevision, ...(reviewId ? { reviewId } : {}), ...(projectId ? { projectId } : {}), ...(workspace ? { workspace } : {}), ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) } });
        } catch (error) {
          failures.push({ findingId: finding.id, errorCode: errorCode(error) });
        }
      }
      return {
        engineId, status: failures.length === 0 ? 'materialized' : comments.length > 0 ? 'partial' : 'failed',
        commentIds: [...new Set(comments.map((entry) => entry.comment.id))], comments, failures,
      };
    },
    async triage(_runId: string, input: unknown, retainedFindings?: readonly ReviewFinding[]): Promise<ExecutionRunActionResult> {
      const parsed = ReviewTriageOverlaySchema.safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'execution_run_invalid_action_input', error: 'Invalid triage overlay' };
      try {
        const actor = deps.resolveTriageActor?.();
        if (!actor) return { ok: false, errorCode: 'review_comment_principal_unavailable', error: 'The Session review principal is unavailable' };
        const options = { principal: { actor } };
        const comments: ReviewCommentV1[] = [];
        for (const finding of parsed.data.findings) {
          const retained = retainedFindings?.find((entry) => entry.id === finding.id);
          const retainedComment = record(retained?.comment);
          const commentId = typeof finding.commentId === 'string' ? finding.commentId
            : typeof retainedComment?.id === 'string' ? retainedComment.id : null;
          if (!commentId) return { ok: false, errorCode: 'review_comment_reference_unavailable', error: 'The finding has no persisted comment reference' };
          const current = resultComment(await deps.execute('reviews.comments.get', { commentId, includeHistory: true }, options));
          const updated = resultComment(await deps.execute('reviews.comments.transition', buildReviewTriageTransitionRequestV1({
            comment: current, decision: finding.status, ...(finding.comment ? { note: finding.comment } : {}),
            clientMutationId: `review-triage:${randomUUID()}`,
          }), options));
          comments.push({ ...updated, findingId: finding.id });
        }
        return { ok: true, result: { triage: projectReviewRunTriage(comments), commentIds: comments.map((comment) => comment.id) } };
      } catch (error) {
        return { ok: false, errorCode: errorCode(error), error: 'Review triage could not be persisted' };
      }
    },
  };
}
